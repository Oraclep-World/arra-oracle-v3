/**
 * Dual FTS tables (unicode61 + trigram) — the contract each part must keep.
 *
 * Background (measured 2026-07-30, real corpus 7,963 docs / 93% Thai):
 * unicode61 alone gave 26% Thai recall on real logged queries; trigram alone
 * loses every token < 3 chars ("PQ": 1,484 docs → 0). Both tables together,
 * merged at search time, is the only shape that loses neither.
 *
 * The risk this file guards is DRIFT: two indexes that disagree are invisible
 * from search results (the merge papers over the gap), so every write helper
 * must provably touch both tables.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  FTS_MAIN, FTS_TRI,
  initFtsTables, ftsUpsert, ftsDeleteBatch, ftsHasBoth, trigramMatchQuery,
} from '../fts-tables.ts';

let db: Database;
const count = (table: string) =>
  (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  db = new Database(':memory:');
  initFtsTables(db);
});
afterEach(() => db.close());

describe('initFtsTables', () => {
  it('creates both tables, idempotently', () => {
    initFtsTables(db); // second call must not throw or duplicate
    expect(count(FTS_MAIN)).toBe(0);
    expect(count(FTS_TRI)).toBe(0);
  });

  it('backfills the trigram table from an existing main table', () => {
    // Simulate a pre-trigram DB: main has rows, tri does not exist yet.
    const old = new Database(':memory:');
    old.exec(`CREATE VIRTUAL TABLE ${FTS_MAIN} USING fts5(id UNINDEXED, content, concepts, tokenize='porter unicode61')`);
    old.prepare(`INSERT INTO ${FTS_MAIN} (id, content, concepts) VALUES (?, ?, ?)`)
      .run('d1', 'สมองกลางของฟลีต', 'brain');
    old.prepare(`INSERT INTO ${FTS_MAIN} (id, content, concepts) VALUES (?, ?, ?)`)
      .run('d2', 'hello world', 'greeting');

    initFtsTables(old);

    expect((old.prepare(`SELECT count(*) n FROM ${FTS_TRI}`).get() as any).n).toBe(2);
    // The backfilled content must actually be searchable the trigram way.
    const hit = old.prepare(`SELECT id FROM ${FTS_TRI} WHERE ${FTS_TRI} MATCH ?`).all('"องกลา"');
    expect(hit.map((r: any) => r.id)).toEqual(['d1']);
    old.close();
  });

  it('does not re-backfill when tri already has rows', () => {
    ftsUpsert(db, 'd1', 'content one', 'c');
    initFtsTables(db); // must not duplicate d1 in tri
    expect(count(FTS_TRI)).toBe(1);
  });
});

describe('ftsUpsert', () => {
  it('writes to both tables', () => {
    ftsUpsert(db, 'd1', 'ทดสอบสมองกลาง', 'brain test');
    expect(count(FTS_MAIN)).toBe(1);
    expect(count(FTS_TRI)).toBe(1);
    expect(ftsHasBoth(db, 'd1')).toBe(true);
  });

  it('is idempotent — re-upserting the same id does not duplicate in either table', () => {
    ftsUpsert(db, 'd1', 'first version', 'c');
    ftsUpsert(db, 'd1', 'second version', 'c');
    expect(count(FTS_MAIN)).toBe(1);
    expect(count(FTS_TRI)).toBe(1);
    // and the surviving row is the newest — in both tables
    const main = db.prepare(`SELECT content FROM ${FTS_MAIN} WHERE id = ?`).get('d1') as any;
    const tri = db.prepare(`SELECT content FROM ${FTS_TRI} WHERE id = ?`).get('d1') as any;
    expect(main.content).toBe('second version');
    expect(tri.content).toBe('second version');
  });

  it('Thai mid-word search hits via trigram where unicode61 misses', () => {
    ftsUpsert(db, 'd1', 'ตรวจสอบระบบสมองกลาง', 'ops');
    // unicode61 sees one giant token — mid-word match fails
    const uni = db.prepare(`SELECT id FROM ${FTS_MAIN} WHERE ${FTS_MAIN} MATCH ?`).all('"องกลา"');
    expect(uni).toHaveLength(0);
    // trigram finds the substring
    const tri = db.prepare(`SELECT id FROM ${FTS_TRI} WHERE ${FTS_TRI} MATCH ?`).all('"องกลา"');
    expect(tri.map((r: any) => r.id)).toEqual(['d1']);
  });
});

describe('ftsDeleteBatch', () => {
  it('deletes from both tables', () => {
    ftsUpsert(db, 'd1', 'one', 'c');
    ftsUpsert(db, 'd2', 'two', 'c');
    ftsDeleteBatch(db, ['d1']);
    expect(ftsHasBoth(db, 'd1')).toBe(false);
    expect(ftsHasBoth(db, 'd2')).toBe(true);
    expect(count(FTS_MAIN)).toBe(1);
    expect(count(FTS_TRI)).toBe(1);
  });

  it('empty batch is a no-op, not an error', () => {
    expect(() => ftsDeleteBatch(db, [])).not.toThrow();
  });
});

describe('ftsHasBoth', () => {
  it('false when the id is only in one table — the drift this feature must surface', () => {
    // Hand-write only into main, bypassing the helper (simulating a rogue writer).
    db.prepare(`INSERT INTO ${FTS_MAIN} (id, content, concepts) VALUES (?, ?, ?)`)
      .run('half', 'only in main', 'c');
    expect(ftsHasBoth(db, 'half')).toBe(false);
  });
});

describe('trigramMatchQuery', () => {
  it('keeps tokens >= 3 chars, quoted and OR-joined', () => {
    expect(trigramMatchQuery('สมองกลาง verify')).toBe('"สมองกลาง" OR "verify"');
  });

  it('drops short tokens and returns null when nothing survives', () => {
    // "PQ" and "x" are exactly the tokens the trigram table cannot serve —
    // the caller must skip the trigram leg, not send a query that errors.
    expect(trigramMatchQuery('PQ')).toBeNull();
    expect(trigramMatchQuery('x jq')).toBeNull();
    // mixed: short token dropped, long token kept
    expect(trigramMatchQuery('PQ สมองกลาง')).toBe('"สมองกลาง"');
  });

  it('counts length in code points, not UTF-16 units', () => {
    // "กข" = 2 Thai chars → dropped; "กขค" = 3 → kept
    expect(trigramMatchQuery('กข')).toBeNull();
    expect(trigramMatchQuery('กขค')).toBe('"กขค"');
  });

  it('escapes embedded quotes', () => {
    expect(trigramMatchQuery('say"hello')).toBe('"say" OR "hello"');
  });
});
