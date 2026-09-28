import { spawn } from "node:child_process";

const target = process.argv[2];
if (!target || target === "dev" || target === "start") {
  throw new Error("Usage: node scripts/process-watchdog.mjs <npm-script>");
}

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("The watchdog must be started through npm");
}
let child = null;
let stopping = false;
let failures = 0;
const baseDelayMs = 1_000;
const maxDelayMs = 30_000;

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function stop(signal) {
  if (stopping) return;
  stopping = true;
  if (child && !child.killed) child.kill(signal);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

while (!stopping) {
  const startedAt = Date.now();
  child = spawn(process.execPath, [npmCli, "run", target], {
    stdio: "inherit",
    windowsHide: false,
  });
  const result = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) => resolve({ code: null, signal: null, error }));
  });
  child = null;
  if (stopping) break;
  failures = Date.now() - startedAt >= 60_000 ? 1 : failures + 1;
  const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(failures - 1, 5));
  console.error(JSON.stringify({
    level: "error",
    event: "process_restart_scheduled",
    target,
    delayMs: delay,
    ...result,
  }));
  await wait(delay);
}
