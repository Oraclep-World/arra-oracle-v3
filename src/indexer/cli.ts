/**
 * CLI entrypoint for running the Oracle indexer.
 *
 * After the FTS5 reindex completes, vector embeddings are auto-populated when
 * the vector section is enabled (vector-server.json {enabled:true} or
 * ORACLE_VECTOR_ENABLED=1). This keeps `bun run index` a one-shot refresh of
 * both FTS5 and LanceDB. Opt out with ORACLE_SKIP_VECTOR_REINDEX=1.
 *
 * Vector embedding runs through the vector server's atomic rebuild
 * (POST /api/vector/index/start {source:sqlite} → rebuildCollection): it embeds
 * every doc then swaps the collection ONCE (no mid-run partial state) and reads
 * the embedding provider from the server config. We do NOT shell out to
 * src/scripts/index-model.ts — that path hardcodes provider=ollama (wipes on a
 * non-ollama/CF node) and replaces batch-0 then appends (a mid-run crash leaves
 * the collection truncated, not merely stale).
 *
 * BEST-EFFORT: vector embedding must never fail the FTS5 reindex (which has
 * already succeeded by the time we get here). If the vector server is down or
 * the job errors, we warn on one line and exit 0 — FTS5 search keeps working,
 * semantic embeddings just stay unchanged until the next successful run.
 */

import { runOracleReindex } from './runner.ts';
import { isVectorSectionEnabled, loadVectorConfig } from '../vector/config.ts';
import { ORACLE_DATA_DIR } from '../config.ts';
import { recordVectorOutcome, VECTOR_RUN_MARKER } from '../vector/run-marker.ts';

// This CLI takes NO arguments — running it IS the action (a full reindex).
// Two houses learned that the hard way five weeks apart (volt 2026-06-24,
// ora101 2026-07-30): both typed `--help` expecting usage text and kicked off
// a real reindex, because every argv was silently ignored. Refuse instead.
if (import.meta.main && process.argv.slice(2).length > 0) {
  console.error(
    `oracle-index takes no arguments (got: ${process.argv.slice(2).join(' ')})\n\n` +
      `  Running this command IS the action: a full FTS5 reindex, then vector\n` +
      `  embedding when the vector section is enabled. There are no flags —\n` +
      `  "--help" and friends used to start a real reindex silently.\n\n` +
      `  usage: bun src/indexer/cli.ts        (or: bun run index)\n` +
      `  env:   ORACLE_SKIP_VECTOR_REINDEX=1  skip the vector step\n` +
      `         ORACLE_VECTOR_ENABLED=1       force the vector step on`
  );
  process.exit(1);
}

/**
 * The BEST-EFFORT posture below is correct (a dead vector server must not fail
 * an FTS reindex that already succeeded), but it once left a single console.warn
 * as the ONLY trace — and under cron nobody reads stdout. Result: FTS stayed
 * fresh while embeddings silently rotted for an unknown number of days (found
 * 2026-07-30: config pointed at a port nothing listened on).
 *
 * The fix is not "fail louder" — it is leaving a fact on disk that the watchdog
 * and dashboard can read. That writer lives in ../vector/run-marker.ts and is
 * shared with the HTTP route, because the cron path goes through the route, not
 * through this CLI.
 */

/** One loud, greppable line + the marker — used by every non-ok exit path. */
function warnVector(detail: string, hint?: string): void {
  recordVectorOutcome('skipped', detail, 'cli');
  console.warn(
    `\n[Auto-Vector] ⚠️  VECTOR EMBEDDINGS NOT UPDATED — ${detail}\n` +
      `  FTS5 search is valid and fresh; semantic/vector results are STALE until a successful run.\n` +
      (hint ? `  ${hint}\n` : '') +
      `  recorded: ${VECTOR_RUN_MARKER}`
  );
}

/** Primary embedding-model key from vector config (the collection with primary:true), default bge-m3. */
function primaryModelKey(): string {
  const cfg = loadVectorConfig();
  if (cfg?.collections) {
    for (const [key, col] of Object.entries(cfg.collections)) {
      if (col?.primary) return key;
    }
  }
  return 'bge-m3';
}

interface IndexStatus {
  jobId?: string;
  status?: string;
  current?: number;
  total?: number;
  error?: string;
}

