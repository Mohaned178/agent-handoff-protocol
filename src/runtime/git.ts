import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Runs git without a shell and returns its trimmed stdout. */
export async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout.trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`, { cause: error });
  }
}

/**
 * Runs git without a shell and returns the SHA-256 (lowercase hex) of its stdout, byte for byte. The output is
 * streamed into the hash, never decoded as text, so binary content and trailing newlines count.
 */
export async function gitStdoutSha256(cwd: string, args: string[]): Promise<string> {
  const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const hash = createHash("sha256");
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => hash.update(chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
  return hash.digest("hex");
}
