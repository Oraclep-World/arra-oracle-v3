/**
 * Test isolation — imported FIRST by config.ts, so it runs wherever bun test
 * runs (any cwd, with or without bunfig preload). Fail-closed by design.
 *
 * Why (1 Nov 2026, tinky + ferris): the suite leaked into the live brain on
 * 31 Jul (x7 runs) and twice on 1 Nov — fixture lessons committed into
 * oracle-vault, vector-server.json overwritten (vector search down
 * 21:39:50–21:42:50), backup sets, peer-key.hex. Paths in: `.env` and the
 * shell profile both export ORACLE_DATA_DIR=<real ~/.oracle> as an absolute
 * path; HTTP contract tests reuse any server on :47778 (the live brain).
 * A first guard (95dd56f8) tried to DETECT "live" and ferris broke it 6 ways
 * (decoy HOME, cwd without bunfig, ORACLE_DB_PATH kept, 9/10 URL spellings,
 * one-shot probe, :8081). So this one does not detect anything:
 *
 *  - under NODE_ENV=test every data path that is not already inside
 *    os.tmpdir() is replaced by a fresh temp dir;
 *  - fetch to ports 47778 (brain HTTP) and 8081 (vector server) is refused
 *    for every host spelling, the whole run, unless the operator sets
 *    ARRA_TEST_ALLOW_LIVE_PORTS=1 after stopping the live services.
 */
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const FLAG = Symbol.for('arra.testIsolation');
const g = globalThis as any;

// When: NODE_ENV=test is not enough — bun keeps a preset NODE_ENV (ferris: NODE_ENV=production
// bun test → no isolation). Bun.main is the entry file: under bun test it is the *.test/.spec file,
// even with NODE_ENV preset. scripts/seed-test-* write test rows too (break S), so they count.
const entry = String((globalThis as any).Bun?.main ?? process.argv[1] ?? '');
const UNDER_TEST = process.env.NODE_ENV === 'test'
  || /[._](test|spec)\.[cm]?[jt]sx?$/.test(entry)          // bun also discovers *_test.* / *_spec.*
  || /[\/](tests|__tests__)[\/]/.test(entry)
  || /[\/]scripts[\/]seed-test[^\/]*$/.test(entry)
  || process.env.ARRA_TEST_ISOLATION === '1'
  || underBunTestCmdline();

// Linux (the whole fleet): bun keeps argv identical to `bun run`, but /proc/self/cmdline is
// not rewritten — `bun test ./x.ts` → ["bun","test","./x.ts"] (ferris, 1 Nov 2026). Covers a
// non-suffixed file + preset NODE_ENV + cwd without bunfig. A script whose first arg is the
// literal "test" would be isolated by mistake — the fail-closed direction.
function underBunTestCmdline(): boolean {
  try {
    const parts = require('node:fs').readFileSync('/proc/self/cmdline', 'utf8').split('\0');
    return parts[1] === 'test';
  } catch { return false; }
}

if (UNDER_TEST && !g[FLAG]) {
  g[FLAG] = true;
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const tmpRoot = real(tmpdir());
  const inTmp = (p?: string) => !!p && (real(p) === tmpRoot || real(p).startsWith(tmpRoot + '/'));

  if (!inTmp(process.env.ORACLE_DATA_DIR)) {
    const was = process.env.ORACLE_DATA_DIR ?? '(unset → ~/.oracle)';
    process.env.ORACLE_DATA_DIR = mkdtempSync(join(tmpdir(), 'arra-test-data-'));
    console.error(`[test-isolation] ORACLE_DATA_DIR ${was} → ${process.env.ORACLE_DATA_DIR}`);
  }
  for (const k of ['ORACLE_DB_PATH', 'ORACLE_REPO_ROOT'] as const) {
    if (process.env[k] && !inTmp(process.env[k])) delete process.env[k];
  }

  if (process.env.ARRA_TEST_ALLOW_LIVE_PORTS !== '1') {
    const BLOCKED = new Set(['47778', '8081']);
    const realFetch = globalThis.fetch;
    const urlOf = (input: any): string =>
      typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? '';
    globalThis.fetch = (async (input: any, init?: any) => {
      let port = '';
      try { port = new URL(urlOf(input)).port; } catch { /* not a URL — let fetch decide */ }
      if (BLOCKED.has(port)) {
        throw new Error(`[test-isolation] refusing fetch to port ${port} (live brain/vector). Stop the live services and set ARRA_TEST_ALLOW_LIVE_PORTS=1 to run HTTP contract tests.`);
      }
      return realFetch(input, init);
    }) as typeof fetch;
  }
}
