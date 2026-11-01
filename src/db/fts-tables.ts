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
import { createHash } from 'crypto';

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
  // Fingerprints, keyed by a real PRIMARY KEY so "did this doc change?" is an
  // index lookup rather than a scan of an FTS table.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ${FTS_HASH} (
      id TEXT PRIMARY KEY,
      hash TEXT NOT NULL
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

  // Fingerprints must never outlive the rows they describe. A hash for an id
  // that FTS no longer holds would make ftsNeedsWrite answer "already indexed"
  // for a doc that is actually missing — a silent hole in search that no error
  // surfaces. Cheap to enforce here, impossible to notice if we skip it.
  sqlite.prepare(`
    DELETE FROM ${FTS_HASH}
    WHERE id NOT IN (SELECT id FROM ${FTS_MAIN})
  `).run();

  const healed = afterHeal - triBefore;
  const pruned = afterHeal - afterPrune;
  if (healed > 0 || pruned > 0) {
    console.error(`[fts] healed ${FTS_TRI}: +${healed} missing, -${pruned} orphaned vs ${FTS_MAIN} (${Date.now() - t0}ms)`);
  }
  return { healed, pruned };
}

/**
 * Fingerprint of what a doc's FTS rows should contain.
 *
 * Lives in its own table because `oracle_fts.id` is UNINDEXED — asking an FTS5
 * table "do you have id X?" is a full scan of every row, measured at 5.6 ms on
 * the real corpus versus 0.004 ms for a primary-key lookup. That 1,400x gap is
 * the whole reason reindex was pathological (see ftsUpsert).
 *
 * A separate table rather than a column on oracle_documents: CREATE TABLE IF
 * NOT EXISTS is idempotent with no migration, it does not touch the schema
 * Drizzle owns, and if it is ever dropped the worst case is one rebuild pass —
 * a missing hash means "write it", never "skip it".
 */
export const FTS_HASH = 'fts_doc_hash';

function contentFingerprint(content: string, concepts: string): string {
  return createHash('sha256').update(content).update('\u0000').update(concepts).digest('hex');
}

/**
 * Should this doc's FTS rows be rewritten? Cheap: one PK lookup, no scan.
 *
 * Returns true when the hash is missing or differs. Callers that skip on false
 * MUST be sure the FTS rows really exist — initFtsTables' heal pass is what
 * guarantees that, and the hash is only written after a successful upsert.
 */
export function ftsNeedsWrite(sqlite: Database, id: string, content: string, concepts: string): boolean {
  const row = sqlite.prepare(`SELECT hash FROM ${FTS_HASH} WHERE id = ?`).get(id) as { hash: string } | null;
  return !row || row.hash !== contentFingerprint(content, concepts);
}

/**
 * Idempotent upsert into both tables, plus the fingerprint.
 *
 * Delete-then-insert because FTS5 puts no UNIQUE constraint on an UNINDEXED
 * column — INSERT OR REPLACE silently accumulates duplicates across reindex
 * runs (the 2026-04-16 drift).
 *
 * No skip-check inside this function, deliberately. An earlier version asked
 * `SELECT ... FROM oracle_fts WHERE id = ?` first to avoid re-tokenising, and
 * it barely helped (97.4s → 85.4s for a run that wrote *zero* rows) because
 * that very question is a full table scan. Skipping is the caller's job, via
 * ftsNeedsWrite, which asks an indexed table instead.
 */
export function ftsUpsert(sqlite: Database, id: string, content: string, concepts: string): void {
  sqlite.prepare(`DELETE FROM ${FTS_MAIN} WHERE id = ?`).run(id);
  sqlite.prepare(`INSERT INTO ${FTS_MAIN} (id, content, concepts) VALUES (?, ?, ?)`).run(id, content, concepts);
  sqlite.prepare(`DELETE FROM ${FTS_TRI} WHERE id = ?`).run(id);
  sqlite.prepare(`INSERT INTO ${FTS_TRI} (id, content, concepts) VALUES (?, ?, ?)`).run(id, content, concepts);
  sqlite.prepare(`INSERT OR REPLACE INTO ${FTS_HASH} (id, hash) VALUES (?, ?)`)
    .run(id, contentFingerprint(content, concepts));
}

