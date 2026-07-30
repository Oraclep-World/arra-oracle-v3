/**
 * Document storage: SQLite + vector store batching
 */

import { Database } from 'bun:sqlite';
import { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import * as schema from '../db/schema.ts';
import { oracleDocuments } from '../db/schema.ts';
import type { VectorStoreAdapter } from '../vector/types.ts';
import type { OracleDocument } from '../types.ts';
import { ftsUpsert, ftsNeedsWrite, ftsOptimize } from '../db/fts-tables.ts';

/**
 * Store documents in SQLite + vector store
 * Uses Drizzle for type-safe inserts and sets createdBy: 'indexer'
 */
/**
 * Rewrites above this count trigger a segment merge. 500 is well above the
 * handful a normal vault-sync writes, and well below a full reindex.
 */
const FTS_OPTIMIZE_THRESHOLD = 500;

export async function storeDocuments(
  sqlite: Database,
  db: BunSQLiteDatabase<typeof schema>,
  vectorClient: VectorStoreAdapter | null,
  project: string | null,
  documents: OracleDocument[],
  opts: { createdBy?: string } = {}
): Promise<void> {
  const now = Date.now();

  // FTS writes go through ftsUpsert — one writer for both keyword tables
  // (unicode61 + trigram). The delete-then-insert dedupe rationale and the
  // 2026-04-16 drift story live in src/db/fts-tables.ts.

  // How many docs actually needed a re-tokenise. Logged because "reindexed
  // 8,000 docs" and "reindexed 8,000 docs, wrote 2" are wildly different
  // machine loads, and only the second number tells you the guard is working.
  let ftsWritten = 0;

  // Prepare for vector store
  const ids: string[] = [];
  const contents: string[] = [];
  const metadatas: any[] = [];

  // Wrap SQLite inserts in a transaction for performance + atomicity
  sqlite.exec('BEGIN');
  try {
    for (const doc of documents) {
      // SQLite metadata - use doc.project if available, fall back to repo project
      const docProject = (doc.project || project)?.toLowerCase();

      // Drizzle upsert with createdBy: 'indexer'
      db.insert(oracleDocuments)
        .values({
          id: doc.id,
          type: doc.type,
          sourceFile: doc.source_file,
          concepts: JSON.stringify(doc.concepts),
          createdAt: doc.created_at,
          updatedAt: doc.updated_at,
          indexedAt: now,
          project: docProject,
          createdBy: opts.createdBy || 'indexer',
        })
        .onConflictDoUpdate({
          target: oracleDocuments.id,
          set: {
            type: doc.type,
            sourceFile: doc.source_file,
            concepts: JSON.stringify(doc.concepts),
            updatedAt: doc.updated_at,
            indexedAt: now,
            project: docProject,
          }
        })
        .run();

      // SQLite FTS (raw SQL required for FTS5): both keyword tables, idempotent.
      //
      // Ask the fingerprint table (indexed) before touching FTS at all. Every
      // FTS statement keyed by id is a full scan, so the win here is not just
      // skipping the tokenise — it is skipping the lookup that finds the row.
      const conceptsStr = doc.concepts.join(' ');
      if (ftsNeedsWrite(sqlite, doc.id, doc.content, conceptsStr)) {
        ftsUpsert(sqlite, doc.id, doc.content, conceptsStr);
        ftsWritten++;
      }

      // Vector store metadata (must be primitives, not arrays)
      ids.push(doc.id);
      contents.push(doc.content);
      metadatas.push({
        type: doc.type,
        source_file: doc.source_file,
        concepts: doc.concepts.join(',')
      });
    }
    sqlite.exec('COMMIT');
    console.log(`FTS: ${ftsWritten} written, ${documents.length - ftsWritten} unchanged (skipped re-tokenise)`);

    // Merge segments after a write-heavy pass. FTS5 appends a new segment per
    // batch and merges lazily, so a big reindex inflates the file with live-but-
    // fragmented index data that VACUUM cannot reclaim (measured: 97 MB -> 149 MB
    // after one full pass, back to 81 MB after optimize). Gated on volume because
    // it costs ~7s — a 15-minute sync that wrote nothing must not pay for it.
    if (ftsWritten >= FTS_OPTIMIZE_THRESHOLD) {
      const t0 = Date.now();
      ftsOptimize(sqlite);
      console.log(`FTS: optimize after ${ftsWritten} writes (${Date.now() - t0}ms)`);
    }
  } catch (e) {
    sqlite.exec('ROLLBACK');
    throw e;
  }

  // Batch insert to vector store in chunks of 100 (skip if no client)
  if (!vectorClient) {
    console.log('Skipping vector indexing (SQLite-only mode)');
    return;
  }

  const BATCH_SIZE = 100;
  let vectorSuccess = true;

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batchIds = ids.slice(i, i + BATCH_SIZE);
    const batchContents = contents.slice(i, i + BATCH_SIZE);
    const batchMetadatas = metadatas.slice(i, i + BATCH_SIZE);

    try {
      const vectorDocs = batchIds.map((id, idx) => ({
        id,
        document: batchContents[idx],
        metadata: batchMetadatas[idx]
      }));
      await vectorClient.addDocuments(vectorDocs);
      console.log(`Vector batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(ids.length / BATCH_SIZE)} stored`);
    } catch (error) {
      console.error(`Vector batch failed:`, error);
      vectorSuccess = false;
    }
  }

  console.log(`Stored in SQLite${vectorSuccess ? ` + ${vectorClient.name}` : ` (${vectorClient.name} failed)`}`);
}
