/**
 * Oracle v2 Core Request Handlers
 *
 * Partially migrated to Drizzle ORM. FTS5 operations remain as raw SQL
 * since Drizzle doesn't support virtual tables.
 */

import fs from 'fs';
import path from 'path';
import { eq, sql, or } from 'drizzle-orm';
import { db, sqlite, oracleDocuments, indexingStatus, isDbLockError } from '../db/index.ts';
import { REPO_ROOT, VECTOR_URL } from '../config.ts';
import { logSearch, logDocumentAccess, logLearning } from './logging.ts';
import type { SearchResult, SearchResponse } from './types.ts';
import { ensureVectorStoreConnected, EMBEDDING_MODELS, getVectorStoreConfigByModel } from '../vector/factory.ts';
import { localVectorOperations } from './vector-operations.ts';
import { detectProject } from './project-detect.ts';
import { trigramMatchQuery, ftsTokens, joinMatchQuery, pruneDeadTokens, FTS_MAIN } from '../db/fts-tables.ts';
import type { Database } from 'bun:sqlite';
import { coerceConcepts } from '../tools/learn.ts';
import { createVectorProxy } from './vector-proxy.ts';
import { buildLearningMarkdown, dateSlug, learningContentHash, extractContentHash } from '../learn/markdown.ts';
import { writeLearningIndexRows, LearningIndexError, recordOrphanLearning } from '../learn/index-rows.ts';
import { localNativeVectorDisabledReason, localVectorIndexMissingReason, logLocalVectorDisabled } from '../vector/cpu-capabilities.ts';
import { isVectorSectionEnabled } from '../vector/config.ts';

// Module-level proxy instance — bound to VECTOR_URL at boot. If VECTOR_URL is
// unset, this is null and the local vector adapter runs in-process (legacy
// behavior). When set, the vector leg of hybrid/vector search proxies to the
// remote service; on remote failure we fall back to FTS5-only.
const vectorProxy = createVectorProxy(VECTOR_URL);


const FTS_TOKEN_LIMIT = 8;

/**
 * Convert natural-language input into a punctuation-safe FTS5 MATCH query.
 *
 * SQLite FTS5 treats punctuation such as '.', ',', ':' or parentheses as query
 * syntax. Instead of maintaining a brittle blocklist, split on anything that is
 * not part of a word (see ftsTokens — Marks included, which is what makes Thai
 * survive), quote every token, and OR the terms. OR avoids the default
 * implicit-AND behavior that made multi-word recall queries overly strict.
 *
 * Pass `db` to prune tokens that match nothing in `oracle_fts` before the
 * FTS_TOKEN_LIMIT slice, so dead tokens do not spend budget slots. Omitted →
 * pure function, unit testable without a database.
 */
export function buildFtsQuery(query: string, db?: Database): string {
  const unique = Array.from(new Set(ftsTokens(query)));
  const tokens = db
    ? pruneDeadTokens(db, FTS_MAIN, unique, FTS_TOKEN_LIMIT)
    : unique.slice(0, FTS_TOKEN_LIMIT);
  return joinMatchQuery(tokens);
}

