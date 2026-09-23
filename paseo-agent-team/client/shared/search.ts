export function filterByQuery<T>(
  items: readonly T[],
  query: string,
  haystack: (item: T) => string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...items];
  return items.filter((item) => haystack(item).toLowerCase().includes(needle));
}
