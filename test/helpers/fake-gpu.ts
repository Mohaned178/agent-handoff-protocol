// A fake `nvidia-smi` and a fake `docker` for the bench's tests, installed with `installFakeTool`. They print fixed
// figures; nothing they print is a measurement.

import { installFakeTool } from "./fake-tools.ts";

export const FAKE_GPU = { name: "NVIDIA GeForce RTX 4060 Laptop GPU", memoryTotalMiB: 8188, driver: "566.03", idleMemoryMiB: 5012 };

/**
 * The lines the sampling `nvidia-smi` prints, in turn, one every 50 ms until it is killed: utilization (%), memory used
 * (MiB), power (W). The second line reports no power, as some GPUs do.
 */
export const FAKE_GPU_LINES = ["30, 5100, 50.00", "50, 5300, [N/A]", "40, 5200, 70.00"];

/**
 * `nvidia-smi`: the fingerprint query (`name,memory.total,driver_version`), the idle query (`memory.used` once) and the
 * sampling loop (`-lms`).
 */
export function installFakeNvidiaSmi(dir: string, log: string): void {
  installFakeTool(
    dir,
    log,
    "nvidia-smi",
    `const query = (argv.find((arg) => arg.startsWith("--query-gpu=")) || "").slice("--query-gpu=".length);
  if (argv.includes("-lms")) {
    const lines = ${JSON.stringify(FAKE_GPU_LINES)};
    let i = 0;
    const tick = () => { process.stdout.write(lines[i % lines.length] + "\\n"); i += 1; };
    tick();
    setInterval(tick, 50);
  } else if (query === "name,memory.total,driver_version") {
    process.stdout.write(${JSON.stringify(`${FAKE_GPU.name}, ${FAKE_GPU.memoryTotalMiB}, ${FAKE_GPU.driver}\n`)});
  } else if (query === "memory.used") {
    process.stdout.write("${FAKE_GPU.idleMemoryMiB}\\n");
  } else {
    process.exitCode = 6;
  }`,
  );
}

/** `docker stats --no-stream --format {{json .}} <container>`: one JSON line, for a container named `ahp-vllm` only. */
export function installFakeDocker(dir: string, log: string): void {
  installFakeTool(
    dir,
    log,
    "docker",
    `if (argv[0] === "stats" && argv.at(-1) === "ahp-vllm") {
    process.stdout.write(JSON.stringify({ Name: "ahp-vllm", CPUPerc: "12.50%", MemUsage: "1.5GiB / 15.5GiB" }) + "\\n");
  } else {
    process.exitCode = 1;
  }`,
  );
}
