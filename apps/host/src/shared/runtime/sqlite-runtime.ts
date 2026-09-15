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

/** 只暴露 libsql 运行时实际支持、且 Host 当前使用的数据库能力。 */
export interface SqliteDatabase {
  // 各仓储自行约束参数和结果；运行时只保证标准的变长绑定调用形态。
  prepare(sql: string): SqliteStatement<any[], any>;
  transaction(fn: (...parameters: any[]) => any): (...parameters: any[]) => any;
  exec(sql: string): void;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  close(): void;
}

export interface SqliteStatement<
  BindParameters extends unknown[] = unknown[],
  Result = unknown
> {
  run(...params: BindParameters): SqliteRunResult;
  get(...params: BindParameters): Result;
  all(...params: BindParameters): Result[];
}

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

function stripMetadata(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const result = { ...(value as Record<string, unknown>) };
  delete result._metadata;
  return result;
}
export default Database;
