/**
 * SQLite 写入错误的统一分类。
 *
 * 只有“锁竞争”这一类才是瞬时错误，可以有限退避重试；其它错误必须原样抛出，
 * 否则会把真正的故障（表不存在、约束冲突、磁盘满）伪装成“重试一下就好了”。
 *
 * 三类锁错误要分开看：
 * - `SQLITE_BUSY`：写锁被别人占着，等一会儿再来。
 * - `SQLITE_BUSY_SNAPSHOT`：WAL 读快照过期，必须回滚重开事务，重跑整个写入即可自愈。
 * - `SQLITE_LOCKED`：同一连接内的表锁冲突，通常也是瞬时问题。
 *
 * 错误码优先读 `code`，文本匹配只作为兜底：libsql 的 `SqliteError` 会带 `code`，
 * 但换版本或包一层包装后可能只剩 message。
 */
export type SqliteErrorKind = "busy" | "busy_snapshot" | "locked" | "other";

export function classifySqliteError(error: unknown): SqliteErrorKind {
  if (!error || typeof error !== "object") {
    return "other";
  }

  const code = "code" in error ? error.code : null;

  if (code === "SQLITE_BUSY") {
    return "busy";
  }

  if (code === "SQLITE_BUSY_SNAPSHOT") {
    return "busy_snapshot";
  }

  if (code === "SQLITE_LOCKED") {
    return "locked";
  }

  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("database table is locked")) {
    return "locked";
  }

  if (message.includes("database is locked")) {
    // 没有 code 时无法区分 BUSY 和 BUSY_SNAPSHOT，按普通 busy 处理。
    return "busy";
  }

  return "other";
}

export function isSqliteBusyError(error: unknown): boolean {
  return classifySqliteError(error) !== "other";
}

/** 只用于结构化日志：拿不到 code 时返回 null，不把 message 里的业务内容带出去。 */
export function readSqliteErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const code = "code" in error ? error.code : null;

  return typeof code === "string" && code.trim() ? code : null;
}
