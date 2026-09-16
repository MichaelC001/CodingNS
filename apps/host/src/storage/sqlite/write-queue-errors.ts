/**
 * 判断是否为可以重试的 SQLite 瞬时错误。
 *
 * SQLITE_BUSY_SNAPSHOT 也算在内：它表示连接的读快照已经过期（读事务开始之后 WAL 被别的连接
 * 推进或重置过），SQLite 要求回滚后重开事务。调用方只要重跑整个写入（而不是单独重跑事务里的
 * 某条语句）就能拿到新快照自愈，所以可以按瞬时错误重试。
 *
 * 它的 message 同样是 "database is locked"，但 code 必须显式列出：不能依赖文本匹配，
 * 否则换一个 libsql 版本或错误前缀就会漏判。
 */
export function isSqliteBusyError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const sqliteCode = "code" in error ? error.code : null;
  const message = error instanceof Error ? error.message : String(error);

  return sqliteCode === "SQLITE_BUSY"
    || sqliteCode === "SQLITE_BUSY_SNAPSHOT"
    || sqliteCode === "SQLITE_LOCKED"
    || message.includes("database is locked")
    || message.includes("database table is locked");
}
