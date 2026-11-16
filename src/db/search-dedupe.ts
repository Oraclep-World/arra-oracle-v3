/**
 * One row per document in a result list (Nat's relic5 "fold duplicates").
 *
 * A long file is indexed as many chunks sharing one `source_file`. Input must
 * already be ranked best-first; the first chunk seen per file wins and later
 * chunks of the same file are dropped, so the list fills from the next
 * documents. Rows without a source_file are never folded (nothing to key on).
 */
export const RRF_K = 60;

/**
 * Reciprocal-rank fusion (k=60) over ranked lists — Nat's relic5 way (never
 * compare raw bm25 across indexes; fuse on rank). Each leg is sorted
 * best-first; fused score = sum over legs of 1/(k + rank), rank 1-based.
 * oracle_fts / _tri / _th have different tokenizers and bm25 scales, so raw
 * scores let one table drown the others. Ties keep earlier-leg order.
 */
export function rrfMerge<T extends { id: string }>(legs: T[][], k: number = RRF_K): T[] {
  const fused = new Map<string, { row: T; score: number }>();
  for (const leg of legs) {
    leg.forEach((row, i) => {
      const add = 1 / (k + i + 1);
      const cur = fused.get(row.id);
      if (cur) cur.score += add;
      else fused.set(row.id, { row, score: add });
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score).map((f) => f.row);
}

/** Fused RRF score per id, divided by the best one (top row = 1). */
export function rrfScoresNormalized(legs: Array<Array<{ id: string }>>, k: number = RRF_K): Map<string, number> {
  const sum = new Map<string, number>();
  for (const leg of legs) leg.forEach((row, i) => sum.set(row.id, (sum.get(row.id) ?? 0) + 1 / (k + i + 1)));
  const max = Math.max(0, ...sum.values());
  return new Map([...sum].map(([id, v]) => [id, max ? v / max : 0]));
}

export function dedupeBySourceFile<T extends { id: string; source_file?: string | null }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key = row.source_file ? `f:${row.source_file}` : `i:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}
