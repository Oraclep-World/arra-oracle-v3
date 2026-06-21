/**
 * CLI entrypoint for running the Oracle indexer.
 *
 * After the FTS5 reindex completes, vector embeddings are auto-populated when
 * the vector section is enabled (vector-server.json {enabled:true} or
 * ORACLE_VECTOR_ENABLED=1). This keeps `bun run index` a one-shot refresh of
 * both FTS5 and LanceDB. Opt out with ORACLE_SKIP_VECTOR_REINDEX=1.
 *
 * Vector embedding still runs through the canonical src/scripts/index-model.ts
 * path (replaceDocuments) — we shell out to it rather than duplicating logic.
 *
 * BEST-EFFORT: vector embedding must never fail the FTS5 reindex (which has
 * already succeeded by the time we get here). If GPU/ollama/LanceDB is down we
 * warn on one line and exit 0 — FTS5 search keeps working, semantic just goes
 * stale until the next successful run.
 */

import path from 'path';
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
  console.log(`\n[Auto-Vector] vector section enabled → populating "${model}" embeddings...`);
  const scriptPath = path.resolve(import.meta.dir, '../scripts/index-model.ts');
  // Best-effort: never let an embedding failure break the (already-complete) FTS
  // reindex. Warn + skip on any failure (GPU/ollama down, spawn error, etc.).
  try {
    // stdout inherited (live progress); stderr piped so a failure collapses to
    // one warn line instead of dumping the subprocess stack trace.
    const proc = Bun.spawn(['bun', scriptPath, model], { stdout: 'inherit', stderr: 'pipe' });
    const code = await proc.exited;
    if (code !== 0) {
      const errText = await new Response(proc.stderr).text();
      const lines = errText.split('\n').map(l => l.trim()).filter(Boolean);
      const reason =
        lines.filter(l => /^error:/i.test(l)).pop() ||
        lines.filter(l => /error|fail|unable|cannot/i.test(l)).pop() ||
        lines[0] ||
        `exit ${code}`;
      console.warn(
        `[Auto-Vector] embedding skipped (${reason}) — FTS index is valid; ` +
          `semantic search may be stale. Re-run: bun src/scripts/index-model.ts ${model}`
      );
      return;
    }
    console.log('[Auto-Vector] embeddings complete!');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[Auto-Vector] embedding skipped (${msg}) — FTS index is valid; ` +
        `semantic search may be stale. Re-run: bun src/scripts/index-model.ts ${model}`
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