/**
 * Delete a batch of ids from both tables AND their fingerprints. Caller
 * controls chunking.
 *
 * Dropping the fingerprint is not bookkeeping tidiness — it is required for
 * correctness. A stale hash left behind says "this doc is already indexed", so
 * if the same id comes back with identical text (a file restored, a vault
 * revert) ftsNeedsWrite would skip it and the doc would stay permanently
 * missing from search with nothing reporting an error.
 */
export function ftsDeleteBatch(sqlite: Database, ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  sqlite.prepare(`DELETE FROM ${FTS_MAIN} WHERE id IN (${placeholders})`).run(...ids);
  sqlite.prepare(`DELETE FROM ${FTS_TRI} WHERE id IN (${placeholders})`).run(...ids);
  sqlite.prepare(`DELETE FROM ${FTS_HASH} WHERE id IN (${placeholders})`).run(...ids);
}

/**
 * Merge FTS5's on-disk segments. Call after a write-heavy pass, never per-doc.
 *
 * Measured on the real brain 2026-07-31: a full 7,948-doc reindex left the file
 * at 149 MB even though VACUUM had just taken it to 97 MB — because FTS5 writes
 * each batch as a new segment and only merges lazily. VACUUM alone could not
 * reclaim it (freelist was ~2 MB); the space was live-but-fragmented index data.
 * optimize (6.9s) + VACUUM (8.7s) took it to 81 MB — smaller than before trigram
 * existed. Ferris caught the regrowth in cold-verify and pointed at segments;
 * this confirms it.
 *
 * Costly enough that it must be gated on real write volume, or a 15-minute
 * vault-sync would pay 7 seconds to merge nothing.
 */
