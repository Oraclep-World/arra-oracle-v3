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
 *
 * ── DECIDED, DO NOT REOPEN: no contentless / external-content optimisation ──
 *
 * oracle_fts_tri is a standalone FTS5 table, so it keeps its own copy of the
 * text. On the real brain that costs ~88 MB, not the ~29 MB the index alone
 * would suggest. Making it `content=''` would give ~55 MB back. It was probed
 * (2026-07-30) and rejected — the saving is not worth these failure modes:
 *
 *   DELETE FROM t WHERE id = ?   → reports success, deletes NOTHING, no error.
 *                                  ftsUpsert is delete-then-insert, so every
 *                                  reindex would silently accumulate garbage —
 *                                  exactly the 2026-04-16 drift, but invisible.
 *   SELECT content FROM t        → returns NULL, breaking the JOIN in search.
 *   correct deletion             → requires replaying the ORIGINAL text plus a
 *                                  matching rowid; feed it slightly wrong text
 *                                  and the index corrupts with no error raised.
 *
 * 88 MB on a disk with 880 GB free, versus an index that can rot without ever
 * saying so. พลีม chose the boring, loud-when-wrong option. Keep it.
 */
import type { Database } from 'bun:sqlite';

export const FTS_MAIN = 'oracle_fts';
export const FTS_TRI = 'oracle_fts_tri';

/**
 * Create both FTS tables (idempotent) and backfill the trigram table from the
 * main one when it is empty — first boot after this feature, or a manual drop.
 * Backfill measured at ~2s for the full corpus, acceptable at startup.
 */
export function initFtsTables(sqlite: Database): { healed: number; pruned: number } {
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

  // Self-heal: copy any id present in main but missing from tri.
  //
  // A backfill-only-when-empty guard proved insufficient within MINUTES of
  // deploy (2026-07-30): during the rollout window, old-code writers (MCP
  // stdio processes spawned before the change, plus the pre-restart HTTP
  // server) kept writing main-only while a new-code process had already
  // created tri → 8,002 vs 7,963 on the real brain. Mixed code vintages
  // writing one DB is the norm here, not an edge case, so healing has to be
  // an every-boot invariant, not a first-boot event.
  //
  // GROUP BY collapses duplicate ids in main (FTS5 has no UNIQUE on an
  // UNINDEXED column — see the 2026-04-16 drift) so healing copies one row
  // per id instead of re-importing the duplication.
  // Deltas are measured by COUNTing before/after, NOT from stmt.changes —
  // on an FTS5 virtual table sqlite3_changes() reports shadow-table row ops
  // (a full 8,002-doc backfill logged "+136,582"), which made the heal log
  // lie by ~17x. This log line is the operator's drift signal; a number that
  // certifies itself is worse than no number.
  const t0 = Date.now();
  const triBefore = (sqlite.prepare(`SELECT count(*) n FROM ${FTS_TRI}`).get() as { n: number }).n;
  sqlite.prepare(`
    INSERT INTO ${FTS_TRI} (id, content, concepts)
    SELECT id, MAX(content), MAX(concepts) FROM ${FTS_MAIN}
    WHERE id NOT IN (SELECT id FROM ${FTS_TRI})
    GROUP BY id
  `).run();
  const afterHeal = (sqlite.prepare(`SELECT count(*) n FROM ${FTS_TRI}`).get() as { n: number }).n;
  // And the reverse direction: ids main has deleted but tri still holds
  // (an old-code writer deletes main-only, since tri did not exist for it).
  // Search never shows these ghosts — the JOIN on oracle_documents filters
  // them — but they would keep fts_tri_status stuck on "drift" forever,
  // which trains people to ignore the one number meant to catch real drift.
  sqlite.prepare(`
    DELETE FROM ${FTS_TRI}
    WHERE id NOT IN (SELECT id FROM ${FTS_MAIN})
  `).run();
  const afterPrune = (sqlite.prepare(`SELECT count(*) n FROM ${FTS_TRI}`).get() as { n: number }).n;

  const healed = afterHeal - triBefore;
  const pruned = afterHeal - afterPrune;
  if (healed > 0 || pruned > 0) {
    console.error(`[fts] healed ${FTS_TRI}: +${healed} missing, -${pruned} orphaned vs ${FTS_MAIN} (${Date.now() - t0}ms)`);
  }
  return { healed, pruned };
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
