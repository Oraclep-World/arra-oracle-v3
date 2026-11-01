/**
 * bun test preload — never let the suite touch the live brain data dir.
 *
 * Why (1 Nov 2026, tinky + ferris): `.env` in this repo pins ORACLE_DATA_DIR to
 * the live ~/.oracle and bun auto-loads `.env` for `bun test`. ~/.oracle/ψ is a
 * symlink into the oracle-vault repo, so tests that call learn / write config
 * landed in the real vault and data dir: vector-server.json overwritten with a
 * fixture (vector search down 21:39:50–21:42:50 after the next restart), 8 + 2 +
 * 24 fixture lessons committed into oracle-vault by auto-sync (31 Jul ×7 runs,
 * 1 Nov), 550 MB backup/export sets, a peer-key.hex.
 *
 * Rule: if the RESOLVED data dir (or the target of its ψ) is the live one,
 * replace it with a fresh temp dir and say so on stderr. Explicit non-live
 * paths are left alone. Runs before any test file imports src/config.ts.
 */
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const real = (p: string): string => {
  try { return realpathSync(p); } catch { return resolve(p); }
};

const liveDir = real(join(homedir(), '.oracle'));
const livePsi = existsSync(join(liveDir, 'ψ')) ? real(join(liveDir, 'ψ')) : null;

function isLive(p: string | undefined): boolean {
  if (!p) return true; // unset → config.ts defaults to ~/.oracle
  const dir = real(p);
  if (dir === liveDir || dir.startsWith(liveDir + '/')) return true;
  const psi = join(dir, 'ψ');
  return livePsi !== null && existsSync(psi) && real(psi) === livePsi;
}

const before = process.env.ORACLE_DATA_DIR;
if (isLive(before)) {
  const tmp = mkdtempSync(join(tmpdir(), 'arra-test-data-'));
  process.env.ORACLE_DATA_DIR = tmp;
  process.env.ORACLE_REPO_ROOT = tmp;
  delete process.env.ORACLE_DB_PATH;
  console.error(`[test-isolation] ORACLE_DATA_DIR ${before ?? '(unset)'} is the live brain → using ${tmp}`);
}
if (process.env.ORACLE_REPO_ROOT && isLive(process.env.ORACLE_REPO_ROOT)) {
  process.env.ORACLE_REPO_ROOT = process.env.ORACLE_DATA_DIR;
}

/**
 * Second leak path (same night): HTTP contract tests do "if a server already
 * answers on :47778, use it" — that server is the LIVE brain, so learn / menu /
 * thread tests wrote into it over HTTP (custom-menu.json, *-from-http-learn).
 * If the live server's pid (~/.oracle/oracle-http.pid) is alive, refuse fetches
 * to :47778 so those tests fail loudly instead of writing into the brain.
 * When the live server is down, tests spawn their own server (with the temp
 * data dir above) and the port is theirs.
 */
// Probe the port itself, not a pid file under homedir(): a pid-file check missed
// the live server when HOME differed, and 3 "yellow-http-test" fixtures reached
// the brain in the verification run (21:50:58). Anything answering at preload
// time was not started by this test run, so treat it as live.
function liveServerAlive(): boolean {
  const r = Bun.spawnSync(['curl', '-s', '-o', '/dev/null', '-m', '1', '-w', '%{http_code}', 'http://127.0.0.1:47778/']);
  const code = new TextDecoder().decode(r.stdout).trim();
  return code !== '' && code !== '000';
}
const LIVE_PORT = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):47778(\/|$)/;
if (liveServerAlive()) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? '';
    if (LIVE_PORT.test(url)) {
      throw new Error('[test-isolation] refusing to call the LIVE brain on :47778 — stop it (pm2 stop arra-oracle) or run HTTP tests on another machine');
    }
    return realFetch(input, init);
  }) as typeof fetch;
}
