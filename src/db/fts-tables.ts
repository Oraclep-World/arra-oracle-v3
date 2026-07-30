/**
 * FTS tables — one writer for both keyword indexes.
 *
 * Why two tables (measured 2026-07-30 on the real corpus, 7,963 docs, 93% Thai):
 *
 *   `oracle_fts`     tokenize='porter unicode61' — splits on whitespace. Thai has
 *                    no whitespace, so Thai recall on real logged queries was 26%
 *                    (888/3,413 docs found). But it is the ONLY table that can
 *                    match short tokens: "PQ" (1,484 docs), "jq", "x".
 *   `oracle_fts_tri` tokenize='trigram' — every 3-char window. Thai recall 100%
 *                    on the same queries, English precision better than porter
 *                    (no stemming over-match), but tokens < 3 chars match nothing.
 *
 * Neither wins alone → keep both, search merges. Costs measured before deciding:
 * build 2.1s, +29 MB, +0.12 ms per query. History: the trigram fix was written
 * up in tinky's vault on Jul 3 and sat unused for 3 weeks — partly because the
 * 77% Thai drop hid the very note describing it.
 *
 * Every write path MUST go through the helpers here. The last drift
 * (2026-04-16: 1,268 FTS rows for 141 unique ids) happened precisely because
 * each writer hand-rolled its own SQL.
 */
import type { Database } from 'bun:sqlite';

export const FTS_MAIN = 'oracle_fts';
export const FTS_TRI = 'oracle_fts_tri';

/**
 * Create both FTS tables (idempotent) and backfill the trigram table from the
 * main one when it is empty — first boot after this feature, or a manual drop.
 * Backfill measured at ~2s for the full corpus, acceptable at startup.
 */
export function initFtsTables(sqlite: Database): void {
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_MAIN} USING fts5(
      id UNINDEXED,
      content,
      concepts,
      tokenize='porter unicode61'
    )
  `);
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TRI} USING fts5(
      id UNINDEXED,
      content,
      concepts,
      tokenize='trigram'
    )
  `);

  const mainCount = (sqlite.prepare(`SELECT count(*) n FROM ${FTS_MAIN}`).get() as { n: number }).n;
  const triCount = (sqlite.prepare(`SELECT count(*) n FROM ${FTS_TRI}`).get() as { n: number }).n;
  if (triCount === 0 && mainCount > 0) {
    const t0 = Date.now();
    sqlite.exec(`
      INSERT INTO ${FTS_TRI} (id, content, concepts)
      SELECT id, content, concepts FROM ${FTS_MAIN}
    `);
    console.error(`[fts] backfilled ${FTS_TRI} with ${mainCount} docs in ${Date.now() - t0}ms`);
  }
}

/**
 * Idempotent upsert into both tables.
 *
 * Delete-then-insert because FTS5 puts no UNIQUE constraint on an UNINDEXED
 * column — INSERT OR REPLACE silently accumulates duplicates across reindex
 * runs (the 2026-04-16 drift).
 */
export function ftsUpsert(sqlite: Database, id: string, content: string, concepts: string): void {
  sqlite.prepare(`DELETE FROM ${FTS_MAIN} WHERE id = ?`).run(id);
  sqlite.prepare(`INSERT INTO ${FTS_MAIN} (id, content, concepts) VALUES (?, ?, ?)`).run(id, content, concepts);
  sqlite.prepare(`DELETE FROM ${FTS_TRI} WHERE id = ?`).run(id);
  sqlite.prepare(`INSERT INTO ${FTS_TRI} (id, content, concepts) VALUES (?, ?, ?)`).run(id, content, concepts);
}

/** Delete a batch of ids from both tables. Caller controls chunking. */
export function ftsDeleteBatch(sqlite: Database, ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  sqlite.prepare(`DELETE FROM ${FTS_MAIN} WHERE id IN (${placeholders})`).run(...ids);
  sqlite.prepare(`DELETE FROM ${FTS_TRI} WHERE id IN (${placeholders})`).run(...ids);
}

/**
 * Is this id present in BOTH tables? Used by verify-after-lock-error in the
 * learn path — "committed" must mean committed everywhere, or the two indexes
 * drift and the divergence is invisible until someone compares counts.
 */
export function ftsHasBoth(sqlite: Database, id: string): boolean {
  const inMain = sqlite.prepare(`SELECT 1 FROM ${FTS_MAIN} WHERE id = ?`).get(id);
  const inTri = sqlite.prepare(`SELECT 1 FROM ${FTS_TRI} WHERE id = ?`).get(id);
  return Boolean(inMain && inTri);
}

/**
 * Build a MATCH query for the trigram table from raw user input.
 *
 * Same shape as sanitizeFtsQuery (quoted tokens, OR-joined, max 8) with one
 * extra rule: drop tokens shorter than 3 characters — the trigram tokenizer
 * cannot produce a token from them, and depending on SQLite version they
 * either match nothing or error the whole query.
 *
 * Returns null when nothing survives (e.g. query was just "PQ") — caller
 * skips the trigram leg and the main table still serves short tokens.
 */
export function trigramMatchQuery(query: string): string | null {
  const tokens = query
    .replace(/<[^>]*>/g, ' ')
    .normalize('NFKC')
    .match(/[\p{L}\p{N}_]+/gu)
    ?.map((token) => token.trim())
    .filter((token) => [...token].length >= 3)
    .slice(0, 8) ?? [];

  const unique = Array.from(new Set(tokens));
  if (unique.length === 0) return null;
  return unique.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ');
}
