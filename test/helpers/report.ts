import type { DoctorReport, ToolReport } from "../../src/doctor/doctor.ts";
import { TOOLS, type ToolId } from "../../src/doctor/tools.ts";

export type ToolStatus = "ready" | "logged_out" | "missing";

/** A doctor report with each tool as stated: usable and logged in, installed but logged out, or not installed. */
export function reportOf(status: Record<ToolId, ToolStatus>): DoctorReport {
  const tools = TOOLS.map((tool): ToolReport => {
    const state = status[tool.id];
    const adapter = { name: tool.adapter, transport: "stdio_jsonl", modelReporting: "reported", login: "tool_login", capabilities: [], network: [] } as unknown as ToolReport["adapter"];
    if (state === "missing") return { id: tool.id, name: tool.name, command: tool.command, installed: false, path: null, version: null, problem: "not found", login: { state: "unknown", detail: "not installed" }, adapter, usable: false };
    return {
      id: tool.id,
      name: tool.name,
      command: tool.command,
      installed: true,
      path: `/usr/bin/${tool.command}`,
      version: `${tool.id} 1.0.0`,
      problem: null,
      login: state === "ready" ? { state: "logged_in", detail: "ok" } : { state: "not_logged_in", detail: "no" },
      adapter,
      usable: state === "ready",
    };
  });
  return { system: { os: { platform: "linux", release: "1", label: "linux-wsl2", supported: true }, node: { version: "24.0.0", required: "24 or newer", meets: true }, git: { version: "2.50.0", required: "2.20 or newer", meets: true, detail: null } }, tools, ok: true };
}
