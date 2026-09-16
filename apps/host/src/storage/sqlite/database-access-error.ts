import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DATABASE_NOT_WRITABLE = "DATABASE_NOT_WRITABLE";

export interface DatabaseAccessErrorOptions {
  databasePath: string;
  reason: string;
  hintLines: string[];
  cause?: unknown;
}

/**
 * 数据库位置不可写时抛出的可控错误。
 *
 * CLI 与安装器只展示 message 和 hintLines，不再把 SQLite 堆栈甩给用户。
 */
export class DatabaseAccessError extends Error {
  readonly code = DATABASE_NOT_WRITABLE;
  readonly databasePath: string;
  readonly reason: string;
  readonly hintLines: string[];

  constructor(options: DatabaseAccessErrorOptions) {
    super(`数据库不可写：${options.databasePath}（${options.reason}）`, { cause: options.cause });
    this.name = "DatabaseAccessError";
    this.databasePath = options.databasePath;
    this.reason = options.reason;
    this.hintLines = [...options.hintLines];
  }
}

export function isDatabaseAccessError(error: unknown): error is DatabaseAccessError {
  return (
    error instanceof DatabaseAccessError
    || (
      typeof error === "object"
      && error !== null
      && (error as { code?: unknown }).code === DATABASE_NOT_WRITABLE
    )
  );
}

/**
 * 打开数据库前先确认位置可写。
 *
 * 写句柄拿不到时 SQLite 不会在 `new Database()` 报错，而是静默按只读打开，
 * 直到第一次写操作（补列、建索引）才抛 SQLITE_READONLY。那时进程已经走到
 * 建库流程深处，用户只能看到一屏堆栈，既不知道是哪个文件，也不知道怎么修。
 */
export function assertDatabaseWritable(databasePath: string): void {
  if (databasePath === ":memory:") {
    return;
  }

  if (fs.existsSync(databasePath)) {
    const block = describeWriteBlock(databasePath);

    if (block) {
      throw new DatabaseAccessError({
        databasePath,
        reason: `当前用户对该文件没有写权限（${block.message}）`,
        hintLines: buildRepairHintLines(databasePath, block.readOnlyFileSystem)
      });
    }

    return;
  }

  assertDataDirWritable(path.dirname(databasePath), databasePath);
}

/**
 * 数据目录必须可写：SQLite 要在这里建库文件和 -wal / -shm，Host 还要建 releases 等子目录，
 * 权限不对时这些操作会各自抛 EACCES，提前拦下来才能给出一句能照做的提示。
 */
export function assertDataDirWritable(dataDir: string, databasePath = path.join(dataDir, "host.sqlite")): void {
  const existingDir = resolveNearestExistingDirectory(dataDir);
  const block = existingDir ? describeWriteBlock(existingDir) : null;

  if (!existingDir || block) {
    throw new DatabaseAccessError({
      databasePath,
      reason: `数据目录不可写（${existingDir ?? dataDir}${block ? `：${block.message}` : ""}）`,
      hintLines: buildRepairHintLines(databasePath, block?.readOnlyFileSystem ?? false)
    });
  }
}

/**
 * 兜底：预检覆盖不到的只读场景（例如目录不可写导致建不出 -wal / -shm）仍会在
 * 建库过程中抛 SQLITE_READONLY，这里把它换成人话，其余错误原样返回。
 */
export function toDatabaseAccessError(error: unknown, databasePath: string): DatabaseAccessError | null {
  if (!isReadOnlyDatabaseError(error)) {
    return null;
  }

  return new DatabaseAccessError({
    databasePath,
    reason: "SQLite 无法写入该数据库，数据库文件或所在目录不可写",
    hintLines: buildRepairHintLines(databasePath, false),
    cause: error
  });
}

/**
 * libsql 只给部分错误码起了字符串名字，像 SQLITE_READONLY_DIRECTORY（目录不可写建不出 -shm）
 * 会落成 UNKNOWN_SQLITE_ERROR_1544，所以这里同时按主码（低 8 位）判断。
 */
function isReadOnlyDatabaseError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const errnoCode = readErrorCode(error);

  if (errnoCode.startsWith("SQLITE_READONLY")) {
    return true;
  }

  const rawCode = (error as { rawCode?: unknown }).rawCode;
  return typeof rawCode === "number" && (rawCode & 0xff) === SQLITE_READONLY_PRIMARY_CODE;
}

const SQLITE_READONLY_PRIMARY_CODE = 8;

interface WriteBlock {
  message: string;
  readOnlyFileSystem: boolean;
}

function describeWriteBlock(targetPath: string): WriteBlock | null {
  try {
    fs.accessSync(targetPath, fs.constants.W_OK);
    return null;
  } catch (error) {
    const errnoCode = readErrorCode(error);

    if (errnoCode === "EROFS") {
      return { message: "所在磁盘是只读挂载", readOnlyFileSystem: true };
    }

    if (errnoCode === "EACCES" || errnoCode === "EPERM") {
      return {
        message: `${describeOwnership(targetPath)}，当前用户是 ${currentUserName()}`,
        readOnlyFileSystem: false
      };
    }

    return {
      message: error instanceof Error ? error.message : String(error),
      readOnlyFileSystem: false
    };
  }
}

function buildRepairHintLines(databasePath: string, readOnlyFileSystem: boolean): string[] {
  const dataDir = path.dirname(databasePath);

  if (readOnlyFileSystem) {
    return [
      `数据目录：${dataDir}`,
      "该目录所在磁盘是只读挂载，请换一个可写目录后重试。",
      "临时指定数据目录：codingns start --data-dir ~/.codingns"
    ];
  }

  const quotedDir = quoteForShell(dataDir);

  return [
    `数据目录：${dataDir}`,
    "修复方式：",
    `  sudo chown -R "$(id -u):$(id -g)" ${quotedDir}`,
    `  chmod -R u+rwX ${quotedDir}`,
    "如果 Host 正以管理员身份运行（sudo 启动，或 root 下的 pm2 / launchd 服务），先停掉再改属主。"
  ];
}

function resolveNearestExistingDirectory(startPath: string): string | null {
  let current = path.resolve(startPath);

  while (true) {
    if (fs.existsSync(current)) {
      return current;
    }

    const parent = path.dirname(current);

    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

function describeOwnership(targetPath: string): string {
  try {
    const stats = fs.statSync(targetPath);
    return `属主 uid=${stats.uid} gid=${stats.gid}`;
  } catch {
    return "无法读取属主信息";
  }
}

function currentUserName(): string {
  try {
    return os.userInfo().username;
  } catch {
    return String(process.getuid?.() ?? "unknown");
  }
}

function quoteForShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function readErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "";
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}
