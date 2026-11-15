/**
 * Thai word splitting (ICU) + per-document dedupe — issue #2.
 * In-memory DB only; touches no ORACLE_DATA_DIR files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { FTS_MAIN, initFtsTables, ftsUpsert, ftsDeleteBatch } from '../fts-tables.ts';
import { FTS_THAI, segmentThai, hasThai } from '../fts-thai.ts';
import { thaiMatchQuery } from '../fts-thai-query.ts';
import { dedupeBySourceFile } from '../search-dedupe.ts';

let db: Database;
const count = (t: string) => (db.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n;
beforeEach(() => { db = new Database(':memory:'); initFtsTables(db); });
afterEach(() => db.close());

describe('segmentThai', () => {
  it('leaves non-Thai text byte-identical', () => {
    for (const t of ['', 'PQ jq x', 'Hello, world! file.md (v1.2)', 'ทดสอบ'.slice(0, 0)]) {
      expect(segmentThai(t)).toBe(t);
    }
  });
  it('splits Thai run-ons into words', () => {
    const out = segmentThai('ทำไมสระกับวรรณยุกต์ไทยไม่ขึ้น');
    expect(out.split(' ').length).toBeGreaterThan(3);
    expect(out.replace(/ /g, '')).toBe('ทำไมสระกับวรรณยุกต์ไทยไม่ขึ้น');
  });
  it('is idempotent and keeps mixed text readable', () => {
    const once = segmentThai('ใช้ file.md กับสมองกลาง');
    expect(segmentThai(once)).toBe(once);
    expect(once).toContain('file.md');
  });
  it('hasThai', () => { expect(hasThai('abc')).toBe(false); expect(hasThai('aก')).toBe(true); });
});

describe('oracle_fts_th table', () => {
  it('is written, deleted and healed with the others; raw keeps original text', () => {
    const text = 'ทำไมสระกับวรรณยุกต์ไทยไม่ขึ้นในจอดำ';
    ftsUpsert(db, 'a', text, 'x');
    expect(count(FTS_THAI)).toBe(1);
    expect((db.prepare(`SELECT raw FROM ${FTS_THAI} WHERE id='a'`).get() as any).raw).toBe(text);
    ftsUpsert(db, 'a', text, 'x'); // idempotent
    expect(count(FTS_THAI)).toBe(1);
    // heal: row only in main (old-code writer) is copied; orphan in th is pruned
    db.prepare(`INSERT INTO ${FTS_MAIN} (id, content, concepts) VALUES ('b', 'สวัสดีครับ', '')`).run();
    db.prepare(`INSERT INTO ${FTS_THAI} (id, content, concepts, raw) VALUES ('ghost','x','','x')`).run();
    initFtsTables(db);
    expect(count(FTS_THAI)).toBe(2);
    ftsDeleteBatch(db, ['a', 'b']);
    expect(count(FTS_THAI)).toBe(0);
  });
  it('a Thai paraphrase now matches where one-token unicode61 cannot', () => {
    ftsUpsert(db, 'a', 'บริษัทควรมีนักบัญชีของตัวเองและแยกบ้านออกมา', '');
    const q = 'นักบัญชีของตัวเอง';
    const main = db.prepare(`SELECT id FROM ${FTS_MAIN} WHERE ${FTS_MAIN} MATCH ?`).all(`"${q}"`);
    expect(main.length).toBe(0);
    const match = thaiMatchQuery(q, db)!;
    expect(db.prepare(`SELECT id FROM ${FTS_THAI} WHERE ${FTS_THAI} MATCH ?`).all(match).length).toBe(1);
  });
  it('thaiMatchQuery is null for non-Thai queries', () => {
    expect(thaiMatchQuery('PQ jq oracle search')).toBeNull();
  });
});

describe('dedupeBySourceFile', () => {
  it('keeps the first (best) chunk per file, fills from the next, never folds empty source_file', () => {
    const rows = [
      { id: '1', source_file: 'a.md' }, { id: '2', source_file: 'a.md' },
      { id: '3', source_file: 'b.md' }, { id: '4', source_file: '' },
      { id: '5', source_file: '' }, { id: '6', source_file: 'b.md' },
    ];
    expect(dedupeBySourceFile(rows).map((r) => r.id)).toEqual(['1', '3', '4', '5']);
  });
});
