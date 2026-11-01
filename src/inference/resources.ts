// What a workload used, sampled at one interval while it runs: the GPU through `nvidia-smi`, the whole machine through Node's
// `os`, and an engine's container through `docker stats`. Every child process goes through the process layer, run from the
// temp directory, never the user's repository. A figure that could not be read is null with the reason, never a guess.

import { cpus, freemem, tmpdir, totalmem } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { osLabelOf, type OsLabel } from "../conformance/result.ts";
import { firstLine, probe } from "../doctor/probe.ts";
import { launch, resolveExecutable, type LaunchedProcess } from "../process/index.ts";

/** The peak and mean of a figure over the samples that had a value, and how many did. */
export interface Stat {
  peak: number;
  mean: number;
  samples: number;
}

export interface GpuFigures {
  source: "nvidia-smi";
  /** How many lines `nvidia-smi` printed while the workload ran. */
  samples: number;
  utilizationPercent: Stat | null;
  memoryUsedMiB: Stat | null;
  powerW: Stat | null;
}

/** The whole machine's, not the engine's: every other process is in these figures too. */
export interface HostFigures {
  source: "os";
  scope: "whole_machine";
  samples: number;
  /** `os.totalmem() - os.freemem()`. */
  memoryUsedBytes: Stat | null;
  /** Busy share of every core's time between two samples, from `os.cpus()`. */
  cpuPercent: Stat | null;
}

/** The engine's container's own figures, as `docker stats` reports them. */
export interface DockerFigures {
  source: "docker stats";
  container: string;
  samples: number;
  memoryUsedBytes: Stat | null;
  cpuPercent: Stat | null;
}

export interface Resources {
  /** Null when `nvidia-smi` could not be run or printed nothing; `gpuReason` says why. */
  gpu: GpuFigures | null;
  gpuReason: string | null;
  host: HostFigures;
  /** Null for an engine that is not a container, or when `docker stats` gave nothing; `dockerReason` says why. */
  docker: DockerFigures | null;
  dockerReason: string | null;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** The peak and mean of the values that are numbers; null when none is. */
export function statOf(values: readonly (number | null)[]): Stat | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return null;
  return { peak: Math.max(...present), mean: round(present.reduce((sum, value) => sum + value, 0) / present.length), samples: present.length };
}

/** A value as `nvidia-smi` prints it with `nounits`: `[N/A]`, `N/A` or anything else not a number is null. */
const smiNumber = (text: string | undefined): number | null => {
  const trimmed = (text ?? "").trim();
  return /^-?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : null;
};

const SMI_QUERY = ["--id=0", "--format=csv,noheader,nounits"];

/** Samples GPU 0 with `nvidia-smi -lms <interval>` until stopped. */
async function sampleGpu(env: NodeJS.ProcessEnv | undefined, intervalMs: number): Promise<{ stop: () => Promise<Pick<Resources, "gpu" | "gpuReason">> }> {
  let child: LaunchedProcess;
  try {
    const executable = await resolveExecutable("nvidia-smi", { env });
    child = await launch({ executable, args: [...SMI_QUERY, "--query-gpu=utilization.gpu,memory.used,power.draw", "-lms", String(intervalMs)], cwd: tmpdir(), env });
  } catch (error) {
    const reason = (error as Error).message;
    return { stop: async () => ({ gpu: null, gpuReason: reason }) };
  }
  const rows: [number | null, number | null, number | null][] = [];
  let buffered = "";
  const onText = (text: string) => {
    buffered += text;
    let newline: number;
    while ((newline = buffered.indexOf("\n")) !== -1) {
      const fields = buffered.slice(0, newline).split(",");
      buffered = buffered.slice(newline + 1);
      if (fields.length === 3) rows.push([smiNumber(fields[0]), smiNumber(fields[1]), smiNumber(fields[2])]);
    }
  };
  const reading = (async () => {
    for await (const chunk of child.stdout as AsyncIterable<Buffer | string>) onText(chunk.toString());
  })().catch(() => undefined);
  const exited = child.exited.catch(() => null);
  return {
    stop: async () => {
      await child.terminate({ graceMs: 1_000 });
      await reading;
      const exit = await exited;
      if (rows.length === 0) {
        const how = exit ? `exited with code ${exit.exitCode ?? exit.signal}` : "could not be followed";
        return { gpu: null, gpuReason: `nvidia-smi printed no sample while the workload ran (it ${how})` };
      }
      return {
        gpu: {
          source: "nvidia-smi",
          samples: rows.length,
          utilizationPercent: statOf(rows.map((row) => row[0])),
          memoryUsedMiB: statOf(rows.map((row) => row[1])),
          powerW: statOf(rows.map((row) => row[2])),
        },
        gpuReason: null,
      };
    },
  };
}

