/** One page of `items`: `page` counts from 1. */
export function paginate(items, page, pageSize) {
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  return {
    items: items.slice(start, end),
    total: items.length,
    page,
    pageSize,
    hasMore: end < items.length,
  };
}
