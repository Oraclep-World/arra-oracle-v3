/**
 * Hybrid blend of the fts and vector legs (issue #4).
 *
 * Default `fused`: the legacy formula, but fts rows are scored by their fused
 * RRF score (k=60 over the main/trigram/Thai legs, normalised so the best row
 * = 1) instead of `1/(1+|bm25|)`, which is tiny and let vector rows outrank
 * strong keyword hits. `ARRA_HYBRID_BLEND=legacy` runs the old blend unchanged.
 * Empty fts or empty vector list ⇒ always the legacy path, so fts-only and
 * vector-only modes keep byte-for-byte the same order.
 */
import type { SearchResult } from './types.ts';

export type HybridBlend = 'fused' | 'legacy';

/** Read per call so the switch can be flipped without a code change. */
export function hybridBlendMode(env: Record<string, string | undefined> = process.env): HybridBlend {
  return env.ARRA_HYBRID_BLEND?.trim() === 'legacy' ? 'legacy' : 'fused';
}

const clamp01 = (n: number | undefined) => Math.max(0, Math.min(1, n ?? 0));

/** Original blend: 0.7×score+0.3×1/(rank+1) for fts, 0.65/0.35 for vector, +0.12 overlap. */
export function combineLegacy(fts: SearchResult[], vector: SearchResult[]): SearchResult[] {
  const seen = new Map<string, SearchResult>();
  const addScore = (base: number | undefined, rank: number, scoreWeight: number, rankWeight: number) =>
    clamp01(base) * scoreWeight + (1 / (rank + 1)) * rankWeight;

  fts.forEach((r, index) => {
    seen.set(r.id, { ...r, score: addScore(r.score, index, 0.7, 0.3) });
  });
  vector.forEach((r, index) => {
    const vectorScore = addScore(r.score, index, 0.65, 0.35);
    const existing = seen.get(r.id);
    if (existing) {
      seen.set(r.id, {
        ...existing,
        score: Math.min(1, (existing.score || 0) + vectorScore + 0.12),
        source: 'hybrid' as const,
        distance: r.distance,
        model: r.model,
      });
    } else {
      seen.set(r.id, { ...r, score: vectorScore });
    }
  });
  return Array.from(seen.values()).sort((a, b) => (b.score || 0) - (a.score || 0));
}

/**
 * `ftsFused`: fts row id → fused (RRF over the fts legs) score normalised to 0..1.
 */
export function combineSearchResults(
  fts: SearchResult[],
  vector: SearchResult[],
  ftsFused: Map<string, number> = new Map(),
  mode: HybridBlend = hybridBlendMode(),
): SearchResult[] {
  if (mode === 'legacy' || fts.length === 0 || vector.length === 0) return combineLegacy(fts, vector);
  return combineLegacy(fts.map((r) => ({ ...r, score: ftsFused.get(r.id) ?? r.score })), vector);
}
