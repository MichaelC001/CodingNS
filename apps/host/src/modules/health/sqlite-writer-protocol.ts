import {
  InMemoryReadinessSnapshotProvider,
  type ReadinessSnapshot,
  type ReadinessSnapshotProvider
} from "./health-service.js";

/** Host 发给 writer helper 的类型化命令。payload 只允许可序列化值。 */
export type SqliteWriterCommand =
  | {
      kind: "write";
      requestId: string;
      sql: string;
      params: readonly unknown[];
      priority?: "critical" | "latest_wins" | "append_batch" | "best_effort";
    }
  | {
      kind: "transaction";
      requestId: string;
      statements: readonly { sql: string; params: readonly unknown[] }[];
      priority?: "critical" | "latest_wins" | "append_batch" | "best_effort";
    }
  | { kind: "drain"; requestId: string }
  | { kind: "retire"; requestId: string };

export type SqliteWriterMessage =
  | {
      kind: "heartbeat";
      sampledAt: string;
      pendingCount: number;
      pendingBytes: number;
      lockWaitMs?: number | null;
    }
  | {
      kind: "transaction_succeeded";
      requestId: string;
      completedAt: string;
      transactionDurationMs?: number;
      lockWaitMs?: number | null;
    }
  | {
      kind: "transaction_failed";
      requestId: string;
      completedAt: string;
      errorCategory: "busy" | "locked" | "unavailable" | "error";
    }
  | { kind: "retiring"; sampledAt: string }
  | { kind: "stopped"; sampledAt: string };

/**
 * Host 侧协议桥接器。
 *
 * 它只处理 helper 发来的快照，不执行 SQL。retiring/stopped 后的迟到消息会被丢弃，
 * 防止旧 helper 的 heartbeat 重新把 readiness 标成可用。
 */
export class SqliteWriterProtocolBridge implements ReadinessSnapshotProvider {
  private readonly provider: InMemoryReadinessSnapshotProvider;
  private retiring = false;

  constructor(provider = new InMemoryReadinessSnapshotProvider()) {
    this.provider = provider;
    this.provider.update({ writerAlive: false, heartbeatAt: null, stale: true });
  }

  getReadinessSnapshot(): ReadinessSnapshot {
    return this.provider.getReadinessSnapshot();
  }

  handleMessage(message: SqliteWriterMessage): ReadinessSnapshot {
    if (this.retiring && message.kind !== "stopped") {
      return this.getReadinessSnapshot();
    }

    switch (message.kind) {
      case "heartbeat":
        this.provider.update({
          writerAlive: true,
          heartbeatAt: message.sampledAt,
          pendingCount: message.pendingCount,
          pendingBytes: message.pendingBytes,
          lastLockWaitMs: message.lockWaitMs ?? null,
          stale: false,
          degraded: false
        });
        break;
      case "transaction_succeeded":
        this.provider.markTransactionSuccess(new Date(message.completedAt));
        this.provider.update({ lastLockWaitMs: message.lockWaitMs ?? null });
        break;
      case "transaction_failed":
        this.provider.update({
          writerAlive: true,
          heartbeatAt: message.completedAt,
          lastError: message.errorCategory,
          degraded: true,
          stale: false
        });
        break;
      case "retiring":
        this.retiring = true;
        this.provider.update({ retiring: true, degraded: true, heartbeatAt: message.sampledAt });
        break;
      case "stopped":
        this.retiring = true;
        this.provider.update({ writerAlive: false, retiring: true, stale: true, heartbeatAt: null });
        break;
    }

    return this.getReadinessSnapshot();
  }
}
