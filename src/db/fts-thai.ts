/**
 * Thai word splitting for FTS — Nat's relic5 way (issue #2).
 *
 * `oracle_fts` uses unicode61, which only breaks on whitespace/punctuation.
 * Thai has no spaces, so a whole Thai sentence is ONE token and a paraphrase
 * question can never match it. ICU knows Thai word boundaries and ships inside
 * Bun/JS: `new Intl.Segmenter('th', { granularity: 'word' })`.
 *
 * Third keyword table `oracle_fts_th` = unicode61 over segmented text:
 *   content / concepts  — Thai words separated by spaces (what gets indexed)
 *   raw                 — the original content, UNINDEXED, so search results
 *                         show the real text, never the space-split copy.
 * oracle_fts and oracle_fts_tri are untouched (every reader of
 * oracle_fts.content keeps seeing the original text).
 *
 * Text without Thai characters passes through byte-identical, so non-Thai
 * documents and queries behave exactly as before.
 */
import type { Database } from 'bun:sqlite';

export const FTS_THAI = 'oracle_fts_th';

const THAI_RE = /[฀-๿]/;
const segmenter = new Intl.Segmenter('th', { granularity: 'word' });

export function hasThai(text: string): boolean {
  return THAI_RE.test(text);
}

/**
 * Insert a space between adjacent word-like segments when either side is Thai.
 * Everything else (spaces, punctuation, English-next-to-English) is emitted
 * untouched. Idempotent: segmenting already-segmented text changes nothing.
 */
export function segmentThai(text: string): string {
  if (!text || !hasThai(text)) return text;
  let out = '';
  let prevWordThai: boolean | null = null; // null = previous segment was not word-like
  for (const s of segmenter.segment(text)) {
    if (s.isWordLike) {
      const thai = hasThai(s.segment);
      if (prevWordThai !== null && (thai || prevWordThai)) out += ' ';
      out += s.segment;
      prevWordThai = thai;
    } else {
      out += s.segment;
      prevWordThai = null;
    }
  }
  return out;
}

export function createThaiTable(sqlite: Database): void {
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_THAI} USING fts5(
      id UNINDEXED,
      content,
      concepts,
      raw UNINDEXED,
      tokenize='porter unicode61'
    )
  `);
}

function thaiInsert(sqlite: Database, id: string, content: string, concepts: string): void {
  sqlite
    .prepare(`INSERT INTO ${FTS_THAI} (id, content, concepts, raw) VALUES (?, ?, ?, ?)`)
    .run(id, segmentThai(content), segmentThai(concepts), content);
}

/** Delete-then-insert (FTS5 has no UNIQUE on id). The delete is a full scan —
 *  heal below uses thaiInsert directly because those ids are known missing. */
export function thaiUpsert(sqlite: Database, id: string, content: string, concepts: string): void {
  sqlite.prepare(`DELETE FROM ${FTS_THAI} WHERE id = ?`).run(id);
  thaiInsert(sqlite, id, content, concepts);
}

/**
 * Copy docs present in `mainTable` but missing from the Thai table (first boot
 * after this feature, or a writer from an older code vintage). Same every-boot
 * invariant as the trigram heal. Segmentation is JS-side, so this runs in
 * batches inside transactions.
 */
export function healThaiTable(sqlite: Database, mainTable: string): { added: number; pruned: number } {
  const missing = sqlite.prepare(`
    SELECT id, MAX(content) AS content, MAX(concepts) AS concepts FROM ${mainTable}
    WHERE id NOT IN (SELECT id FROM ${FTS_THAI})
    GROUP BY id
  `).all() as Array<{ id: string; content: string; concepts: string }>;
  const BATCH = 500;
  for (let i = 0; i < missing.length; i += BATCH) {
    sqlite.transaction(() => {
      for (const r of missing.slice(i, i + BATCH)) thaiInsert(sqlite, r.id, r.content ?? '', r.concepts ?? '');
    })();
  }
  const before = (sqlite.prepare(`SELECT count(*) n FROM ${FTS_THAI}`).get() as { n: number }).n;
  sqlite.prepare(`DELETE FROM ${FTS_THAI} WHERE id NOT IN (SELECT id FROM ${mainTable})`).run();
  const after = (sqlite.prepare(`SELECT count(*) n FROM ${FTS_THAI}`).get() as { n: number }).n;
  return { added: missing.length, pruned: before - after };
}
