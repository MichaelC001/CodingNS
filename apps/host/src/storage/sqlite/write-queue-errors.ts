export function isSqliteBusyError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const sqliteCode = "code" in error ? error.code : null;
  const message = error instanceof Error ? error.message : String(error);

  return sqliteCode === "SQLITE_BUSY"
    || sqliteCode === "SQLITE_LOCKED"
    || message.includes("database is locked")
    || message.includes("database table is locked");
}
