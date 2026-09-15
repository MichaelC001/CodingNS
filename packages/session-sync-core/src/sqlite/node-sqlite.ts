import { createRequire } from "node:module";

const runtimeRequire = createRequire(import.meta.url);

interface SqliteStatementLike {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): CompatibleRunResult;
}

interface SqliteDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementLike;
  close(): void;
}

type SqliteConstructor = new (
  dbPath: string,
  options?: { readonly?: boolean }
) => SqliteDatabaseLike;

interface CompatibleDatabaseOptions {
  open?: boolean;
  readOnly?: boolean;
}

interface CompatibleRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

interface CompatibleStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): CompatibleRunResult;
}

export interface DatabaseSyncType {
  exec(sql: string): void;
  prepare(sql: string): CompatibleStatement;
  close(): void;
}

export type DatabaseSyncConstructor = new (
  dbPath: string,
  options?: CompatibleDatabaseOptions
) => DatabaseSyncType;

/**
 * 返回一个兼容 node:sqlite DatabaseSync 调用形态的构造器。
 * 底层改用 libsql，避免 Host 和 helper 子进程加载实验性的 node:sqlite。
 */
export function loadDatabaseSync(): DatabaseSyncConstructor {
  const runtimeModule = runtimeRequire("libsql") as SqliteConstructor | {
    default?: SqliteConstructor;
  };
  const Database = (("default" in runtimeModule && runtimeModule.default) || runtimeModule) as SqliteConstructor;

  return class SqliteDatabaseSyncCompat implements DatabaseSyncType {
    private readonly db: SqliteDatabaseLike;

    constructor(dbPath: string, options: CompatibleDatabaseOptions = {}) {
      if (options.open === false) {
        throw new Error("SESSION_SYNC_SQLITE_OPEN_FALSE_UNSUPPORTED");
      }

      this.db = new Database(dbPath, {
        readonly: Boolean(options.readOnly)
      });
    }

    exec(sql: string): void {
      this.db.exec(sql);
    }

    prepare(sql: string): CompatibleStatement {
      const statement = this.db.prepare(sql);
      return {
        all: (...params) => statement.all(...params).map(stripMetadata),
        get: (...params) => stripMetadata(statement.get(...params)),
        run: (...params) => statement.run(...params)
      };
    }

    close(): void {
      this.db.close();
    }
  };
}

function stripMetadata(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const result = { ...(value as Record<string, unknown>) };
  delete result._metadata;
  return result;
}
