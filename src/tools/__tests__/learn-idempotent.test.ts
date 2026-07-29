/**
 * Regression tests — oracle_learn "locked but written" duplicate bug
 * (reported by ora101, 2026-07-29).
 *
 * Old failure shape: file write succeeded, then a SQLite lock error surfaced
 * from the (non-transactional) index-row writes. The caller was told the
 * write failed, retried, hit "File already exists", rephrased — and minted a
 * duplicate learning ("pattern" → "pattern-2").
 *
 * New contract under test:
 *   1. Retrying the SAME pattern is idempotent: success + deduped, no new
 *      file, index rows repaired if missing.
 *   2. documents + FTS rows are transactional: an index failure leaves NO
 *      partial DB rows (file stays — the retry heals it).
 *   3. A genuinely different pattern colliding on the same slug still errors
 *      (MCP path has no auto-suffix) — with a structured, non-throwing reply.
 *
 * Hermetic: ORACLE_REPO_ROOT + ORACLE_DATA_DIR point at tmp dirs, set BEFORE
 * the dynamic import (config.ts module state is import-frozen). Without
 * ORACLE_DATA_DIR isolation, getVaultPsiRoot() reads the REAL ~/.oracle DB
 * and tests would write into the real vault.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'path';
import os from 'os';
import fs from 'fs';
import Database from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from '../../db/schema.ts';
import type { ToolContext } from '../types.ts';

const FULL_SCHEMA = `
CREATE TABLE oracle_documents (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source_file TEXT NOT NULL,
  concepts TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  superseded_by TEXT,
  superseded_at INTEGER,
  superseded_reason TEXT,
  origin TEXT,
  project TEXT,
  created_by TEXT
);
CREATE VIRTUAL TABLE oracle_fts USING fts5(id UNINDEXED, content, concepts, tokenize='porter unicode61');
`;

const ORIGINAL_REPO_ROOT = process.env.ORACLE_REPO_ROOT;
const ORIGINAL_DATA_DIR = process.env.ORACLE_DATA_DIR;

const SHARED_REPO_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-learn-idem-root-'));
const SHARED_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-learn-idem-data-'));
process.env.ORACLE_REPO_ROOT = SHARED_REPO_ROOT;
process.env.ORACLE_DATA_DIR = SHARED_DATA_DIR;

// Dynamic import after env is set. Top-level await is supported in Bun.
const { handleLearn } = await import('../learn.ts');
const { extractContentHash, learningContentHash } = await import('../../learn/markdown.ts');

const LEARNINGS_DIR = path.join(SHARED_REPO_ROOT, 'ψ/memory/learnings');

interface Harness {
  ctx: ToolContext;
  sqlite: Database;
}

function makeHarness(): Harness {
  const sqlite = new Database(':memory:');
  sqlite.exec(FULL_SCHEMA);
  const db = drizzle(sqlite, { schema });
  const ctx: ToolContext = {
    db,
    sqlite,
    repoRoot: SHARED_REPO_ROOT,
    vectorStore: null as unknown as ToolContext['vectorStore'],
    vectorStatus: 'unknown',
    version: 'test',
  };
  return { ctx, sqlite };
}

function counts(sqlite: Database, id: string): { doc: number; fts: number } {
  const doc = sqlite.query('SELECT COUNT(*) as c FROM oracle_documents WHERE id = ?').get(id) as { c: number };
  const fts = sqlite.query('SELECT COUNT(*) as c FROM oracle_fts WHERE id = ?').get(id) as { c: number };
  return { doc: doc.c, fts: fts.c };
}

function learningsFileCount(): number {
  if (!fs.existsSync(LEARNINGS_DIR)) return 0;
  return fs.readdirSync(LEARNINGS_DIR).length;
}

describe('extractContentHash', () => {
  it('round-trips the hash line written by buildLearningMarkdown', () => {
    const hash = learningContentHash('some pattern');
    expect(extractContentHash(`---\nid: x\nhash: ${hash}\n---\nbody`)).toBe(hash);
  });

  it('returns null for legacy files without a hash line', () => {
    expect(extractContentHash('---\nid: x\n---\nbody')).toBeNull();
  });
});

describe('handleLearn — idempotent retry (locked-but-written)', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    try { h.sqlite.close(); } catch {}
    try { fs.rmSync(LEARNINGS_DIR, { recursive: true, force: true }); } catch {}
  });

  it('retrying the SAME pattern dedupes: no new file, same id, single row set', async () => {
    const pattern = 'idempotent retry pattern one\nwith a body line';
    const first = JSON.parse((await handleLearn(h.ctx, { pattern })).content[0].text);
    expect(first.success).toBe(true);
    expect(first.deduped).toBeUndefined();

    const second = JSON.parse((await handleLearn(h.ctx, { pattern })).content[0].text);
    expect(second.success).toBe(true);
    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);
    expect(second.file).toBe(first.file);

    expect(learningsFileCount()).toBe(1);
    expect(counts(h.sqlite, first.id)).toEqual({ doc: 1, fts: 1 });
  });

  it('repairs missing index rows on retry (the ora101 crash shape)', async () => {
    const pattern = 'crash shape pattern\nindex rows lost after file write';
    const first = JSON.parse((await handleLearn(h.ctx, { pattern })).content[0].text);
    expect(first.success).toBe(true);

    // Simulate "locked" attempt: file landed, index rows never committed.
    h.sqlite.exec(`DELETE FROM oracle_documents WHERE id = '${first.id}'`);
    h.sqlite.exec(`DELETE FROM oracle_fts WHERE id = '${first.id}'`);
    expect(counts(h.sqlite, first.id)).toEqual({ doc: 0, fts: 0 });

    const retry = JSON.parse((await handleLearn(h.ctx, { pattern })).content[0].text);
    expect(retry.success).toBe(true);
    expect(retry.deduped).toBe(true);
    expect(retry.id).toBe(first.id);
    expect(counts(h.sqlite, first.id)).toEqual({ doc: 1, fts: 1 });
    expect(learningsFileCount()).toBe(1);
  });

  it('index failure is atomic (no partial rows) and the retry self-heals', async () => {
    const pattern = 'atomic failure pattern\nfts table gone mid-flight';

    // Force the transaction to fail after the file write.
    h.sqlite.exec('DROP TABLE oracle_fts');
    const res = await handleLearn(h.ctx, { pattern });
    const failed = JSON.parse(res.content[0].text);
    expect(res.isError).toBe(true);
    expect(failed.success).toBe(false);
    expect(failed.fileWritten).toBe(true);
    expect(failed.retrySafe).toBe(true);

    // All-or-nothing: the documents row must have rolled back with the FTS failure.
    const doc = h.sqlite.query('SELECT COUNT(*) as c FROM oracle_documents').get() as { c: number };
    expect(doc.c).toBe(0);
    // The file itself stays — that's what makes the retry repairable.
    expect(learningsFileCount()).toBe(1);

    // Retry with the SAME text heals everything.
    h.sqlite.exec(`CREATE VIRTUAL TABLE oracle_fts USING fts5(id UNINDEXED, content, concepts, tokenize='porter unicode61')`);
    const retry = JSON.parse((await handleLearn(h.ctx, { pattern })).content[0].text);
    expect(retry.success).toBe(true);
    expect(retry.deduped).toBe(true);
    expect(counts(h.sqlite, retry.id)).toEqual({ doc: 1, fts: 1 });
    expect(learningsFileCount()).toBe(1);
  });

  it('different content on the same slug still errors (structured, no overwrite)', async () => {
    // Same first-50-chars → same slug/filename, different body → different hash.
    const prefix = 'slug collision pattern shared first line long text';
    const first = JSON.parse((await handleLearn(h.ctx, { pattern: `${prefix}\nbody one` })).content[0].text);
    expect(first.success).toBe(true);

    const res = await handleLearn(h.ctx, { pattern: `${prefix}\nbody two` });
    const second = JSON.parse(res.content[0].text);
    expect(res.isError).toBe(true);
    expect(second.success).toBe(false);
    expect(second.error).toContain('File already exists with different content');

    // Nothing new written; original file intact.
    expect(learningsFileCount()).toBe(1);
    const onDisk = fs.readFileSync(path.join(SHARED_REPO_ROOT, first.file), 'utf-8');
    expect(onDisk).toContain('body one');
  });
});

process.on('exit', () => {
  try { fs.rmSync(SHARED_REPO_ROOT, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(SHARED_DATA_DIR, { recursive: true, force: true }); } catch {}
  if (ORIGINAL_REPO_ROOT) process.env.ORACLE_REPO_ROOT = ORIGINAL_REPO_ROOT;
  else delete process.env.ORACLE_REPO_ROOT;
  if (ORIGINAL_DATA_DIR) process.env.ORACLE_DATA_DIR = ORIGINAL_DATA_DIR;
  else delete process.env.ORACLE_DATA_DIR;
});

// ── orphan ledger + actionable failure (ora101, 2026-07-30) ──────────────────
// Field report: a real "database is locked" left the file on disk with EMPTY
// index rows, and the HTTP layer answered a bare 500. Nothing reindexes FTS on a
// timer, and the vector cron embeds *from sqlite* — so a caller who believes the
// error and stops has created a file no search can ever reach.
describe('handleLearn — index failure is recorded, not just reported', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    try { h.sqlite.close(); } catch {}
    try { fs.rmSync(LEARNINGS_DIR, { recursive: true, force: true }); } catch {}
  });

  it('appends to the orphan ledger and tells the caller it is retry-safe', async () => {
    const { ORPHAN_LEDGER } = await import('../../learn/index-rows.ts');
    const before = fs.existsSync(ORPHAN_LEDGER) ? fs.readFileSync(ORPHAN_LEDGER, 'utf-8').split('\n').length : 0;

    h.sqlite.exec('DROP TABLE oracle_fts');   // force the index write to fail
    const res = await handleLearn(h.ctx, { pattern: 'orphan ledger pattern\nwritten but unindexed' });
    const parsed = JSON.parse(res.content[0].text);

    expect(res.isError).toBe(true);
    expect(parsed.fileWritten).toBe(true);
    expect(parsed.retrySafe).toBe(true);
    expect(parsed.recorded).toBe(ORPHAN_LEDGER);
    expect(parsed.tip).toContain('SAME pattern');

    // the ledger grew, and the newest entry names this document
    const lines = fs.readFileSync(ORPHAN_LEDGER, 'utf-8').trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(before);
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.docId).toBe(parsed.id);
    expect(last.sourceFile).toBe(parsed.file);
  });
});
