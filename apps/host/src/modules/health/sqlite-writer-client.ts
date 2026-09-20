import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { terminateChildProcess } from "../../shared/utils/child-process-lifecycle.js";
import type { ReadinessSnapshot, ReadinessSnapshotProvider } from "./health-service.js";
import { SqliteWriterProtocolBridge, type SqliteWriterMessage } from "./sqlite-writer-protocol.js";

interface PendingWrite { resolve: () => void; reject: (error: unknown) => void; timer: NodeJS.Timeout; }

export class SqliteWriterClient implements ReadinessSnapshotProvider {
  private child: ChildProcessWithoutNullStreams;
  private reader: readline.Interface;
  private readonly pending = new Map<string, PendingWrite>();
  private bridge: SqliteWriterProtocolBridge;
  private readonly databasePath: string;
  private readonly launch: { command: string; args: string[] };
  private restartTimer: NodeJS.Timeout | null = null;
  private restartCount = 0;
  private readonly maxRestarts = 3;
  private childFailureHandled = false;
  private sequence = 0;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(databasePath: string, bridge = new SqliteWriterProtocolBridge()) {
    this.databasePath = databasePath;
    this.bridge = bridge;
    const file = fileURLToPath(import.meta.url);
    const extension = path.extname(file);
    const processPath = file.replace(/sqlite-writer-client\.(ts|js)$/, `sqlite-writer-process${extension}`);
    this.launch = extension === ".ts"
      ? { command: process.execPath, args: ["--import", "tsx", processPath] }
      : { command: process.execPath, args: [processPath] };
    this.child = undefined as unknown as ChildProcessWithoutNullStreams;
    this.reader = undefined as unknown as readline.Interface;
    this.startChild();
  }

  getRestartCount(): number { return this.restartCount; }

  private startChild(): void {
    this.childFailureHandled = false;
    this.child = spawn(this.launch.command, [...this.launch.args, this.databasePath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    this.reader = readline.createInterface({ input: this.child.stdout });
    this.reader.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk) => console.warn(`[sqlite-writer] ${String(chunk).trim()}`));
    this.child.on("error", (error) => this.handleChildFailure(error));
    this.child.on("exit", (code, signal) => {
      if (!this.disposed) {
        this.handleChildFailure(new Error(`sqlite writer exited: code=${code ?? "null"} signal=${signal ?? "null"}`));
      }
    });
  }

  getReadinessSnapshot(): ReadinessSnapshot { return this.bridge.getReadinessSnapshot(); }

  write(sql: string, params: readonly unknown[] = [], options: { timeoutMs?: number; priority?: "critical" | "latest_wins" | "append_batch" | "best_effort" } = {}): Promise<void> {
    if (this.disposed || this.child.stdin.destroyed || this.child.exitCode !== null) return Promise.reject(new Error("sqlite writer is unavailable"));
    const requestId = `sqlite-write-${++this.sequence}`;
    const timeoutMs = Math.max(100, options.timeoutMs ?? 10_000);
    const payload = { kind: "write" as const, requestId, sql, params, priority: options.priority };
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`sqlite writer request timeout: ${requestId}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(requestId);
          reject(error);
        }
      });
    });
  }

  transaction(
    statements: readonly { sql: string; params?: readonly unknown[] }[],
    options: { timeoutMs?: number; priority?: "critical" | "latest_wins" | "append_batch" | "best_effort" } = {}
  ): Promise<void> {
    if (this.disposed || this.child.stdin.destroyed || this.child.exitCode !== null) return Promise.reject(new Error("sqlite writer is unavailable"));
    const requestId = `sqlite-transaction-${++this.sequence}`;
    const timeoutMs = Math.max(100, options.timeoutMs ?? 10_000);
    const payload = {
      kind: "transaction" as const,
      requestId,
      statements: statements.map((statement) => ({ sql: statement.sql, params: statement.params ?? [] })),
      priority: options.priority
    };
    return this.sendRequest(payload, requestId, timeoutMs);
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) return await this.disposePromise;
    this.disposed = true;
    this.bridge.handleMessage({ kind: "retiring", sampledAt: new Date().toISOString() });
    this.disposePromise = (async () => {
      if (!this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify({ kind: "drain", requestId: `drain-${Date.now()}` })}\n`);
      if (this.restartTimer) clearTimeout(this.restartTimer);
      await terminateChildProcess(this.child, { termGraceMs: 500, killWaitMs: 500 });
      this.reader.close();
      this.failAll(new Error("sqlite writer disposed"));
    })();
    return await this.disposePromise;
  }

  private handleLine(line: string): void {
    let message: SqliteWriterMessage;
    try { message = JSON.parse(line) as SqliteWriterMessage; } catch { return; }
    this.bridge.handleMessage(message);
    if (message.kind !== "transaction_succeeded" && message.kind !== "transaction_failed") return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    if (message.kind === "transaction_succeeded") pending.resolve();
    else pending.reject(new Error(`sqlite writer transaction failed: ${message.errorCategory}`));
  }

  private sendRequest(
    payload: object,
    requestId: string,
    timeoutMs: number
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`sqlite writer request timeout: ${requestId}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(requestId);
          reject(error);
        }
      });
    });
  }

  private failAll(error: unknown): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    this.bridge.handleMessage({ kind: "stopped", sampledAt: new Date().toISOString() });
  }

  private handleChildFailure(error: unknown): void {
    if (this.childFailureHandled) return;
    this.childFailureHandled = true;
    this.reader.close();
    this.failAll(error);
    if (this.disposed || this.restartCount >= this.maxRestarts) return;
    this.restartCount += 1;
    this.bridge = new SqliteWriterProtocolBridge();
    const delayMs = Math.min(2_000, 100 * 2 ** (this.restartCount - 1));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.disposed) this.startChild();
    }, delayMs);
    this.restartTimer.unref?.();
  }
}
