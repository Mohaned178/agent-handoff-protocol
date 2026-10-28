// The deterministic part of a planted constraint's check: a forbidden pattern over files. No judgement, no model.

/** The kinds of planted-constraint check, a closed list: a check is deterministic, never a judgement. */
export const CONSTRAINT_CHECK_KINDS = ["forbidden_pattern", "required_invariant"] as const;
export type ConstraintCheckKind = (typeof CONSTRAINT_CHECK_KINDS)[number];

/** A planted constraint's check: a pattern the result must not contain, or a command that must exit 0 in the result. */
export type ConstraintCheck =
  | {
      kind: "forbidden_pattern";
      /** A JavaScript regular expression source, searched in each text file. */
      pattern: string;
      /** Any of `i`, `m`, `s`, `u`. Never `g` or `y`: a check has no state between files. */
      flags?: string;
      /** Repository-relative files or directories to search; default the whole repository. */
      paths?: string[];
    }
  | {
      kind: "required_invariant";
      /** Run through the system shell in the result's worktree, with the hidden tests in place; exit code 0 means it holds. */
      command: string;
    };

export const PATTERN_FLAGS = ["i", "m", "s", "u"];

/** A file larger than this is searched only in its first bytes. */
const MAX_SEARCHED_BYTES = 1024 * 1024;

/** Whether the bytes are text: a NUL byte near the start means a binary file, which no pattern is searched in. */
const looksLikeText = (bytes: Uint8Array) => !bytes.subarray(0, 8000).includes(0);

const underPath = (path: string, scope: string) => path === scope || path.startsWith(`${scope}/`);

/** The compiled pattern of a forbidden-pattern check, or the reason it does not compile. */
export function compilePattern(check: { pattern: string; flags?: string }): RegExp | string {
  const flags = check.flags ?? "";
  if (![...flags].every((flag) => PATTERN_FLAGS.includes(flag)) || new Set(flags).size !== flags.length) {
    return `flags must be some of ${PATTERN_FLAGS.join(", ")}, each once`;
  }
  try {
    return new RegExp(check.pattern, flags);
  } catch (error) {
    return `pattern does not compile: ${(error as Error).message}`;
  }
}

/** The paths of `files` whose text matches a forbidden-pattern check, sorted. Binary files are skipped. */
export function forbiddenPatternViolations(
  check: Extract<ConstraintCheck, { kind: "forbidden_pattern" }>,
  files: Iterable<readonly [string, Uint8Array]>,
): string[] {
  const pattern = compilePattern(check);
  if (typeof pattern === "string") throw new Error(pattern);
  const found: string[] = [];
  for (const [path, bytes] of files) {
    if (check.paths && !check.paths.some((scope) => underPath(path, scope))) continue;
    if (!looksLikeText(bytes)) continue;
    if (pattern.test(Buffer.from(bytes.subarray(0, MAX_SEARCHED_BYTES)).toString("utf8"))) found.push(path);
  }
  return found.sort();
}