export function ftsOptimize(sqlite: Database): void {
  sqlite.exec(`INSERT INTO ${FTS_MAIN}(${FTS_MAIN}) VALUES('optimize')`);
  sqlite.exec(`INSERT INTO ${FTS_TRI}(${FTS_TRI}) VALUES('optimize')`);
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
 * Split raw user input into candidate FTS tokens. ONE definition for every
 * caller — this used to be copy-pasted in three places and they drifted.
 *
 * ── Why `\p{M}` and NFC, spelled out so nobody "simplifies" it back ──
 *
 * The old form was `.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu)`, which
 * shattered every Thai word (92% of this corpus) into fragments:
 *
 *   `\p{L}` excludes Thai vowels/tone marks — ี ้ ั ์ are all `\p{M}`, so the
 *           regex ended a token at every one of them: "ตอนนี้" → "ตอนน",
 *           "ถ้าเป็น" → "ถ" + "าเป".
 *   NFKC    decomposes ำ (U+0E33) into U+0E4D + U+0E32; U+0E4D is a Mark, so
 *           rule 1 then dropped it: "ทำงาน" → "ท" + "างาน".
 *
 * Measured on 11,281 real prompts before the fix: 85.4% produced at least one
 * SINGLE-CHARACTER token, and a real query came out as
 *   "ตอนน" OR "ถ" OR "าเป" OR "นงานห" OR "วข" OR "อ" OR "ให" OR "claude"
 * — the 8-token budget spent on fragments, with `codex` never even fired.
 *
 * NFC (not NFKC) because the write path does not normalize at all: documents
 * hold ำ as U+0E33, so an NFKC query would emit "ทํางาน" that can never match
 * the stored "ทำงาน". Query and index must agree; the index is the one that
 * cannot be changed cheaply.
 */
export function ftsTokens(query: string): string[] {
  return query
    .replace(/<[^>]*>/g, ' ')
    .normalize('NFC')
    .match(/[\p{L}\p{M}\p{N}_]+/gu)
    ?.map((token) => token.trim())
    .filter((token) => token.length > 0)
    .flatMap(withThaiWords) ?? [];
}

/**
 * Thai has no spaces, so a Thai sentence arrives as ONE token. Both FTS legs
 * then need that whole run to appear verbatim in a document — a question
 * phrased as a situation never does (1 Nov 2026, tinky + ferris: 20 Thai
 * situation queries, fts hit@3 0/20 before this). Keep the run itself (verbatim
 * still wins via trigram) and append its dictionary words from Intl.Segmenter.
 * pruneDeadTokens runs before the 8-token slice, so dead runs do not spend budget.
 */
const THAI = /\p{Script=Thai}/u;
const thaiWords = new Intl.Segmenter('th', { granularity: 'word' });
function withThaiWords(token: string): string[] {
  if (!THAI.test(token)) return [token];
  const words: string[] = [];
  for (const s of thaiWords.segment(token)) {
    if (s.isWordLike && s.segment !== token) words.push(s.segment);
  }
  return [token, ...words];
}

/** Quote + OR-join tokens into an FTS5 MATCH expression. */
export function joinMatchQuery(tokens: string[]): string {
  return Array.from(new Set(tokens))
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(' OR ');
}

/**
 * Does this token match anything in `table`? Existence, not a count.
 *
 * `SELECT COUNT(*)` on a common token walks every hit (6,360 rows for "ที่");
 * `LIMIT 1` stops at the first. The caller only ever asks "is this token dead
 * in this index?", so counting is work thrown away.
 *
 * MUST be asked per table. A token can be absent from `oracle_fts` and present
 * in `oracle_fts_tri` — that is the entire reason the trigram table exists
 * (Thai run-on words: "สมองกลาง" is invisible to unicode61, 268 hits in
 * trigram). Filtering both legs by the main table's answer would delete
 * exactly the recall the trigram leg was added to restore.
 */
export function tokenMatchesIndex(sqlite: Database, table: string, token: string): boolean {
  try {
    return sqlite
      .prepare(`SELECT 1 FROM ${table} WHERE ${table} MATCH ? LIMIT 1`)
      .get(`"${token.replace(/"/g, '""')}"`) != null;
  } catch {
    // A token the tokenizer rejects (e.g. sub-trigram input) is "not present"
    // rather than fatal — the other leg still answers.
    return false;
  }
}

/**
 * Drop tokens absent from `table`, then take the first `limit`.
 *
 * Order matters: filtering AFTER the slice would leave dead tokens holding
 * budget slots. Thai has no spaces between words, so fixing the shatter above
 * turns whole phrases into single tokens that exist nowhere in the index —
 * "ทบทวนเรื่องการย้าย" (df 0), "เรามีทางไหนในสมองกลาง" (df 0). Measured on the
 * same 11,281 prompts: 38.1% of queries had at least one such token eating a
 * slot while a real token waited behind it (9,094 slots total).
 *
 * This is not an optional extra. It repairs a side effect that fixing the
 * tokenizer creates: on the labeled corpus, a case that ranked 8th before the
 * tokenizer fix fell to 17th with the fix alone, and returned to 8th with this.
 */
export function pruneDeadTokens(
  sqlite: Database,
  table: string,
  tokens: string[],
  limit: number,
): string[] {
  const seen = new Map<string, boolean>();
  const alive: string[] = [];
  for (const token of tokens) {
    if (alive.length >= limit) break;
    let ok = seen.get(token);
    if (ok === undefined) {
      ok = tokenMatchesIndex(sqlite, table, token);
      seen.set(token, ok);
    }
    if (ok) alive.push(token);
  }
  // Everything pruned means the caller would otherwise send an empty MATCH and
  // lose the leg entirely. Fall back to the unpruned head: a query that finds
  // nothing is strictly better than no query at all, and it keeps behavior
  // identical to pre-patch for inputs where nothing is indexed.
  return alive.length > 0 ? alive : tokens.slice(0, limit);
}

/**
 * Build a MATCH query for the trigram table from raw user input.
 *
 * Same shape as buildFtsQuery (quoted tokens, OR-joined, max 8) with one
 * extra rule: drop tokens shorter than 3 characters — the trigram tokenizer
 * cannot produce a token from them, and depending on SQLite version they
 * either match nothing or error the whole query.
 *
 * Pass `sqlite` to also prune tokens absent from the trigram index (see
 * pruneDeadTokens). Omitted → pure function, unchanged behavior, still unit
 * testable without a database.
 *
 * Returns null when nothing survives (e.g. query was just "PQ") — caller
 * skips the trigram leg and the main table still serves short tokens.
 */
export function trigramMatchQuery(query: string, sqlite?: Database): string | null {
  const long = ftsTokens(query).filter((token) => [...token].length >= 3);
  const unique = Array.from(new Set(long));
  if (unique.length === 0) return null;
  const tokens = sqlite
    ? pruneDeadTokens(sqlite, FTS_TRI, unique, 8)
    : unique.slice(0, 8);
  if (tokens.length === 0) return null;
  return joinMatchQuery(tokens);
}
