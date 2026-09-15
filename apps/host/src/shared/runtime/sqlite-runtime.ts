import { createRequire } from "node:module";

import type Libsql from "libsql";

const runtimeRequire = createRequire(import.meta.url);

type SqliteConstructor = typeof Libsql;

const runtimeModule = runtimeRequire("libsql") as SqliteConstructor | {
  default?: SqliteConstructor;
};

const RuntimeDatabase = (("default" in runtimeModule && runtimeModule.default) || runtimeModule) as SqliteConstructor;

/** libsql 的查询结果可能附带内部 _metadata 字段，统一在适配器边界剥离。 */
const DatabaseCompat = class extends (RuntimeDatabase as new (...args: any[]) => any) {
  prepare(sql: string): any {
    const statement = super.prepare(sql);
    const rawGet = statement.get.bind(statement);
    const rawAll = statement.all.bind(statement);
    statement.get = (...params: unknown[]) => stripMetadata(rawGet(...params));
    statement.all = (...params: unknown[]) => rawAll(...params).map(stripMetadata);
    return statement;
  }
};
const Database = DatabaseCompat as unknown as SqliteConstructor;

export type SqliteDatabase = Libsql.Database;
export type SqliteStatement<
  BindParameters extends unknown[] = unknown[],
  Result = unknown
> = Omit<Libsql.Statement<BindParameters>, "get" | "all"> & {
  get(...params: BindParameters): Result;
  all(...params: BindParameters): Result[];
};

function stripMetadata(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const result = { ...(value as Record<string, unknown>) };
  delete result._metadata;
  return result;
}
export default Database;