function runFtsGet<T>(stmt: { get: (...args: any[]) => T }, args: unknown[]): T | null {
  try {
    return stmt.get(...args);
  } catch (error) {
    console.warn('[FTS5] MATCH query failed; degrading to empty keyword leg:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

function runFtsAll<T>(stmt: { all: (...args: any[]) => T[] }, args: unknown[]): T[] {
  try {
    return stmt.all(...args);
  } catch (error) {
    console.warn('[FTS5] MATCH query failed; degrading to empty keyword leg:', error instanceof Error ? error.message : String(error));
    return [];
  }
}

/**
 * LanceDB is configured for cosine distance, where nearest-neighbor distances
 * are in the 0..2 range: 0 means identical, 2 means opposite. Convert that
 * directly to a bounded relevance score instead of using the old L2 scaling
 * formula, which saturated normal cosine distances around 0.99.
 */
export function cosineDistanceToSimilarity(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  return Math.max(0, Math.min(1, 1 - distance / 2));
}

/**
 * Search Oracle knowledge base with hybrid search (FTS5 + Vector)
 * HTTP server can safely use ChromaMcpClient since it's not an MCP server
 */
export async function handleSearch(
  query: string,
  type: string = 'all',
  limit: number = 10,
  offset: number = 0,
  mode: 'hybrid' | 'fts' | 'vector' = 'hybrid',
  project?: string,  // If set: project + universal. If null/undefined: universal only
  cwd?: string,      // Auto-detect project from cwd if project not specified
  model?: string     // Embedding model: 'bge-m3' (default, multilingual) or 'nomic' (fast)
): Promise<SearchResponse & { mode?: string; warning?: string; model?: string; vectorAvailable?: boolean }> {
  // Auto-detect project from cwd if not explicitly specified
  const resolvedProject = (project ?? detectProject(cwd))?.toLowerCase() ?? null;
  const startTime = Date.now();
  const ftsQuery = buildFtsQuery(query, sqlite);
  if (!ftsQuery) {
    return { results: [], total: 0, limit, offset, query };
  }

  let warning: string | undefined;
  const requestedMode = mode;
  let effectiveMode = mode;
  let vectorDisabledReason: string | undefined;
  let vectorIndexMissingReason: string | undefined;
  let vectorSectionDisabled = false;
  if (mode !== 'fts' && !vectorProxy) {
    const modelsToCheck = model === 'multi' ? ['bge-m3', 'nomic'] : [model];
    for (const modelKey of modelsToCheck) {
      const cfg = getVectorStoreConfigByModel(modelKey);
      vectorDisabledReason = localNativeVectorDisabledReason(cfg.type);
      if (vectorDisabledReason) break;
      vectorIndexMissingReason = localVectorIndexMissingReason(cfg);
      if (vectorIndexMissingReason) break;
    }
    // Every branch that silently downgrades to FTS must say so in `warning`.
    //
    // Measured cost of not doing this, 2026-07-31: someone set
    // vector-server.json `enabled: false` at 13:59. Search kept answering —
    // same shape, plausible results — and nobody noticed until 15:07. For 68
    // minutes every oracle in the fleet searched keyword-only while believing
    // it had hybrid, and finding out took reading a cron log, because the
    // response carried `vectorAvailable: false` with no reason attached.
    // The field for the reason already existed and was left empty.
    //
    // Each message names what to change, not just what happened — a caller
    // reading it should not need to open this file to act on it.
    if (vectorDisabledReason) {
      effectiveMode = 'fts';
      warning = `${vectorDisabledReason}; falling back to FTS5-only results`;
      logLocalVectorDisabled(vectorDisabledReason);
    } else if (!isVectorSectionEnabled()) {
      vectorSectionDisabled = true;
      effectiveMode = 'fts';
      warning = 'Vector section is disabled — FTS5-only results. '
        + 'Set "enabled": true in vector-server.json (in ORACLE_DATA_DIR) '
        + 'or ORACLE_VECTOR_ENABLED=1, then restart.';
    } else if (vectorIndexMissingReason) {
      effectiveMode = 'fts';
      warning = `${vectorIndexMissingReason}; falling back to FTS5-only results. `
        + 'Run the vector reindex to build it.';
    }
  }

  // FTS5 search (skip only when the effective mode is vector-only)
  let ftsResults: SearchResult[] = [];
  let ftsTotal = 0;

  // Project filter: if project specified, include project + universal (NULL)
  // If no project, return ALL documents (no filter)
  const projectFilter = resolvedProject
    ? '(d.project = ? OR d.project IS NULL)'
    : '1=1';
  const projectParams = resolvedProject ? [resolvedProject] : [];

  // FTS5 search must use raw SQL (Drizzle doesn't support virtual tables).
  //
  // Two keyword tables, both queried, merged by id (see src/db/fts-tables.ts):
  //   oracle_fts (unicode61) — only table that serves tokens < 3 chars (PQ, jq)
  //   oracle_fts_tri (trigram) — Thai recall 26% → 100% on real logged queries.
  // This HTTP path is where real traffic flows (MCP proxies here), so the
  // trigram leg matters most in this file.
  if (effectiveMode !== 'vector') {
    const typeCond = type === 'all' ? '' : 'AND d.type = ?';
    const typeParams = type === 'all' ? [] : [type];

    const keywordLeg = (table: string, match: string): { rows: any[]; total: number } => {
      const countStmt = sqlite.prepare(`
        SELECT COUNT(*) as total
        FROM ${table} f
        JOIN oracle_documents d ON f.id = d.id
        WHERE ${table} MATCH ? ${typeCond} AND ${projectFilter}
      `);
      const total = (runFtsGet(countStmt, [match, ...typeParams, ...projectParams]) as { total: number } | null)?.total ?? 0;

      const stmt = sqlite.prepare(`
        SELECT f.id, f.content, d.type, d.source_file, d.concepts, d.project, rank as score
        FROM ${table} f
        JOIN oracle_documents d ON f.id = d.id
        WHERE ${table} MATCH ? ${typeCond} AND ${projectFilter}
        ORDER BY rank
        LIMIT ?
      `);
      const rows = runFtsAll<any>(stmt, [match, ...typeParams, ...projectParams, limit * 3]);
      return { rows, total };
    };

    const main = keywordLeg('oracle_fts', ftsQuery);
    let mergedRows = main.rows;
    ftsTotal = main.total;

    const triQuery = trigramMatchQuery(query, sqlite);
    if (triQuery) {
      // runFtsAll/runFtsGet already degrade to empty-with-a-warn, so a broken
      // trigram table cannot take down the main leg — but it does log loudly.
      const tri = keywordLeg('oracle_fts_tri', triQuery);
      // Merge by id keeping the better (lower) raw rank. bm25 scales differ
      // slightly across tokenizers; good enough to interleave candidates that
      // the downstream reranker re-orders anyway.
      const byId = new Map<string, any>();
      for (const row of main.rows) byId.set(row.id, row);
      for (const row of tri.rows) {
        const seen = byId.get(row.id);
        if (!seen || row.score < seen.score) byId.set(row.id, row);
      }
      mergedRows = [...byId.values()].sort((a, b) => a.score - b.score).slice(0, limit * 3);
      // Union total without a dedupe query: max() is a true lower bound and
      // never overcounts. Exact union COUNT would couple the two tables'
      // failure modes in one statement for a number that is informational.
      ftsTotal = Math.max(main.total, tri.total);
    }

    ftsResults = mergedRows.map((row: any) => ({
      id: row.id,
      type: row.type,
      content: row.content,
      source_file: row.source_file,
      concepts: JSON.parse(row.concepts || '[]'),
      project: row.project,
      source: 'fts' as const,
      score: normalizeRank(row.score)
    }));
  }

  // Vector search (skip if fts-only mode)
  let vectorResults: SearchResult[] = [];
  let remoteVectorTotal: number | undefined;
  // Tracks whether the vector leg succeeded. Stays `true` when mode === 'fts'
  // (vector wasn't asked for), flips to `false` if the proxy is enabled and
  // the remote call failed — clients use this to render a "vector down" hint
  // while still getting FTS5 results.
  let vectorAvailable = !vectorSectionDisabled && !vectorDisabledReason && !vectorIndexMissingReason;

  // VECTOR_URL set → route the vector leg through the remote service.
  // FTS5 always runs locally above. If the proxy fails we return whatever FTS5
  // produced and set vectorAvailable: false (per VECTOR_FALLBACK = 'fts5').
  if (effectiveMode !== 'fts' && vectorProxy) {
    const remote = await vectorProxy.search({
      q: query,
      type,
      limit,
      offset,
      mode: 'vector',
      project: resolvedProject ?? undefined,
      cwd,
      model,
    });
    if (remote) {
      vectorResults = remote.results || [];
      if (typeof remote.total === 'number') remoteVectorTotal = remote.total;
    } else {
      vectorAvailable = false;
      warning = 'Vector proxy unavailable — FTS5-only results';
    }
  } else if (effectiveMode !== 'fts') {
    try {
      const vector = await localVectorOperations.search({
        query,
        type,
        limit,
        project: resolvedProject,
        model,
      });
      vectorResults = vector.results;
      if (vectorResults.length > 0) {
        console.log(`[Vector] ${vectorResults.length} results, top scores: ${vectorResults.slice(0, 3).map(r => r.score?.toFixed(3))}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[Vector Search Error]', msg);
      if (!warning) warning = `Vector search error: ${msg}`;
    }
  }

  // Combine results using hybrid ranking
  const combined = combineSearchResults(ftsResults, vectorResults);
  // For vector-only mode, ftsTotal is 0 and combined.length is just top-N,
  // so use the vector collection count as the total for accurate display
  let total = Math.max(ftsTotal, combined.length);
  if (requestedMode === 'vector' && vectorProxy && remoteVectorTotal !== undefined) {
    total = remoteVectorTotal;
  } else if (requestedMode === 'vector' && vectorResults.length > 0) {
    try {
      const client = await ensureVectorStoreConnected(model && EMBEDDING_MODELS[model] ? model : undefined);
      const stats = await client.getStats();
      if (stats.count > 0) total = stats.count;
    } catch (error) {
      console.warn('[Hybrid] getStats for vector-only total failed:', error instanceof Error ? error.message : String(error));
    }
  }

  // Apply pagination
  const results = combined.slice(offset, offset + limit);

  // Log search
  const searchTime = Date.now() - startTime;
  logSearch(query, type, requestedMode, total, searchTime, results);
  results.forEach(r => logDocumentAccess(r.id, 'search'));

  return {
    results,
    total,
    offset,
    limit,
    mode: requestedMode,
    ...(model === 'multi' ? { model: 'multi' } : model && EMBEDDING_MODELS[model] ? { model } : {}),
    ...(requestedMode !== 'fts' ? { vectorAvailable } : {}),
    ...(warning && { warning })
  };
}

/**
 * Normalize FTS5 rank score to 0-1 range (higher = better)
 */
function normalizeRank(rank: number): number {
  // FTS5 rank is negative (more negative = better match)
  // Convert to positive 0-1 score
  return Math.min(1, Math.max(0, 1 / (1 + Math.abs(rank))));
}

/**
 * Combine FTS and vector results with rank-fusion hybrid scoring.
 *
 * Raw FTS rank and vector similarity are not calibrated to the same scale. Use
 * each leg's normalized score plus reciprocal rank, then boost overlap. This
 * keeps strong keyword-only hits visible while still letting semantic-only
 * vector hits fill gaps in natural-language recall.
 */
function combineSearchResults(fts: SearchResult[], vector: SearchResult[]): SearchResult[] {
  const seen = new Map<string, SearchResult>();

  const addScore = (base: number | undefined, rank: number, scoreWeight: number, rankWeight: number) => {
    const score = Math.max(0, Math.min(1, base ?? 0));
    return score * scoreWeight + (1 / (rank + 1)) * rankWeight;
  };

  fts.forEach((r, index) => {
    seen.set(r.id, {
      ...r,
      score: addScore(r.score, index, 0.7, 0.3),
    });
  });

  vector.forEach((r, index) => {
    const vectorScore = addScore(r.score, index, 0.65, 0.35);
    const existing = seen.get(r.id);
    if (existing) {
      seen.set(r.id, {
        ...existing,
        score: Math.min(1, (existing.score || 0) + vectorScore + 0.12),
        source: 'hybrid' as const,
        distance: r.distance,
        model: r.model,
      });
    } else {
      seen.set(r.id, {
        ...r,
        score: vectorScore,
      });
    }
  });

  return Array.from(seen.values()).sort((a, b) => (b.score || 0) - (a.score || 0));
}

/**
 * Get random wisdom
 */
export function handleReflect() {
  try {
    // Get random document using Drizzle
    const randomDoc = db.select({
      id: oracleDocuments.id,
      type: oracleDocuments.type,
      sourceFile: oracleDocuments.sourceFile,
      concepts: oracleDocuments.concepts
    })
      .from(oracleDocuments)
      .where(or(
        eq(oracleDocuments.type, 'principle'),
        eq(oracleDocuments.type, 'learning')
      ))
      .orderBy(sql`RANDOM()`)
      .limit(1)
      .get();

    if (!randomDoc) {
      return { error: 'No documents found' };
    }

    // Get content from FTS (must use raw SQL)
    const content = sqlite.prepare(`
      SELECT content FROM oracle_fts WHERE id = ?
    `).get(randomDoc.id) as { content: string } | undefined;

    if (!content) {
      return { error: 'Document content not found in FTS index' };
    }

    return {
      id: randomDoc.id,
      type: randomDoc.type,
      content: content.content,
      source_file: randomDoc.sourceFile,
      concepts: JSON.parse(randomDoc.concepts || '[]')
    };
  } catch (err) {
    if (isDbLockError(err)) {
      return {
        id: null,
        type: 'principle',
        content: 'Oracle is indexing — please wait...',
        source_file: null,
        concepts: [],
        indexing: true,
      };
    }
    throw err;
  }
}

/**
 * List all documents (browse without search)
 * @param groupByFile - if true, dedupe by source_file (show one entry per file)
 *
 * Note: Uses raw SQL for FTS JOIN since Drizzle doesn't support virtual tables.
 * Count queries use Drizzle where possible.
 */
export function handleList(type: string = 'all', limit: number = 10, offset: number = 0, groupByFile: boolean = true): SearchResponse {
  // Validate
  if (limit < 1 || limit > 100) limit = 10;
  if (offset < 0) offset = 0;

  if (groupByFile) {
    // Group by source_file to avoid duplicate entries from same file
    if (type === 'all') {
      // Count distinct files using Drizzle
      const countResult = db.select({ total: sql<number>`count(distinct ${oracleDocuments.sourceFile})` })
        .from(oracleDocuments)
        .get();
      const total = countResult?.total || 0;

      // Need raw SQL for FTS JOIN with GROUP BY
      const stmt = sqlite.prepare(`
        SELECT d.id, d.type, d.source_file, d.concepts, d.project, MAX(d.indexed_at) as indexed_at, f.content
        FROM oracle_documents d
        JOIN oracle_fts f ON d.id = f.id
        GROUP BY d.source_file
        ORDER BY indexed_at DESC
        LIMIT ? OFFSET ?
      `);
      const results = stmt.all(limit, offset).map((row: any) => ({
        id: row.id,
        type: row.type,
        content: row.content || '',
        source_file: row.source_file,
        concepts: row.concepts ? JSON.parse(row.concepts) : [],
        project: row.project,
        indexed_at: row.indexed_at
      }));

      return { results, total, offset, limit };
    } else {
      // Count distinct files for type using Drizzle
      const countResult = db.select({ total: sql<number>`count(distinct ${oracleDocuments.sourceFile})` })
        .from(oracleDocuments)
        .where(eq(oracleDocuments.type, type))
        .get();
      const total = countResult?.total || 0;

      // Need raw SQL for FTS JOIN with GROUP BY
      const stmt = sqlite.prepare(`
        SELECT d.id, d.type, d.source_file, d.concepts, d.project, MAX(d.indexed_at) as indexed_at, f.content
        FROM oracle_documents d
        JOIN oracle_fts f ON d.id = f.id
        WHERE d.type = ?
        GROUP BY d.source_file
        ORDER BY indexed_at DESC
        LIMIT ? OFFSET ?
      `);
      const results = stmt.all(type, limit, offset).map((row: any) => ({
        id: row.id,
        type: row.type,
        content: row.content || '',
        source_file: row.source_file,
        concepts: JSON.parse(row.concepts || '[]'),
        project: row.project,
        indexed_at: row.indexed_at
      }));

      return { results, total, offset, limit };
    }
  }

  // Original behavior without grouping
  if (type === 'all') {
    // Count using Drizzle
    const countResult = db.select({ total: sql<number>`count(*)` })
      .from(oracleDocuments)
      .get();
    const total = countResult?.total || 0;

    // Need raw SQL for FTS JOIN
    const stmt = sqlite.prepare(`
      SELECT d.id, d.type, d.source_file, d.concepts, d.project, d.indexed_at, f.content
      FROM oracle_documents d
      JOIN oracle_fts f ON d.id = f.id
      ORDER BY d.indexed_at DESC
      LIMIT ? OFFSET ?
    `);
    const results = stmt.all(limit, offset).map((row: any) => ({
      id: row.id,
      type: row.type,
      content: row.content || '',
      source_file: row.source_file,
      concepts: row.concepts ? JSON.parse(row.concepts) : [],
      project: row.project,
      indexed_at: row.indexed_at
    }));

    return { results, total, offset, limit };
  } else {
    // Count using Drizzle
    const countResult = db.select({ total: sql<number>`count(*)` })
      .from(oracleDocuments)
      .where(eq(oracleDocuments.type, type))
      .get();
    const total = countResult?.total || 0;

    // Need raw SQL for FTS JOIN
    const stmt = sqlite.prepare(`
      SELECT d.id, d.type, d.source_file, d.concepts, d.project, d.indexed_at, f.content
      FROM oracle_documents d
      JOIN oracle_fts f ON d.id = f.id
      WHERE d.type = ?
      ORDER BY d.indexed_at DESC
      LIMIT ? OFFSET ?
    `);
    const results = stmt.all(type, limit, offset).map((row: any) => ({
      id: row.id,
      type: row.type,
      content: row.content,
      source_file: row.source_file,
      concepts: JSON.parse(row.concepts || '[]'),
      project: row.project,
      indexed_at: row.indexed_at
    }));

    return { results, total, offset, limit };
  }
}

/**
 * Get database statistics
 */
export function handleStats(dbPath: string) {
  // Total documents using Drizzle
  const totalDocsResult = db.select({ count: sql<number>`count(*)` })
    .from(oracleDocuments)
    .get();
  const totalDocs = totalDocsResult?.count || 0;

  // Count by type using Drizzle
  const byTypeResults = db.select({
    type: oracleDocuments.type,
    count: sql<number>`count(*)`
  })
    .from(oracleDocuments)
    .groupBy(oracleDocuments.type)
    .all();

  // Get last indexed timestamp using Drizzle
  const lastIndexedResult = db.select({ lastIndexed: sql<number | null>`max(${oracleDocuments.indexedAt})` })
    .from(oracleDocuments)
    .get();

  const lastIndexedDate = lastIndexedResult?.lastIndexed
    ? new Date(lastIndexedResult.lastIndexed).toISOString()
    : null;

  // Calculate age in hours
  const indexAgeHours = lastIndexedResult?.lastIndexed
    ? (Date.now() - lastIndexedResult.lastIndexed) / (1000 * 60 * 60)
    : null;

  // Get indexing status using Drizzle
  let idxStatus = { is_indexing: false, progress_current: 0, progress_total: 0, completed_at: null as number | null };
  try {
    const status = db.select({
      isIndexing: indexingStatus.isIndexing,
      progressCurrent: indexingStatus.progressCurrent,
      progressTotal: indexingStatus.progressTotal,
      completedAt: indexingStatus.completedAt
    })
      .from(indexingStatus)
      .where(eq(indexingStatus.id, 1))
      .get();

    if (status) {
      idxStatus = {
        is_indexing: status.isIndexing === 1,
        progress_current: status.progressCurrent || 0,
        progress_total: status.progressTotal || 0,
        completed_at: status.completedAt
      };
    }
  } catch (e) {
    // Table doesn't exist yet, use defaults
  }

  // Unique files by type (deduped by source_file)
  const uniqueByType = db.select({
    type: oracleDocuments.type,
    count: sql<number>`count(DISTINCT ${oracleDocuments.sourceFile})`
  })
    .from(oracleDocuments)
    .groupBy(oracleDocuments.type)
    .all();

  return {
    total: totalDocs,
    by_type: byTypeResults.reduce((acc, row) => ({ ...acc, [row.type]: row.count }), {}),
    by_type_files: uniqueByType.reduce((acc, row) => ({ ...acc, [row.type]: row.count }), {}),
    last_indexed: lastIndexedDate,
    index_age_hours: indexAgeHours ? Math.round(indexAgeHours * 10) / 10 : null,
    is_stale: indexAgeHours ? indexAgeHours > 24 : true,
    is_indexing: idxStatus.is_indexing,
    indexing_progress: idxStatus.is_indexing ? {
      current: idxStatus.progress_current,
      total: idxStatus.progress_total,
      percent: idxStatus.progress_total > 0
        ? Math.round((idxStatus.progress_current / idxStatus.progress_total) * 100)
        : 0
    } : null,
    indexing_completed_at: idxStatus.completed_at,
    database: dbPath
  };
}

/**
 * Get knowledge graph data
 * Accepts `limit` per type (default 200, max 500).
 * Links capped at 5000 (frontend caps at 3000 anyway).
 */
export function handleGraph(limitPerType = 310) {
  const perType = Math.min(Math.max(limitPerType, 10), 500);

  const selectFields = {
    id: oracleDocuments.id,
    type: oracleDocuments.type,
    sourceFile: oracleDocuments.sourceFile,
    concepts: oracleDocuments.concepts,
    project: oracleDocuments.project
  };

  // Get random sample from each type
  const principles = db.select(selectFields)
    .from(oracleDocuments)
    .where(eq(oracleDocuments.type, 'principle'))
    .orderBy(sql`RANDOM()`)
    .limit(perType)
    .all();

  const learnings = db.select(selectFields)
    .from(oracleDocuments)
    .where(eq(oracleDocuments.type, 'learning'))
    .orderBy(sql`RANDOM()`)
    .limit(perType)
    .all();

  const retros = db.select(selectFields)
    .from(oracleDocuments)
    .where(eq(oracleDocuments.type, 'retro'))
    .orderBy(sql`RANDOM()`)
    .limit(perType)
    .all();

  const docs = [...principles, ...learnings, ...retros];

  // Build nodes
  const nodes = docs.map(doc => ({
    id: doc.id,
    type: doc.type,
    source_file: doc.sourceFile,
    project: doc.project,
    concepts: JSON.parse(doc.concepts || '[]')
  }));

  // Build links based on shared concepts (require 2+ shared for stronger connections)
  const links: { source: string; target: string; weight: number }[] = [];
  const MAX_LINKS = 5000;

  // Pre-compute concept sets
  const conceptSets = nodes.map(n => new Set(n.concepts));

  for (let i = 0; i < nodes.length && links.length < MAX_LINKS; i++) {
    for (let j = i + 1; j < nodes.length && links.length < MAX_LINKS; j++) {
      const sharedCount = nodes[j].concepts.filter((c: string) => conceptSets[i].has(c)).length;

      if (sharedCount >= 1) {
        links.push({
          source: nodes[i].id,
          target: nodes[j].id,
          weight: sharedCount
        });
      }
    }
  }

  return { nodes, links };
}


/**
 * Add new pattern/learning to knowledge base
 * @param origin - 'mother' | 'arthur' | 'volt' | 'human' (null = universal)
 * @param project - ghq-style project path (null = universal)
 * @param cwd - Auto-detect project from cwd if project not specified
 */
/**
 * Persist a learning-type document: write .md file, insert row in oracle_documents + FTS.
 * Shared by handleLearn and handleSessionSummary so both take the same path post-#867.
 */
export function persistLearningDoc(opts: {
  pattern: string;
  subdir: string;          // e.g. 'ψ/memory/learnings' or 'ψ/memory/session-summaries'
  filename: string;        // base filename, e.g. '2026-04-19_my-slug.md' or '<session-id>.md'
  id: string;              // document id
  concepts?: string[];
  source?: string;         // display + logging
  origin?: string | null;  // 'mother' | 'arthur' | 'volt' | 'human' | null
  project?: string | null;
  createdBy?: string;      // oracle_documents.created_by
  footer?: string;         // footer line under the content, e.g. '*Added via Oracle Learn*'
}): { file: string; id: string; deduped?: boolean } {
  const { pattern, subdir, filename, id } = opts;
  const now = new Date();

  const dir = path.join(REPO_ROOT, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);

  const conceptsList = coerceConcepts(opts.concepts);
  const contentHash = learningContentHash(pattern);

  // Idempotent retry (bug reported by ora101, 2026-07-29): a previous call can
  // die with "database is locked" AFTER the file landed but before the index
  // rows committed. Identical content hash → repair the index rows below and
  // succeed instead of failing (failing here is what minted duplicate letters).
  let frontmatter: string;
  let deduped = false;
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8');
    if (extractContentHash(existing) !== contentHash) {
      throw new Error(`File already exists: ${filename}`);
    }
    frontmatter = existing;
    deduped = true;
  } else {
    const title = pattern.split('\n')[0].substring(0, 80);
    frontmatter = buildLearningMarkdown({
      id,
      pattern,
      title,
      concepts: conceptsList,
      createdAt: now,
      source: opts.source,
      project: opts.project,
      footer: opts.footer,
    });
    fs.writeFileSync(filePath, frontmatter, 'utf-8');
  }

  const sourceFile = `${subdir}/${filename}`;

  // documents row + FTS row in one transaction; verify-after-error on locks.
  // The file is already on disk at this point, so a failure here means "written
  // but unindexed" — log it to the orphan ledger and throw a typed error the
  // HTTP layer can turn into actionable advice instead of a bare 500.
  try {
    writeLearningIndexRows(sqlite, db, {
      id,
      sourceFile,
      markdown: frontmatter,
      concepts: conceptsList,
      project: opts.project ?? null,
      origin: opts.origin ?? null,
      createdBy: opts.createdBy || 'oracle_learn',
      now,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    recordOrphanLearning(sourceFile, id, detail);
    throw new LearningIndexError(sourceFile, id, err);
  }

  logLearning(id, pattern, opts.source || 'Oracle Learn', conceptsList);

  return { file: sourceFile, id, ...(deduped && { deduped: true }) };
}

export function handleLearn(
  pattern: string,
  source?: string,
  concepts?: string[],
  origin?: string,
  project?: string,
  cwd?: string
) {
  const resolvedProject = (project ?? detectProject(cwd))?.toLowerCase() ?? null;
  const d = new Date();
  const dateStr = dateSlug(d);

  const slug = pattern
    .substring(0, 50)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  // On slug collision (same date + same first-50-char prefix), append -2, -3, …
  // until unique. Prevents 500s when two writes share a slug within one day
  // (e.g. repeated hot-write snapshots from the same agent).
  // EXCEPTION: if a colliding file holds this exact content (same hash), this
  // is a retry of a write whose failure was cosmetic — suffixing it is
  // precisely how duplicate letters were minted. Reuse the existing filename
  // so persistLearningDoc takes its idempotent repair path instead.
  const subdir = 'ψ/memory/learnings';
  const learningsDir = path.join(REPO_ROOT, subdir);
  const contentHash = learningContentHash(pattern);
  let uniqueSlug = slug;
  let suffix = 2;
  while (fs.existsSync(path.join(learningsDir, `${dateStr}_${uniqueSlug}.md`))) {
    const existing = fs.readFileSync(path.join(learningsDir, `${dateStr}_${uniqueSlug}.md`), 'utf-8');
    if (extractContentHash(existing) === contentHash) break;
    uniqueSlug = `${slug}-${suffix}`;
    suffix++;
  }

  const { file, id, deduped } = persistLearningDoc({
    pattern,
    subdir,
    filename: `${dateStr}_${uniqueSlug}.md`,
    id: `learning_${dateStr}_${uniqueSlug}`,
    concepts,
    source,
    origin,
    project: resolvedProject,
    createdBy: 'oracle_learn',
  });

  return { success: true, file, id, ...(deduped && { deduped: true }) };
}

/**
 * Persist a session summary as a learning with concepts
 * ["session-summary", "session-<id>", "oracle-<name>"].
 * Written to ψ/memory/session-summaries/<session-id>.md so `oracle_search` surfaces it.
 */
export function handleSessionSummary(
  sessionId: string,
  summary: string,
  oracle?: string
): { ok: true; source_file: string; learning_id: string } {
  const safeSession = sessionId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120);
  if (!safeSession) throw new Error('Invalid session id');

  const concepts = ['session-summary', `session-${safeSession}`];
  if (oracle) {
    const safeOracle = oracle.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80);
    if (safeOracle) concepts.push(`oracle-${safeOracle}`);
  }

  const { file, id } = persistLearningDoc({
    pattern: summary,
    subdir: 'ψ/memory/session-summaries',
    filename: `${safeSession}.md`,
    id: `session-summary_${safeSession}`,
    concepts,
    source: oracle ? `session-summary from ${oracle}` : 'session-summary',
    createdBy: 'session_summary',
    footer: '*Added via session auto-summary*',
  });

  return { ok: true, source_file: file, learning_id: id };
}
