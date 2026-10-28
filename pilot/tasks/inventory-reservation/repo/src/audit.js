/** An append-only log: `record(entry)` adds `{ seq, ...entry }`, `entries()` returns copies of everything recorded. */
export function createAudit() {
  const log = [];
  return {
    record(entry) {
      log.push({ seq: log.length + 1, ...entry });
    },
    entries() {
      return log.map((entry) => ({ ...entry }));
    },
  };
}