/** Samples the whole machine's memory and CPU every `intervalMs` until stopped; memory once at the start, so a short workload has a figure. */
function sampleHost(intervalMs: number): { stop: () => HostFigures } {
  const memory: number[] = [totalmem() - freemem()];
  const busy: number[] = [];
  const times = () => cpus().reduce((sum, cpu) => ({ busy: sum.busy + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq, all: sum.all + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle }), { busy: 0, all: 0 });
  let last = times();
  const timer = setInterval(() => {
    memory.push(totalmem() - freemem());
    const next = times();
    const all = next.all - last.all;
    if (all > 0) busy.push(round(((next.busy - last.busy) / all) * 100));
    last = next;
  }, intervalMs);
  return {
    stop: () => {
      clearInterval(timer);
      return { source: "os", scope: "whole_machine", samples: memory.length, memoryUsedBytes: statOf(memory), cpuPercent: statOf(busy) };
    },
  };
}

const BYTE_UNITS: Record<string, number> = { B: 1, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };

/** `1.5GiB` (the first half of `docker stats`' `MemUsage`) in bytes; null for anything else. */
export function bytesOf(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([KMGT]i?B|B)$/i.exec(text.trim());
  const unit = match ? BYTE_UNITS[match[2]!.toUpperCase()] : undefined;
  return match && unit !== undefined ? Math.round(Number(match[1]) * unit) : null;
}

/** Runs `docker stats --no-stream` for the container over and over, no more often than every `intervalMs`, until stopped. */
function sampleDocker(container: string, env: NodeJS.ProcessEnv | undefined, intervalMs: number): { stop: () => Promise<Pick<Resources, "docker" | "dockerReason">> } {
  const memory: (number | null)[] = [];
  const cpu: (number | null)[] = [];
  let problem: string | null = null;
  let stopped = false;
  const halt = new AbortController();
  const loop = (async () => {
    while (!stopped) {
      const started = Date.now();
      const result = await probe("docker", ["stats", "--no-stream", "--format", "{{json .}}", container], { env, cwd: tmpdir(), timeoutMs: 10_000 });
      if (result.outcome === "exited" && result.exitCode === 0) {
        try {
          const stats = JSON.parse(firstLine(result.stdout, 4_096) ?? "") as { MemUsage?: unknown; CPUPerc?: unknown };
          memory.push(typeof stats.MemUsage === "string" ? bytesOf(stats.MemUsage.split("/")[0]!) : null);
          cpu.push(typeof stats.CPUPerc === "string" && /^\d+(\.\d+)?%$/.test(stats.CPUPerc.trim()) ? Number(stats.CPUPerc.trim().slice(0, -1)) : null);
        } catch {
          problem = "docker stats did not print JSON";
        }
      } else {
        problem = result.outcome === "exited" ? `docker stats ${container} exited with code ${result.exitCode}` : result.message;
        if (result.outcome === "not_found") return;
      }
      const left = intervalMs - (Date.now() - started);
      if (left > 0 && !stopped) await sleep(left, undefined, { signal: halt.signal }).catch(() => undefined);
    }
  })();
  return {
    stop: async () => {
      stopped = true;
      halt.abort();
      await loop;
      const figures = { memoryUsedBytes: statOf(memory), cpuPercent: statOf(cpu) };
      if (memory.length === 0) return { docker: null, dockerReason: `docker stats gave no figure for ${container}: ${problem ?? "the workload ended before the first answer"}` };
      return { docker: { source: "docker stats", container, samples: memory.length, ...figures }, dockerReason: null };
    },
  };
}

