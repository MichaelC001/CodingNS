import readline from "node:readline";

import Database from "../../shared/runtime/sqlite-runtime.js";
import type { SqliteWriterCommand, SqliteWriterMessage } from "./sqlite-writer-protocol.js";
import { SqliteWriteQueue } from "../../storage/sqlite/write-queue.js";

const databasePath = process.argv[2];
if (!databasePath) {
  process.stderr.write("sqlite writer requires database path\n");
  process.exit(2);
}

const db = new Database(databasePath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

let retiring = false;
const writeQueue = new SqliteWriteQueue({ maxPendingCommands: 1_000, maxPendingBytes: 64 * 1024 * 1024 });
let heartbeatTimer: NodeJS.Timeout | null = setInterval(() => {
  const stats = writeQueue.getStats();
  emit({
    kind: "heartbeat",
    sampledAt: new Date().toISOString(),
    pendingCount: stats.pendingCount,
    pendingBytes: stats.pendingBytes,
    lockWaitMs: null
  });
}, 1_000);
heartbeatTimer.unref?.();

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  void handleCommand(line);
});

input.on("close", () => {
  stop();
});

process.on("SIGTERM", () => stop());
process.on("SIGINT", () => stop());

async function handleCommand(line: string): Promise<void> {
  let command: SqliteWriterCommand;
  try {
    command = JSON.parse(line) as SqliteWriterCommand;
  } catch {
    return;
  }

  if (command.kind === "retire") {
    retiring = true;
    emit({ kind: "retiring", sampledAt: new Date().toISOString() });
    return;
  }
  if (command.kind === "drain") {
    await writeQueue.close({ drain: true });
    emit({ kind: "stopped", sampledAt: new Date().toISOString() });
    stop();
    return;
  }
  if (retiring) {
    emit({ kind: "transaction_failed", requestId: command.requestId, completedAt: new Date().toISOString(), errorCategory: "unavailable" });
    return;
  }

  const startedAt = Date.now();
  try {
    await writeQueue.enqueue(
      "sqlite-writer.helper.write",
      () => command.kind === "write"
        ? db.prepare(command.sql).run(...command.params)
        : db.transaction(() => {
            for (const statement of command.statements) db.prepare(statement.sql).run(...statement.params);
          })(),
      { policy: command.priority ?? "critical", estimatedBytes: Buffer.byteLength(line, "utf8") }
    );
    emit({
      kind: "transaction_succeeded",
      requestId: command.requestId,
      completedAt: new Date().toISOString(),
      transactionDurationMs: Date.now() - startedAt,
      lockWaitMs: null
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    emit({
      kind: "transaction_failed",
      requestId: command.requestId,
      completedAt: new Date().toISOString(),
      errorCategory: message.includes("busy") ? "busy" : message.includes("locked") ? "locked" : "error"
    });
  }
}

function emit(message: SqliteWriterMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function stop(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  try {
    void writeQueue.close({ drain: false });
    db.close();
  } catch {
    // 进程退出时连接可能已经关闭。
  }
  process.exit(0);
}
