import { describe, expect, it } from "vitest";

import { LocalSqliteWriter } from "../../src/storage/sqlite/local-writer.js";
import { createDatabaseClient } from "../../src/storage/sqlite/client.js";

describe("LocalSqliteWriter", () => {
  it("把写入和事务统一排入 Host 写队列，并提供 readiness 快照", async () => {
    const database = createDatabaseClient(":memory:");
    const writer = new LocalSqliteWriter(database.db, database.writeQueue);

    await writer.write("CREATE TABLE local_writer_test (id TEXT PRIMARY KEY, value TEXT)");
    await writer.transaction([
      {
        sql: "INSERT INTO local_writer_test (id, value) VALUES (?, ?)",
        params: ["one", "value"]
      }
    ]);

    expect(database.db.prepare("SELECT value FROM local_writer_test WHERE id = ?").get("one"))
      .toMatchObject({ value: "value" });
    expect(writer.getReadinessSnapshot()).toMatchObject({
      writerAlive: true,
      stale: false,
      pendingCount: 0,
      pendingBytes: 0
    });

    await writer.dispose();
    database.close();
  });
});
