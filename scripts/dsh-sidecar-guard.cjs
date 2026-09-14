"use strict";

/**
 * DeepSeek Harness sidecar 的生命周期守卫。
 *
 * CodingNS Host 用 `NODE_OPTIONS=--require <这个文件>` 把它注入 `dsh web`
 * 进程。sidecar 是 detached 启动的，Host 被强杀（例如 tsx watch 重启超时）
 * 时它不会跟着退出，而是被 launchd/init 收养继续活着，一直占着 DSH 的会话
 * 写入租约和监听端口。DSH 的租约按进程存活持有、不做超时抢占，所以这些孤儿
 * 会让新 Host 打不开旧会话，也会越积越多。
 *
 * 判断依据分两层：
 *
 * 1. Host 数据目录下的租约文件里记着"谁在用这个 sidecar"。名单里还有活着的
 *    Host 就继续服务——这既覆盖多个 Host 共用一个 sidecar，也覆盖 Host 重启
 *    后被新 Host 接管的情况。
 * 2. 名单空了（Host 正常退出、或者被强杀后没人接手）才开始倒计时，宽限期内
 *    没有新 Host 登记就自行收尾，把租约和端口让出来，避免变成常驻垃圾。
 *
 * 没有租约信息时退回父进程检查：发起进程一消失就收尾。没有注入任何信息时
 * 守卫完全不装，用户手动跑的 `dsh` 不受影响。
 */

/** 注入父进程号的环境变量名，与 sidecar manager 共享该约定。 */
const PARENT_PID_ENV = "CODINGNS_SIDECAR_GUARD_PARENT_PID";

/** 注入租约文件路径的环境变量名。 */
const LEASE_PATH_ENV = "CODINGNS_SIDECAR_GUARD_LEASE_PATH";

/** 覆盖接管宽限期的环境变量名，测试用它把等待压到毫秒级。 */
const IDLE_GRACE_ENV = "CODINGNS_SIDECAR_GUARD_IDLE_GRACE_MS";

/** 检查间隔：够快让端口和租约及时释放，又不至于空转。 */
const POLL_INTERVAL_MS = 2000;

/** 没有 Host 使用后，留给下一个 Host 接管的时长。 */
const DEFAULT_IDLE_GRACE_MS = 60_000;

/** 收到 SIGTERM 后留给 dsh 自己收尾的时间，超时再强退。 */
const TERM_GRACE_MS = 3000;

/** 重复 require 时只装一次守卫。 */
const INSTALLED_FLAG = Symbol.for("codingns.dsh-sidecar-guard.installed");

const fs = require("node:fs");

/**
 * 读出 Host 注入的父进程号。
 * @returns 合法的父进程号；没注入或注入值不可用时为 null。
 */
function readParentPid() {
  const raw = process.env[PARENT_PID_ENV];
  if (typeof raw !== "string" || raw.trim() === "") {
    return null;
  }

  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed === process.pid) {
    return null;
  }

  return parsed;
}

/** 读出接管宽限期。 */
function readIdleGraceMs() {
  const raw = process.env[IDLE_GRACE_ENV];
  if (typeof raw !== "string" || raw.trim() === "") {
    return DEFAULT_IDLE_GRACE_MS;
  }

  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_IDLE_GRACE_MS;
}

/**
 * 判断进程是否还活着。
 * @param pid - 目标进程号。
 * @returns 进程存在（含无权限发信号的场景）时为 true。
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH 表示进程不存在；EPERM 表示存在但当前用户无权发信号，仍算活着。
    return Boolean(error) && error.code === "EPERM";
  }
}

/**
 * 读出租约里还活着的使用者。
 * @param leasePath - 租约文件路径。
 * @returns `known` 为 false 表示拿不到有效租约，调用方应退回父进程判断。
 */
function readAliveOwners(leasePath) {
  let raw;
  try {
    raw = fs.readFileSync(leasePath, "utf8");
  } catch {
    return { known: false, owners: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { known: false, owners: [] };
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.owners)) {
    return { known: false, owners: [] };
  }

  return { known: true, owners: parsed.owners.filter(isAlive) };
}

if (!globalThis[INSTALLED_FLAG]) {
  const parentPid = readParentPid();
  const leasePath = process.env[LEASE_PATH_ENV];
  const idleGraceMs = readIdleGraceMs();

  if (parentPid !== null || (typeof leasePath === "string" && leasePath !== "")) {
    globalThis[INSTALLED_FLAG] = true;

    let stopping = false;
    let idleSince = null;

    const stopSelf = () => {
      if (stopping) {
        return;
      }

      stopping = true;
      try {
        process.stderr.write(
          `[dsh-sidecar-guard] 已无 Host 使用，sidecar 自行收尾（发起进程 ${String(parentPid ?? "unknown")}）\n`
        );
      } catch {
        // Host 已经不在，管道可能已断开，写不进去不影响收尾。
      }

      // 先给自己 SIGTERM，让 dsh 走自己的关闭流程；不响应时再强退。
      try {
        process.kill(process.pid, "SIGTERM");
      } catch {
        process.exit(0);
        return;
      }

      const forced = setTimeout(() => process.exit(0), TERM_GRACE_MS);
      // 守卫不能拖住 sidecar 的正常退出。
      forced.unref?.();
    };

    const timer = setInterval(() => {
      // 有租约信息时以"还有没有活着的 Host"为准，覆盖多 Host 共用和重启接管。
      if (typeof leasePath === "string" && leasePath !== "") {
        const lease = readAliveOwners(leasePath);
        if (lease.known) {
          if (lease.owners.length > 0) {
            idleSince = null;
            return;
          }

          if (idleSince === null) {
            idleSince = Date.now();
          }
          if (Date.now() - idleSince >= idleGraceMs) {
            stopSelf();
          }
          return;
        }
      }

      // 拿不到租约（还没写、被删、或本就没启用复用）时退回父进程检查。
      if (parentPid !== null) {
        // 被 launchd/init 收养说明父进程已经不在了，不必再等存活探测。
        const reparentedToInit = process.ppid === 1 && parentPid !== 1;
        if (reparentedToInit || !isAlive(parentPid)) {
          stopSelf();
        }
      }
    }, POLL_INTERVAL_MS);
    timer.unref?.();
  }
}
