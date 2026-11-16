import { describe, expect, test } from 'bun:test';
import { combineLegacy, combineSearchResults, hybridBlendMode } from '../hybrid-blend.ts';
import { rrfScoresNormalized } from '../../db/search-dedupe.ts';
import type { SearchResult } from '../types.ts';

const row = (id: string, source: 'fts' | 'vector', score: number): SearchResult =>
  ({ id, type: 'learning', content: id, source_file: `${id}.md`, concepts: [], source, score });
const ids = (r: SearchResult[]) => r.map((x) => x.id);

describe('hybridBlendMode', () => {
  test('default is fused; legacy only on exact switch', () => {
    expect(hybridBlendMode({})).toBe('fused');
    expect(hybridBlendMode({ ARRA_HYBRID_BLEND: 'legacy' })).toBe('legacy');
    expect(hybridBlendMode({ ARRA_HYBRID_BLEND: 'nonsense' })).toBe('fused');
  });
});

describe('combineSearchResults', () => {
  // fts rank 1 has a tiny raw score (the bug); vector row has a high similarity.
  const fts = [row('kw', 'fts', 0.02), row('kw2', 'fts', 0.01)];
  const vec = [row('sem', 'vector', 0.85)];
  const fused = rrfScoresNormalized([fts]);

  test('legacy: vector row outranks a strong keyword hit', () => {
    expect(ids(combineSearchResults(fts, vec, fused, 'legacy'))[0]).toBe('sem');
  });
  test('fused: keyword rank 1 stays on top', () => {
    expect(ids(combineSearchResults(fts, vec, fused, 'fused'))[0]).toBe('kw');
  });
  test('fts-only and vector-only are identical to legacy in both modes', () => {
    for (const mode of ['fused', 'legacy'] as const) {
      expect(combineSearchResults(fts, [], fused, mode)).toEqual(combineLegacy(fts, []));
      expect(combineSearchResults([], vec, fused, mode)).toEqual(combineLegacy([], vec));
    }
  });
  test('overlap row is marked hybrid and keeps the vector distance', () => {
    const v = [{ ...row('kw', 'vector', 0.8), distance: 0.3 }];
    const top = combineSearchResults(fts, v, fused, 'fused')[0];
    expect(top.source).toBe('hybrid');
    expect(top.distance).toBe(0.3);
  });
});

describe('rrfScoresNormalized', () => {
  test('best row = 1, rows in two legs add up', () => {
    const m = rrfScoresNormalized([[{ id: 'a' }, { id: 'b' }], [{ id: 'b' }]]);
    expect(m.get('b')).toBe(1);
    expect(m.get('a')!).toBeLessThan(1);
  });
  test('empty input is an empty map', () => {
    expect(rrfScoresNormalized([]).size).toBe(0);
  });
});
