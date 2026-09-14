import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * DSH sidecar 的租约文件与启动锁。
 *
 * sidecar 过去是 Host 私有的：Host 一死它就成孤儿，新 Host 只能回收后重建，
 * 于是每重启一次就换一个新进程。这里把"谁在用这个 sidecar"从父进程关系里
 * 拆出来，落到一个 Host 数据目录下的租约文件上：
 *
 * - 启动时先看租约文件里有没有还活着的 sidecar，有就直接接管，不新建进程；
 * - 租约文件记录所有正在使用它的 Host 进程号，sidecar 内部的守卫据此决定
 *   是继续服务还是收尾；
 * - 并发启动用目录锁串行化，避免两个 Host 同时抢同一个端口。
 *
 * 租约按 Host 数据目录隔离：开发 Host 和安装版 Host 各有各的记录，互不接管。
 */

/** 租约文件的格式版本，字段不兼容时直接当作无效记录。 */
export const LEASE_VERSION = 1;

/** 租约文件名，放在 Host 数据目录下。 */
const LEASE_FILE_NAME = "deepseek-harness-sidecar.json";

/** 启动锁目录名；`mkdir` 的原子性就是这里的互斥保证。 */
const START_LOCK_DIR_NAME = "deepseek-harness-sidecar.lock";

/** 启动锁超过这个时长且持有者已消失，就当作残留锁清掉。 */
const START_LOCK_STALE_MS = 30_000;

/** 一个 sidecar 的租约记录。 */
export interface SidecarLeaseRecord {
  version: typeof LEASE_VERSION;
  instanceId: string;
  pid: number;
  port: number;
  baseUrl: string;
  /** 带一次性 token 的启动 URL；新 Host 用它重新换取自己的 cookie。 */
  authUrl: string | null;
  harnessVersion: string | null;
  /** 正在使用这个 sidecar 的 Host 进程号，可能不止一个。 */
  owners: number[];
  startedAt: string;
  updatedAt: string;
}

/** 启动锁的内容，用于判断残留锁的持有者是否还在。 */
interface SidecarStartLockRecord {
  pid: number;
  acquiredAt: string;
}

/** 判断进程是否还活着；无权限发信号也说明进程存在。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error) && (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 过滤掉已经退出的 owner。 */
export function pruneDeadOwners(owners: readonly number[]): number[] {
  const alive: number[] = [];
  for (const owner of owners) {
    if (isProcessAlive(owner) && !alive.includes(owner)) {
      alive.push(owner);
    }
  }

  return alive;
}

/** 租约文件路径。 */
export function resolveSidecarLeasePath(stateDir: string): string {
  return path.join(stateDir, LEASE_FILE_NAME);
}

/** 启动锁目录路径。 */
export function resolveSidecarStartLockPath(stateDir: string): string {
  return path.join(stateDir, START_LOCK_DIR_NAME);
}

