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

import type { Database } from 'bun:sqlite';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import type * as schema from '../db/schema.ts';
import { oracleDocuments } from '../db/schema.ts';
import { isDbLockError } from '../db/errors.ts';

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

    // FTS5 has no unique constraint on id — delete-then-insert to be idempotent.
    sqlite.prepare(`DELETE FROM oracle_fts WHERE id = ?`).run(rows.id);
    sqlite.prepare(`
      INSERT INTO oracle_fts (id, content, concepts)
      VALUES (?, ?, ?)
    `).run(rows.id, rows.markdown, rows.concepts.join(' '));
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
      const fts = sqlite.prepare(`SELECT 1 FROM oracle_fts WHERE id = ?`).get(rows.id);
      if (doc && fts) return 'verified-after-lock-error';
    } catch {
      // reads locked too — fall through to the original error
    }
    throw err;
  }
}
