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

async function autoIndexVectors(): Promise<void> {
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

  try {
    const res = await fetch(startUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, source: 'sqlite' }),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200) || `HTTP ${res.status}`;
      console.warn(
        `[Auto-Vector] embedding skipped (vector server ${res.status}: ${detail}) — ` +
          `FTS index is valid; vector embeddings unchanged until the next successful run.`
      );
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
          console.warn(
            `[Auto-Vector] status unknown — vector server became unreachable mid-run; ` +
              `FTS index is valid, vector state may be incomplete. Check: GET ${statusUrl}`
          );
          return;
        }
        continue;
      }

      // A different job replaced ours (concurrent reindex) — stop watching.
      if (started.jobId && status.jobId && status.jobId !== started.jobId) {
        console.warn(
          `[Auto-Vector] a different index job is now running (${status.jobId}); ` +
            `stopped waiting — check: GET ${statusUrl}`
        );
        return;
      }

      if (status.total && status.current !== lastReported) {
        lastReported = status.current ?? -1;
        console.log(`  [Auto-Vector] ${status.current}/${status.total} embedded...`);
      }

      if (status.status === 'completed') {
        console.log('[Auto-Vector] embeddings complete!');
        return;
      }
      if (status.status === 'error') {
        console.warn(
          `[Auto-Vector] embedding failed (${status.error ?? 'unknown'}) — ` +
            `FTS index is valid; vector state may be incomplete. Retry: POST ${startUrl} {"source":"sqlite"}`
        );
        return;
      }
      if (status.status === 'stopped') {
        console.warn('[Auto-Vector] embedding stopped by operator — vector state may be incomplete.');
        return;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[Auto-Vector] embedding skipped (${msg}) — FTS index is valid; semantic search unchanged. ` +
        `Ensure the vector server is running, then retry: POST ${startUrl} {"source":"sqlite"}`
    );
  }
}

runOracleReindex()
  .then(async () => {
    console.log('Indexing complete!');
    await autoIndexVectors();
  })
  .catch(err => {
    console.error('Indexing failed:', err);
    process.exit(1);
  });
