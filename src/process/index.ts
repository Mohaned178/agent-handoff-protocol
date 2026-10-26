// The shared process layer: every adapter starts its coding agent through it. It resolves the real executable (never
// a `.cmd` shim through a shell), passes the prompt on stdin, and stops the agent's whole process tree.

export { ExecutableNotFoundError, resolveExecutable, type Executable, type ResolveOptions } from "./resolve.ts";
export { launch, type LaunchedProcess, type LaunchOptions, type ProcessExit } from "./launch.ts";
export { terminateTree, type TerminateOptions, type Termination } from "./tree.ts";