/** 读租约；文件缺失、损坏或版本不符都返回 null，调用方按"没有可复用实例"处理。 */
export async function readSidecarLease(leasePath: string): Promise<SidecarLeaseRecord | null> {
  let raw: string;
  try {
    raw = await readFile(leasePath, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const record = parsed as Partial<SidecarLeaseRecord>;
  if (record.version !== LEASE_VERSION
    || typeof record.instanceId !== "string"
    || !Number.isInteger(record.pid)
    || !Number.isInteger(record.port)
    || typeof record.baseUrl !== "string"
    || !Array.isArray(record.owners)) {
    return null;
  }

  return {
    version: LEASE_VERSION,
    instanceId: record.instanceId,
    pid: record.pid as number,
    port: record.port as number,
    baseUrl: record.baseUrl,
    authUrl: typeof record.authUrl === "string" ? record.authUrl : null,
    harnessVersion: typeof record.harnessVersion === "string" ? record.harnessVersion : null,
    owners: (record.owners as unknown[]).filter((owner): owner is number => Number.isInteger(owner)),
    startedAt: typeof record.startedAt === "string" ? record.startedAt : new Date().toISOString(),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString()
  };
}

/**
 * 原子写租约：先写临时文件再 rename，避免 Host 在写入中途退出留下半截 JSON。
 * @param leasePath - 目标租约文件。
 * @param record - 要写入的记录。
 */
export async function writeSidecarLease(leasePath: string, record: SidecarLeaseRecord): Promise<void> {
  const directory = path.dirname(leasePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${leasePath}.tmp-${String(process.pid)}`;
  await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(temporaryPath, leasePath);
}

/** 删除租约；sidecar 已经确认不可用时调用。 */
export async function clearSidecarLease(leasePath: string): Promise<void> {
  await rm(leasePath, { force: true });
}

/**
 * 把当前 Host 登记为该 sidecar 的使用者。
 *
 * 接管别人的 sidecar 和启动自己的 sidecar 都要登记：守卫按这份名单判断
 * "还有没有人在用"，名单空了才开始收尾倒计时。
 * @param leasePath - 租约文件路径。
 * @param record - 当前记录。
 * @param ownerPid - 要登记的 Host 进程号。
 * @returns 写入后的记录；已经没有可登记的记录时为 null。
 */
export async function addSidecarLeaseOwner(
  leasePath: string,
  record: SidecarLeaseRecord,
  ownerPid: number
): Promise<SidecarLeaseRecord> {
  const owners = pruneDeadOwners([...record.owners, ownerPid]);
  const updated: SidecarLeaseRecord = {
    ...record,
    owners,
    updatedAt: new Date().toISOString()
  };
  await writeSidecarLease(leasePath, updated);
  return updated;
}

/**
 * 注销当前 Host，但保留租约文件给下一个 Host 接手。
 * @param leasePath - 租约文件路径。
 * @param ownerPid - 要注销的 Host 进程号。
 * @returns 还剩几个活着的使用者。
 */
export async function removeSidecarLeaseOwner(leasePath: string, ownerPid: number): Promise<number> {
  const record = await readSidecarLease(leasePath);
  if (!record) {
    return 0;
  }

  const owners = pruneDeadOwners(record.owners).filter((owner) => owner !== ownerPid);
  try {
    await writeSidecarLease(leasePath, { ...record, owners, updatedAt: new Date().toISOString() });
  } catch {
    // 注销失败不能挡住 Host 退出；守卫会因为持有者消失自行收尾。
  }

  return owners.length;
}

/** 启动锁的句柄，`release` 必须调用。 */
export interface SidecarStartLock {
  release: () => Promise<void>;
}

/**
 * 抢一次 sidecar 启动锁。
 *
 * 两个 Host 同时发现"没有可复用实例"时，只允许一个真的去拉进程，另一个拿到
 * null 后稍等再尝试接管，避免同时拉起两个 sidecar 抢同一个端口。
 * @param lockPath - 锁目录路径。
 * @returns 抢到时返回释放句柄；被别人持有时返回 null。
 */
export async function acquireSidecarStartLock(lockPath: string): Promise<SidecarStartLock | null> {
  const acquired = await tryCreateLockDirectory(lockPath);
  if (acquired) {
    return { release: () => releaseLockDirectory(lockPath) };
  }

  // 持有者可能已经崩溃，清掉过期残留后再抢一次。
  if (await clearStaleLockDirectory(lockPath)) {
    const retried = await tryCreateLockDirectory(lockPath);
    if (retried) {
      return { release: () => releaseLockDirectory(lockPath) };
    }
  }

  return null;
}

async function tryCreateLockDirectory(lockPath: string): Promise<boolean> {
  // 父目录单独用 recursive 建：锁目录本身必须走非递归 mkdir，recursive 模式
  // 对已存在的目录不报错，会把互斥语义丢掉。首次启动时父目录可能还没有。
  await mkdir(path.dirname(lockPath), { recursive: true });

  try {
    await mkdir(lockPath, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }

  const payload: SidecarStartLockRecord = { pid: process.pid, acquiredAt: new Date().toISOString() };
  await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify(payload)}\n`, "utf8").catch(() => undefined);
  return true;
}

async function releaseLockDirectory(lockPath: string): Promise<void> {
  await rm(lockPath, { recursive: true, force: true });
}

/**
 * 清掉持有者已经消失、或者已经明显超时的残留锁。
 * @param lockPath - 锁目录路径。
 * @returns 是否真的清掉了。
 */
async function clearStaleLockDirectory(lockPath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(path.join(lockPath, "owner.json"), "utf8");
  } catch {
    // 锁目录存在但读不到持有者信息：可能是刚创建还没写完，也可能是残留。
    // 只有明显超时才敢动，避免误删正在建立中的锁。
    return clearLockDirectoryIfOld(lockPath);
  }

  let record: Partial<SidecarStartLockRecord>;
  try {
    record = JSON.parse(raw) as Partial<SidecarStartLockRecord>;
  } catch {
    return clearLockDirectoryIfOld(lockPath);
  }

  if (typeof record.pid === "number" && isProcessAlive(record.pid)) {
    return false;
  }

  await releaseLockDirectory(lockPath);
  return true;
}

async function clearLockDirectoryIfOld(lockPath: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs < START_LOCK_STALE_MS) {
      return false;
    }
  } catch {
    return false;
  }

  await releaseLockDirectory(lockPath);
  return true;
}
