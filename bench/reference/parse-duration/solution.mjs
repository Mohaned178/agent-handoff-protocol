export function parseDuration(text) {
  const match = /^(?:(\d+)d)?\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/.exec(String(text).trim());
  if (!match || match.slice(1).every((part) => part === undefined)) throw new Error("not a duration");
  const [d, h, m, s] = match.slice(1).map((part) => Number(part ?? 0));
  return d * 86400 + h * 3600 + m * 60 + s;
}
