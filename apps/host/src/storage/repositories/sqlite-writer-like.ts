/** Repository 使用的最小异步 Writer 协议，避免依赖 health 模块。 */
export interface SqliteWriterLike {
  write(sql: string, params?: readonly unknown[], options?: { priority?: "critical" | "latest_wins" | "append_batch" | "best_effort" }): Promise<void>;
  transaction?(statements: readonly { sql: string; params?: readonly unknown[] }[], options?: { priority?: "critical" | "latest_wins" | "append_batch" | "best_effort" }): Promise<void>;
}
