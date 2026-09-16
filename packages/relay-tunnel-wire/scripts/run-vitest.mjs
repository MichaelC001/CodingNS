import { spawn } from "node:child_process";

/**
 * 这个包很小，但仓库规则要求所有测试命令都带超时保护，
 * 所以这里不直接裸跑 vitest，套一层超时。
 */
const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const TEST_TIMEOUT_MS = readPositiveInt(process.env.CODINGNS_TEST_TIMEOUT_MS, 120_000);
const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const child = spawn(command, ["exec", "vitest", "run", ...rawArgs], {
  stdio: "inherit"
});
let timedOut = false;
const timeoutId = setTimeout(() => {
  timedOut = true;
  console.error(`[relay-tunnel-wire test] 超时退出：${Math.round(TEST_TIMEOUT_MS / 1000)} 秒内未结束。`);
  child.kill("SIGTERM");
  setTimeout(() => {
    child.kill("SIGKILL");
  }, 5_000).unref();
}, TEST_TIMEOUT_MS);

timeoutId.unref();

child.on("exit", (code, signal) => {
  clearTimeout(timeoutId);

  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  if (timedOut) {
    process.exit(124);
  }

  process.exit(code ?? 1);
});

function readPositiveInt(rawValue, fallbackValue) {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue;
}
