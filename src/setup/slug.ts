/** A task's name for a branch and a workflow: its first five words, lowercase, joined with "-"; "task" when it has none. */
export function slugOf(goal: string): string {
  const words = goal.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.slice(0, 5).join("-") || "task";
}
