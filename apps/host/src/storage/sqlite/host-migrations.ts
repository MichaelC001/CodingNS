import type { SqliteDatabase } from "../../shared/runtime/sqlite-runtime.js";

interface HostMigration {
  version: number;
  name: string;
  apply: (db: SqliteDatabase) => void;
}

const HOST_MIGRATIONS: readonly HostMigration[] = [
  {
    version: 1,
    name: "drop_session_discovery_diagnostics",
    apply: (db) => {
      // 诊断快照已经改为进程内短期数据，历史表不再承担业务职责。
      // DROP TABLE 不需要逐行删除，适合一次性处理已经膨胀的旧表。
      db.exec("DROP TABLE IF EXISTS session_discovery_diagnostics");
    }
  },
  {
    version: 2,
    name: "instance_relay_tunnel_identity_dtls_columns",
    apply: (db) => {
      // WebRTC 承载层要一份长期稳定的 DTLS 证书，材料复用同一行身份记录，不新开表。
      // 全新库由 schema.sql 直接建好这些列，这里只处理已经存在的旧库。
      const existingColumns = new Set(
        (db.prepare("PRAGMA table_info(instance_relay_tunnel_identity)").all() as Array<{ name: string }>)
          .map((row) => row.name)
      );

      if (existingColumns.size === 0) {
        // 表还不存在（schema 初始化会带上新列），这里什么都不用做。
        return;
      }

      const columns: Array<[string, string]> = [
        ["dtls_private_key_pem", "TEXT"],
        ["dtls_cert_pem", "TEXT"],
        ["dtls_signature_hash", "TEXT"],
        ["dtls_fingerprint", "TEXT"],
        ["dtls_created_at", "TEXT"],
        ["dtls_updated_at", "TEXT"]
      ];

      for (const [columnName, columnType] of columns) {
        if (existingColumns.has(columnName)) {
          continue;
        }

        db.exec(`ALTER TABLE instance_relay_tunnel_identity ADD COLUMN ${columnName} ${columnType}`);
      }
    }
  }
];

/**
 * 执行 Host 数据库的一次性迁移。
 *
 * Host 主库此前只有幂等 schema 初始化，没有独立的版本记录，因此这里使用
 * 专用迁移表，避免复用 affairs-indexer 自己的 catalog 迁移状态。
 */
export function runHostMigrations(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS host_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const appliedVersions = new Set(
    (db.prepare("SELECT version FROM host_schema_migrations").all() as Array<{ version: number }>)
      .map((row) => row.version)
  );

  for (const migration of HOST_MIGRATIONS) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    const apply = db.transaction(() => {
      migration.apply(db);
      db.prepare(
        "INSERT INTO host_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"
      ).run(migration.version, migration.name, new Date().toISOString());
    });
    apply();
  }
}
