/**
 * The vector run-marker must be written by BOTH paths that can finish a run.
 *
 * History (2026-07-30): the marker was added to `src/indexer/cli.ts` only. The
 * every-3-hours cron does not use the CLI — `~/.oracle/vector-reindex.sh` POSTs
 * to /api/vector/index/start — so the unattended path, where silence costs the
 * most, wrote nothing at all. Meanwhile `/api/vector/index/status` is in-memory
 * and two server restarts erased it, leaving "when did embeddings last succeed?"
 * unanswerable while FTS looked perfectly fresh.
 *
 * What is asserted here:
 *   - one shared writer exists and round-trips (no per-caller copies to drift)
 *   - `via` distinguishes cli from api, so an operator knows where to look
 *   - the writer never throws, even when the target directory is unwritable
 *   - **the route path records an outcome** — the regression that started this:
 *     asserted by grepping the route for the `finally` hook rather than booting
 *     a full embed (which would need Ollama and rewrite the real collection)
 */

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import path from 'path';
import os from 'os';
import fs from 'fs';

const REPO_ROOT = path.resolve(import.meta.dir, '../../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-run-marker-'));

// ORACLE_DATA_DIR is frozen at config.ts import time — set before the dynamic import.
process.env.ORACLE_DATA_DIR = TMP;
const { recordVectorOutcome, readVectorOutcome, VECTOR_RUN_MARKER } = await import('../run-marker.ts');

describe('vector run-marker — shared writer', () => {
  beforeEach(() => {
    try { fs.rmSync(VECTOR_RUN_MARKER); } catch { /* first run */ }
  });

  it('writes under ORACLE_DATA_DIR and round-trips', () => {
    expect(VECTOR_RUN_MARKER).toBe(path.join(TMP, 'vector-last-run.json'));
    recordVectorOutcome('ok', '7461 docs via bge-m3', 'api');

    const r = readVectorOutcome();
    expect(r?.outcome).toBe('ok');
    expect(r?.detail).toBe('7461 docs via bge-m3');
    expect(r?.via).toBe('api');
    expect(typeof r?.at).toBe('number');
  });

  it('records which path finished the run (cli vs api)', () => {
    recordVectorOutcome('skipped', 'no vector server answering on port 8081', 'cli');
    expect(readVectorOutcome()?.via).toBe('cli');
    recordVectorOutcome('unknown', 'unreachable mid-run', 'api');
    expect(readVectorOutcome()?.via).toBe('api');
  });

  it('defaults via to cli and caps long details', () => {
    recordVectorOutcome('skipped', 'x'.repeat(900));
    const r = readVectorOutcome();
    expect(r?.via).toBe('cli');
    expect(r?.detail?.length).toBe(400);
  });

  it('never throws when the marker cannot be written', () => {
    // The path is resolved at module load, so make the REAL target unwritable.
    // (beforeEach deletes it, so create it first — the earlier version of this
    // test chmod'd a file that did not exist and failed on ENOENT: the test was
    // broken, not the code.)
    recordVectorOutcome('ok', 'seed');
    fs.chmodSync(VECTOR_RUN_MARKER, 0o444);
    try {
      expect(() => recordVectorOutcome('ok', 'should not throw')).not.toThrow();
      // and the unwritable file kept its previous content — the write failed silently
      expect(readVectorOutcome()?.detail).toBe('seed');
    } finally {
      fs.chmodSync(VECTOR_RUN_MARKER, 0o644);
    }
  });

  it('readVectorOutcome returns null when nothing was recorded', () => {
    try { fs.rmSync(VECTOR_RUN_MARKER); } catch {}
    expect(readVectorOutcome()).toBeNull();
  });
});

describe('vector run-marker — the cron path is wired', () => {
  const routeSrc = fs.readFileSync(
    path.join(REPO_ROOT, 'src/routes/vector/indexer.ts'),
    'utf-8',
  );

  it('the HTTP route (what cron calls) records an outcome', () => {
    expect(routeSrc).toContain("from '../../vector/run-marker.ts'");
    expect(routeSrc).toContain('function recordJobOutcome');
    expect(routeSrc).toContain('recordJobOutcome();');
  });

  it('records in a finally block, so future exit paths are covered too', () => {
    // The regression was a hook attached to one branch only; `finally` is what
    // makes "every terminal state" true rather than "the states we remembered".
    //
    // Check the finally block that CONTAINS the call — the route has an earlier
    // `finally { store.close() }` inside the per-model loop, and matching the
    // first one made this test fail while the code was correct (a false red of
    // my own making: the assertion measured position, not the property asked).
    const call = routeSrc.indexOf('recordJobOutcome();');
    expect(call).toBeGreaterThan(-1);
    const before = routeSrc.slice(0, call);
    const enclosing = before.lastIndexOf('} finally {');
    expect(enclosing).toBeGreaterThan(-1);
    // nothing may close that block between `finally {` and the call
    expect(before.slice(enclosing).includes('\n      }')).toBe(false);
  });

  it('the CLI path uses the SAME shared writer (no second copy to drift)', () => {
    const cliSrc = fs.readFileSync(path.join(REPO_ROOT, 'src/indexer/cli.ts'), 'utf-8');
    expect(cliSrc).toContain("from '../vector/run-marker.ts'");
    // the old local definitions must be gone
    expect(cliSrc).not.toContain('function recordVectorOutcome');
    expect(cliSrc).not.toMatch(/const VECTOR_RUN_MARKER\s*=/);
  });
});

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});
