/**
 * Shared helper for tests that spawn a REAL HTTP server (`bun src/server.ts`).
 *
 * Why this exists — the false-red problem (found 2026-07-30 by ora101 while
 * cold-verifying an unrelated change):
 *
 *   Five proxy tests each carried an identical copy of `waitForHealth` that
 *   polled 60 × 250ms = 15s and then threw "server did not become healthy".
 *   Run alone they pass in <1s. Run as part of the 49-file suite — five real
 *   servers booting while everything else competes for CPU — the health poll
 *   ran out and they failed. The message named neither cause, so a red suite
 *   looked exactly like a broken proxy: a false red, the mirror image of the
 *   false greens this codebase keeps hunting.
 *
 * So the fix is NOT merely "wait longer". A failure here must say which of two
 * very different things happened:
 *
 *   1. the server process DIED  → a real bug; print its stderr and fail fast
 *      (no point waiting out the clock for a process that no longer exists)
 *   2. the process is ALIVE but slow to answer → resource contention; say so,
 *      with the load average and elapsed time, so nobody reads it as a bug
 *
 * Keeping one copy also means the next fix lands everywhere at once — the five
 * copies were how a 15s ceiling ended up in five files nobody thought to change
 * together.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const repoRoot = resolve(import.meta.dir, '../../../..');

/** Load average as a plain string — evidence that a timeout was contention, not a hang. */
function loadAvg(): string {
  try {
    const [one, five] = readFileSync('/proc/loadavg', 'utf-8').trim().split(/\s+/);
    return `load ${one} (5m ${five})`;
  } catch {
    return 'load unknown';
  }
}

export interface SpawnedServer {
  proc: ReturnType<typeof Bun.spawn>;
  port: number;
  baseUrl: string;
}

/**
 * Pick a port the OS says is free right now.
 *
 * The previous `49600 + random(300)` could collide with a lingering TIME_WAIT
 * socket or a parallel test, and EADDRINUSE surfaced later as the same
 * uninformative health timeout.
 */
export function freePort(): number {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

/** Spawn `bun src/server.ts` on a free port with the given env overrides. */
export function spawnTestServer(env: Record<string, string>): SpawnedServer {
  const port = freePort();
  const proc = Bun.spawn(['bun', 'src/server.ts'], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ORACLE_PORT: String(port), ...env },
  });
  return { proc, port, baseUrl: `http://127.0.0.1:${port}` };
}

/**
 * Wait until the server answers /api/health.
 *
 * Fails fast with the child's own stderr when the process died; otherwise waits
 * up to `timeoutMs` and, on giving up, reports contention explicitly.
 */
export async function waitForHealth(
  server: SpawnedServer,
  { timeoutMs = 45_000 }: { timeoutMs?: number } = {},
): Promise<void> {
  const started = Date.now();
  const { proc, baseUrl } = server;

  while (Date.now() - started < timeoutMs) {
    // A dead child can never become healthy — surface the real error now.
    if (proc.exitCode !== null || proc.signalCode !== null) {
      const drain = async (s: unknown): Promise<string> => {
        // stdout/stderr are ReadableStream when spawned with 'pipe'; be defensive
        // so a diagnostics path can never itself throw and mask the real failure.
        if (!s || typeof s === 'number') return '';
        try {
          return await new Response(s as ReadableStream).text();
        } catch {
          return '';
        }
      };
      const stderr = await drain(proc.stderr);
      const stdout = await drain(proc.stdout);
      throw new Error(
        `test server exited (code=${proc.exitCode} signal=${proc.signalCode}) before becoming healthy — ` +
          `this is a real failure, not a slow machine.\n` +
          `--- server stderr ---\n${stderr.slice(-2000) || '(empty)'}\n` +
          `--- server stdout ---\n${stdout.slice(-1000) || '(empty)'}`,
      );
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      /* still booting */
    }
    await Bun.sleep(200);
  }

  throw new Error(
    `test server still alive but did not answer ${baseUrl}/api/health within ${timeoutMs}ms ` +
      `(${loadAvg()}). The process never crashed, so this is almost certainly resource ` +
      `contention from running the whole suite at once — re-run this file alone to confirm ` +
      `(bun test --isolate <this file>) before treating it as a code failure.`,
  );
}
