/**
 * Shared index-row writer for learning documents.
 *
 * Both learn paths (MCP tool src/tools/learn.ts and HTTP persistLearningDoc
 * in src/server/handlers.ts) write the same two rows: oracle_documents +
 * oracle_fts. Before this module each site ran them as separate autocommit
 * statements, so "database is locked" could land BETWEEN them — the file and
 * half the rows persisted while the caller was told the write failed.
 * Retrying then minted duplicate letters (reported by ora101, 2026-07-29).
 *
 * Contract:
 *   - documents row + FTS row commit in ONE transaction (all-or-nothing)
 *   - upsert semantics: safe to call again for the same id (idempotent retry)
 *   - on a lock error, verify before failing: if the rows are actually there
 *     (competing writer / ambiguous commit), report success instead
 */

import fs from 'fs';
import path from 'path';
import type { Database } from 'bun:sqlite';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import type * as schema from '../db/schema.ts';
import { oracleDocuments } from '../db/schema.ts';
import { isDbLockError } from '../db/errors.ts';
import { ftsUpsert, ftsHasBoth } from '../db/fts-tables.ts';
import { ORACLE_DATA_DIR } from '../config.ts';

/**
 * Thrown when the markdown file landed but its index rows did not.
 *
 * Carries enough context for the caller to tell the user something useful:
 * the learning is NOT lost, and retrying the same text repairs it. Without
 * this, callers only saw "database is locked" and reasonably assumed the write
 * had failed — which is how duplicate letters were born (and, when they gave
 * up instead, how a file ended up on disk that no search could ever find).
 */
export class LearningIndexError extends Error {
  readonly fileWritten = true;
  constructor(
    readonly sourceFile: string,
    readonly docId: string,
    readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'LearningIndexError';
  }
}

/** Append-only ledger of learnings whose file exists but whose index rows do not. */
export const ORPHAN_LEDGER = path.join(ORACLE_DATA_DIR, 'learn-orphans.jsonl');

/**
 * Record an orphaned learning so "the file exists but nothing indexed it" stops
 * being invisible.
 *
 * Found 2026-07-30 (ora101, hitting a real "database is locked" in the field):
 * on that path the file is written and the index rows are not, and NOTHING comes
 * back for it later — there is no cron that runs the FTS reindex, and the vector
 * cron embeds *from sqlite*, so a row missing from sqlite is missing from vectors
 * too. Same shape as the silent vector skip fixed earlier the same night: the
 * system knew, and said nothing anybody could act on.
 *
 * Never throws: diagnostics must not add a second failure on top of the first.
 */
export function recordOrphanLearning(sourceFile: string, docId: string, detail: string): void {
  try {
    fs.mkdirSync(ORACLE_DATA_DIR, { recursive: true });
    fs.appendFileSync(
      ORPHAN_LEDGER,
      JSON.stringify({ sourceFile, docId, detail: detail.slice(0, 300), at: Date.now() }) + '\n',
      'utf-8',
    );
  } catch {
    /* diagnostics only */
  }
}

export interface LearningIndexRows {
  id: string;
  sourceFile: string;
  markdown: string;
  concepts: string[];
  project?: string | null;
  origin?: string | null;
  createdBy?: string;
  now: Date;
}

export type IndexRowsOutcome = 'committed' | 'verified-after-lock-error';

/**
 * Write both index rows transactionally. Throws the original error only when
 * the rows are verifiably absent — meaning a retry with the SAME content is
 * required (and safe: everything here is upsert / delete-then-insert).
 */
export function writeLearningIndexRows(
  sqlite: Database,
  db: BunSQLiteDatabase<typeof schema>,
  rows: LearningIndexRows,
): IndexRowsOutcome {
  const ts = rows.now.getTime();
  const conceptsJson = JSON.stringify(rows.concepts);

  const tx = sqlite.transaction(() => {
    db.insert(oracleDocuments).values({
      id: rows.id,
      type: 'learning',
      sourceFile: rows.sourceFile,
      concepts: conceptsJson,
      createdAt: ts,
      updatedAt: ts,
      indexedAt: ts,
      origin: rows.origin ?? null,
      project: rows.project ?? null,
      createdBy: rows.createdBy ?? 'oracle_learn',
    }).onConflictDoUpdate({
      target: oracleDocuments.id,
      set: {
        sourceFile: rows.sourceFile,
        concepts: conceptsJson,
        updatedAt: ts,
        indexedAt: ts,
        project: rows.project ?? null,
      },
    }).run();

    // Both keyword tables, idempotent — see src/db/fts-tables.ts.
    ftsUpsert(sqlite, rows.id, rows.markdown, rows.concepts.join(' '));
  });

  try {
    tx();
    return 'committed';
  } catch (err) {
    if (!isDbLockError(err)) throw err;
    // Verify-after-error: SQLITE_BUSY can also surface when another writer
    // already committed our rows. Only fail when they are truly absent.
    try {
      const doc = sqlite.prepare(`SELECT 1 FROM oracle_documents WHERE id = ?`).get(rows.id);
      // "committed" must mean committed to BOTH keyword tables — verifying only
      // one would bless a half-write and let the indexes drift silently.
      if (doc && ftsHasBoth(sqlite, rows.id)) return 'verified-after-lock-error';
    } catch {
      // reads locked too — fall through to the original error
    }
    throw err;
  }
}