/** Exported for tests: the vector step alone, without the FTS reindex in front of it. */
export async function autoIndexVectors(): Promise<void> {
  if (!isVectorSectionEnabled()) {
    console.log(
      '(vector section disabled — skipping auto-embed. Enable via vector-server.json {enabled:true} or ORACLE_VECTOR_ENABLED=1)'
    );
    return;
  }
  if (process.env.ORACLE_SKIP_VECTOR_REINDEX === '1') {
    console.log('(ORACLE_SKIP_VECTOR_REINDEX=1 — skipping auto-embed)');
    return;
  }

  const model = primaryModelKey();
  const port = loadVectorConfig()?.port ?? 8081;
  const base = `http://127.0.0.1:${port}/api`;
  const startUrl = `${base}/vector/index/start`;
  const statusUrl = `${base}/vector/index/status`;

  console.log(`\n[Auto-Vector] vector section enabled → embedding "${model}" via vector server (:${port})...`);

  // Preflight: prove something is actually listening before firing the job.
  // Without this, a config port that nothing serves produced a generic
  // "Unable to connect" — true but useless, since it named neither the port
  // nor the config file that chose it (the 2026-07-30 drift took a human
  // reading `ss -ltnp` to find). Cheap GET, and it fails informatively.
  try {
    const ping = await fetch(statusUrl);
    if (!ping.ok) throw new Error(`HTTP ${ping.status}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnVector(
      `no vector server answering on port ${port} (${msg})`,
      `port ${port} comes from vector-server.json ("port") in ${ORACLE_DATA_DIR} — ` +
        `check who is actually listening: ss -ltnp | grep -E '${port}|LISTEN'`
    );
    return;
  }

  try {
    const res = await fetch(startUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, source: 'sqlite' }),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200) || `HTTP ${res.status}`;
      warnVector(`vector server rejected the job (${res.status}: ${detail})`,
                 `retry: POST ${startUrl} {"source":"sqlite"}`);
      return;
    }
    const started = (await res.json()) as IndexStatus;

    // The start endpoint is fire-and-forget; poll until the job reaches a
    // terminal state so `bun run index` stays a one-shot refresh of BOTH FTS
    // and vectors. Bail only on a real signal — the server going unreachable
    // mid-run — never on an arbitrary timeout.
    let lastReported = -1;
    let unreachable = 0;
    for (;;) {
      await Bun.sleep(2000);
      let status: IndexStatus;
      try {
        const sres = await fetch(statusUrl);
        if (!sres.ok) throw new Error(`HTTP ${sres.status}`);
        status = (await sres.json()) as IndexStatus;
        unreachable = 0;
      } catch {
        if (++unreachable >= 3) {
          recordVectorOutcome('unknown', 'vector server became unreachable mid-run', 'cli');
          console.warn(
            `\n[Auto-Vector] ⚠️  VECTOR STATE UNKNOWN — server became unreachable mid-run.\n` +
              `  FTS5 is valid; vector state may be PARTIAL (the rebuild swaps atomically, so it is\n` +
              `  most likely still the previous collection — verify rather than assume).\n` +
              `  check: GET ${statusUrl}\n  recorded: ${VECTOR_RUN_MARKER}`
          );
          return;
        }
        continue;
      }

      // A different job replaced ours (concurrent reindex) — stop watching.
      if (started.jobId && status.jobId && status.jobId !== started.jobId) {
        warnVector(`a different index job took over (${status.jobId}) — stopped waiting`,
                   `check: GET ${statusUrl}`);
        return;
      }

      if (status.total && status.current !== lastReported) {
        lastReported = status.current ?? -1;
        console.log(`  [Auto-Vector] ${status.current}/${status.total} embedded...`);
      }

      if (status.status === 'completed') {
        recordVectorOutcome('ok', `${status.total ?? '?'} docs via ${model} on :${port}`, 'cli');
        console.log('[Auto-Vector] embeddings complete!');
        return;
      }
      if (status.status === 'error') {
        warnVector(`the embedding job failed (${status.error ?? 'unknown'})`,
                   `retry: POST ${startUrl} {"source":"sqlite"}`);
        return;
      }
      if (status.status === 'stopped') {
        warnVector('the embedding job was stopped by an operator');
        return;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnVector(msg, `ensure the vector server is running, then retry: POST ${startUrl} {"source":"sqlite"}`);
  }
}

// Guarded so tests can import autoIndexVectors without kicking off a reindex —
// importing this file used to BE the action, the same footgun as the argv one.
if (import.meta.main) {
  runOracleReindex()
    .then(async () => {
      console.log('Indexing complete!');
      await autoIndexVectors();
    })
    .catch(err => {
      console.error('Indexing failed:', err);
      process.exit(1);
    });
}
