// A unified diff as data, for the run screen's live diff and its full-diff view: the files, each with its lines and
// line numbers, binary files named and huge ones counted but not kept. Pure: the text comes from `git diff --no-color`.

export interface DiffLine {
  /** `+` added, `-` removed, ` ` context, `@` the start of a hunk (its text is git's context after the `@@`). */
  sign: "+" | "-" | " " | "@";
  /** The line's number in the file before (removed, context) or after (added, context) the change; null for `@`. */
  number: number | null;
  text: string;
}

export interface DiffFile {
  path: string;
  change: "added" | "modified" | "deleted";
  /** Lines added and removed; null for a binary file. */
  added: number | null;
  removed: number | null;
  binary: boolean;
  /** True when the file's diff has more lines than are kept: it is counted, named and not shown. */
  huge: boolean;
  /** Empty for a binary or huge file. */
  lines: DiffLine[];
  /** When the file last changed (ms since the epoch), when known: the live diff lists files in that order. */
  changedAt: number | null;
}

/** A file whose diff runs past this many lines is too large to show. */
export const MAX_FILE_DIFF_LINES = 5_000;
/** A line longer than this is cut (a minified file has one very long line). */
export const MAX_LINE_CHARS = 400;

const cutLine = (text: string) => (text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text);

/** A path as git prints it: unquoted, or quoted C-style when it holds unusual characters. */
function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const bytes: number[] = [];
  const body = path.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const next = body[i + 1] ?? "";
    if (/[0-7]/.test(next)) {
      bytes.push(Number.parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
      continue;
    }
    bytes.push(({ n: 10, t: 9, '"': 34, "\\": 92 } as Record<string, number>)[next] ?? next.charCodeAt(0));
    i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** The path of a `diff --git a/P b/P` header, which with renames off names the same path twice. */
function headerPath(rest: string): string {
  if (rest.startsWith('"')) {
    const end = rest.indexOf('" ');
    return unquote(rest.slice(0, end + 1)).replace(/^a\//, "");
  }
  return rest.slice(2, (rest.length - 1) / 2);
}

const sidePath = (line: string) => {
  const path = unquote(line.slice(4).replace(/\t.*$/, ""));
  return path === "/dev/null" ? null : path.replace(/^[ab]\//, "");
};

/** The files of `git diff` output, in its order. Anything before the first `diff --git` line is ignored. */
export function parseUnifiedDiff(text: string, maxFileLines = MAX_FILE_DIFF_LINES): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let kept = 0;
  const keep = (line: DiffLine) => {
    if (!file || file.huge) return;
    if (kept >= maxFileLines) {
      file.huge = true;
      file.lines = [];
      return;
    }
    file.lines.push(line);
    kept += 1;
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = { path: headerPath(line.slice("diff --git ".length)), change: "modified", added: 0, removed: 0, binary: false, huge: false, lines: [], changedAt: null };
      files.push(file);
      inHunk = false;
      kept = 0;
      continue;
    }
    if (!file) continue;
    if (!inHunk) {
      if (line.startsWith("new file mode")) file.change = "added";
      else if (line.startsWith("deleted file mode")) file.change = "deleted";
      else if (line.startsWith("--- ")) {
        const path = sidePath(line);
        if (path !== null) file.path = path;
      } else if (line.startsWith("+++ ")) {
        const path = sidePath(line);
        if (path !== null) file.path = path;
      } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
        file.binary = true;
        file.added = null;
        file.removed = null;
      }
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      keep({ sign: "@", number: null, text: cutLine(hunk[3] ?? "") });
      continue;
    }
    if (!inHunk || file.binary) continue;
    const sign = line[0];
    if (sign === "+") {
      file.added! += 1;
      keep({ sign: "+", number: newLine, text: cutLine(line.slice(1)) });
      newLine += 1;
    } else if (sign === "-") {
      file.removed! += 1;
      keep({ sign: "-", number: oldLine, text: cutLine(line.slice(1)) });
      oldLine += 1;
    } else if (sign === " ") {
      keep({ sign: " ", number: newLine, text: cutLine(line.slice(1)) });
      oldLine += 1;
      newLine += 1;
    }
    // "\ No newline at end of file" and anything else is not a line of the file.
  }
  return files;
}

/** An untracked file as the live diff shows it: every line added. Binary when it holds a NUL byte near its start. */
export function untrackedFile(path: string, content: Buffer, changedAt: number | null, maxFileLines = MAX_FILE_DIFF_LINES): DiffFile {
  const binary = content.subarray(0, 8000).includes(0);
  if (binary) return { path, change: "added", added: null, removed: null, binary: true, huge: false, lines: [], changedAt };
  const text = content.toString("utf8");
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const huge = lines.length > maxFileLines;
  return {
    path,
    change: "added",
    added: lines.length,
    removed: 0,
    binary: false,
    huge,
    lines: huge ? [] : [{ sign: "@", number: null, text: "" }, ...lines.map((line, index) => ({ sign: "+" as const, number: index + 1, text: cutLine(line.replace(/\r$/, "")) }))],
    changedAt,
  };
}