export interface SamplingOptions {
  env?: NodeJS.ProcessEnv;
  intervalMs: number;
  /** The engine's container, if it is one. */
  container?: string;
}

/** Starts sampling the GPU, the host and the container together, at one interval; `stop` ends all three and sums them up. */
export async function startSampling(options: SamplingOptions): Promise<{ stop: () => Promise<Resources> }> {
  const gpu = await sampleGpu(options.env, options.intervalMs);
  const host = sampleHost(options.intervalMs);
  const docker = options.container ? sampleDocker(options.container, options.env, options.intervalMs) : null;
  return {
    stop: async () => {
      const hostFigures = host.stop();
      const [gpuFigures, dockerFigures] = await Promise.all([gpu.stop(), docker?.stop() ?? Promise.resolve({ docker: null, dockerReason: "not a container: the bench file names none for this engine" })]);
      return { ...gpuFigures, host: hostFigures, ...dockerFigures };
    },
  };
}

/** GPU 0's memory in use right now, read once: taken before an engine's first request, so the model's own footprint is apart from what serving adds. */
export async function idleGpuMemory(env?: NodeJS.ProcessEnv): Promise<{ idleGpu: { memoryUsedMiB: number | null; source: "nvidia-smi" } | null; idleGpuReason: string | null }> {
  const result = await probe("nvidia-smi", [...SMI_QUERY, "--query-gpu=memory.used"], { env, cwd: tmpdir() });
  if (result.outcome !== "exited") return { idleGpu: null, idleGpuReason: result.message };
  if (result.exitCode !== 0) return { idleGpu: null, idleGpuReason: `nvidia-smi exited with code ${result.exitCode}` };
  return { idleGpu: { memoryUsedMiB: smiNumber(firstLine(result.stdout) ?? undefined), source: "nvidia-smi" }, idleGpuReason: null };
}

/** The machine a bench ran on, recorded once: engines are compared only within one fingerprint. */
export interface HardwareFingerprint {
  /** GPU 0 as `nvidia-smi` names it; null when it could not be read, with `gpuReason`. */
  gpu: { name: string; memoryTotalMiB: number | null; driver: string } | null;
  gpuReason: string | null;
  cpu: { model: string; cores: number };
  ramBytes: number;
  os: OsLabel;
}

export async function fingerprintOf(env?: NodeJS.ProcessEnv): Promise<HardwareFingerprint> {
  const processors = cpus();
  const machine = { cpu: { model: processors[0]?.model.trim() ?? "unknown", cores: processors.length }, ramBytes: totalmem(), os: osLabelOf(process.platform) };
  const result = await probe("nvidia-smi", [...SMI_QUERY, "--query-gpu=name,memory.total,driver_version"], { env, cwd: tmpdir() });
  if (result.outcome !== "exited") return { gpu: null, gpuReason: result.message, ...machine };
  const fields = (firstLine(result.stdout, 400) ?? "").split(",").map((field) => field.trim());
  if (result.exitCode !== 0 || fields.length !== 3 || fields[0] === "") {
    return { gpu: null, gpuReason: `nvidia-smi did not name the GPU (exit code ${result.exitCode})`, ...machine };
  }
  return { gpu: { name: fields[0]!, memoryTotalMiB: smiNumber(fields[1]), driver: fields[2]! }, gpuReason: null, ...machine };
}
