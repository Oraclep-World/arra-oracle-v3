/**
 * One row per document in a result list (Nat's relic5 "fold duplicates").
 *
 * A long file is indexed as many chunks sharing one `source_file`. Input must
 * already be ranked best-first; the first chunk seen per file wins and later
 * chunks of the same file are dropped, so the list fills from the next
 * documents. Rows without a source_file are never folded (nothing to key on).
 */
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
