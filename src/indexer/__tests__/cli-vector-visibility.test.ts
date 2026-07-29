/**
 * Regression tests for the two footguns found on 2026-07-30 (reported by ora101,
 * with volt hitting the same one on 2026-06-24 — five weeks and two houses apart):
 *
 *   1. `bun src/indexer/cli.ts --help` started a REAL reindex, because the CLI
 *      never read process.argv at all — every flag was silently ignored.
 *   2. When the vector step could not run, the only trace was one console.warn
 *      and exit 0. Under cron nobody reads stdout, so FTS stayed fresh while
 *      embeddings silently went stale (config pointed at a port nothing served).
 *
 * What is asserted here:
 *   - the argv guard refuses ANY argument, exits 1, and does not touch the DB
 *   - a dead vector port writes an outcome marker instead of failing silently
 *   - the happy path records outcome "ok"
 *
 * Hermetic: ORACLE_DATA_DIR points at a tmp dir holding its own
 * vector-server.json, so neither the real ~/.oracle config nor the shared brain
 * DB is touched. The vector server is a local stub — no Ollama, no embedding.
 */

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import path from 'path';
import os from 'os';
import fs from 'fs';

const REPO_ROOT = path.resolve(import.meta.dir, '../../..');
const CLI = path.join(REPO_ROOT, 'src/indexer/cli.ts');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arra-cli-vis-'));
const MARKER = path.join(TMP, 'vector-last-run.json');

function writeVectorConfig(port: number): void {
  fs.writeFileSync(
    path.join(TMP, 'vector-server.json'),
    JSON.stringify({
      version: '1.0',
      enabled: true,
      host: '127.0.0.1',
      port,
      collections: {
        'bge-m3': { adapter: 'lancedb', collection: 'c', model: 'bge-m3', provider: 'ollama', primary: true },
      },
      dataPath: path.join(TMP, 'lancedb'),
    }),
    'utf-8',
  );
}

function readMarker(): { outcome?: string; detail?: string } | null {
  try {
    return JSON.parse(fs.readFileSync(MARKER, 'utf-8'));
  } catch {
    return null;
  }
}

/** Run the vector step in a child process so ORACLE_DATA_DIR is read fresh (config.ts freezes it at import). */
async function runVectorStep(): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(
    ['bun', '-e', `const m = await import(${JSON.stringify(CLI)}); await m.autoIndexVectors();`],
    { cwd: REPO_ROOT, env: { ...process.env, ORACLE_DATA_DIR: TMP }, stdout: 'pipe', stderr: 'pipe' },
  );
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: out + err };
}

describe('indexer CLI — argv guard', () => {
  it('refuses any argument, exits 1, and prints usage instead of reindexing', async () => {
    for (const arg of ['--help', '--dry-run', 'helpp', '-h']) {
      const proc = Bun.spawn(['bun', CLI, arg], {
        cwd: REPO_ROOT,
        env: { ...process.env, ORACLE_DATA_DIR: TMP },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      const all = out + err;

      expect(code).toBe(1);
      expect(all).toContain('takes no arguments');
      expect(all).toContain('usage:');
      // The action itself must not have started: the runner announces itself.
      expect(all).not.toContain('Indexing complete!');
      expect(all).not.toContain('[Auto-Vector] vector section enabled');
    }
  }, 60_000);

  it('importing the module does not run the reindex (import.meta.main guard)', async () => {
    const proc = Bun.spawn(
      ['bun', '-e', `await import(${JSON.stringify(CLI)}); console.log('IMPORTED_CLEAN');`],
      { cwd: REPO_ROOT, env: { ...process.env, ORACLE_DATA_DIR: TMP }, stdout: 'pipe', stderr: 'pipe' },
    );
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect(out).toContain('IMPORTED_CLEAN');
    expect(out + err).not.toContain('Indexing complete!');
  }, 30_000);
});

describe('indexer CLI — vector step leaves a readable outcome', () => {
  beforeEach(() => {
    try { fs.rmSync(MARKER); } catch { /* first run */ }
  });

  it('records outcome=skipped (not silence) when no vector server answers the configured port', async () => {
    writeVectorConfig(45999); // nothing listens here
    const { out } = await runVectorStep();

    const m = readMarker();
    expect(m?.outcome).toBe('skipped');
    expect(m?.detail).toContain('45999');
    // and it says so loudly, naming the port and where the port came from
    expect(out).toContain('VECTOR EMBEDDINGS NOT UPDATED');
    expect(out).toContain('45999');
    expect(out).toContain('vector-server.json');
  }, 30_000);

  it('records outcome=ok when the job completes', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === '/api/vector/index/status')
          return Response.json({ jobId: 'j1', status: 'completed', current: 42, total: 42 });
        if (u.pathname === '/api/vector/index/start') return Response.json({ jobId: 'j1' });
        return new Response('nope', { status: 404 });
      },
    });
    try {
      writeVectorConfig(server.port);
      const { out } = await runVectorStep();
      expect(out).toContain('embeddings complete');
      const m = readMarker();
      expect(m?.outcome).toBe('ok');
    } finally {
      server.stop(true);
    }
  }, 30_000);

  it('records outcome=skipped when the job reports an error', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === '/api/vector/index/status')
          return Response.json({ jobId: 'j2', status: 'error', error: 'embedder exploded' });
        if (u.pathname === '/api/vector/index/start') return Response.json({ jobId: 'j2' });
        return new Response('nope', { status: 404 });
      },
    });
    try {
      writeVectorConfig(server.port);
      const { out } = await runVectorStep();
      expect(readMarker()?.outcome).toBe('skipped');
      expect(out).toContain('embedder exploded');
    } finally {
      server.stop(true);
    }
  }, 30_000);
});

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});
