/**
 * Durable record of how the last vector-embedding run ended.
 *
 * Why a file and not the in-memory job status: `/api/vector/index/status` lives
 * in `currentJob` (src/routes/vector/indexer.ts), so every server restart erases
 * it. After two restarts on 2026-07-30 the question "when did embeddings last
 * succeed?" had no answer anywhere — while FTS kept looking perfectly fresh.
 *
 * This module is the single writer for that fact, shared by BOTH paths that can
 * finish a vector run:
 *   - `src/indexer/cli.ts`          (bun run index — the one-shot refresh)
 *   - `src/routes/vector/indexer.ts` (POST /api/vector/index/start — what the
 *     every-3-hours cron actually calls via ~/.oracle/vector-reindex.sh)
 *     (cron spec written out, not pasted: a bare star-slash would close this
 *     comment block mid-sentence — which is exactly how this file first broke)
 *
 * It is shared rather than copied on purpose: the first version of this marker
 * lived only in cli.ts, so the cron path — the one that runs unattended, where
 * silence costs the most — wrote nothing at all. Copies drift; a single writer
 * cannot.
 */

import fs from 'fs';
import path from 'path';
import { ORACLE_DATA_DIR } from '../config.ts';

/** Where the outcome is recorded. Read by watchdogs/dashboards, not by app logic. */
export const VECTOR_RUN_MARKER = path.join(ORACLE_DATA_DIR, 'vector-last-run.json');

export type VectorOutcome = 'ok' | 'skipped' | 'unknown';

export interface VectorRunRecord {
  outcome: VectorOutcome;
  detail: string | null;
  at: number;
  /** Which path finished the run — tells an operator where to look next. */
  via?: 'cli' | 'api';
}

/**
 * Write the outcome of a vector run.
 *
 * Never throws: this is diagnostics. A failure here must not add a second
 * failure on top of whatever it was trying to report.
 */
export function recordVectorOutcome(
  outcome: VectorOutcome,
  detail?: string,
  via: 'cli' | 'api' = 'cli',
): void {
  try {
    fs.mkdirSync(ORACLE_DATA_DIR, { recursive: true });
    const record: VectorRunRecord = {
      outcome,
      detail: detail?.slice(0, 400) ?? null,
      at: Date.now(),
      via,
    };
    fs.writeFileSync(VECTOR_RUN_MARKER, JSON.stringify(record, null, 2), 'utf-8');
  } catch {
    /* diagnostics must never break the run */
  }
}

/** Read the last recorded outcome, or null when nothing has been recorded yet. */
export function readVectorOutcome(): VectorRunRecord | null {
  try {
    return JSON.parse(fs.readFileSync(VECTOR_RUN_MARKER, 'utf-8')) as VectorRunRecord;
  } catch {
    return null;
  }
}
