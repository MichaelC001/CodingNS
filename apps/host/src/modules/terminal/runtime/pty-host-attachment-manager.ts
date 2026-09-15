import { EventEmitter } from "node:events";

import { AppError } from "../../../shared/errors/app-error.js";
import { terminateProcessById } from "../../../shared/utils/child-process-lifecycle.js";
import {
  loadNodePty,
  type IPty
} from "./node-pty-loader.js";

const { spawn } = loadNodePty();

export interface HostAttachmentExitEvent {
  attachmentId: string;
  exitCode: number | null;
  requestedClose: boolean;
}

interface HostAttachmentRecord {
  pty: IPty;
  processId: number | null;
  closeStrategy: "pty-kill" | "process-kill";
}

export declare interface PtyHostAttachmentManager {
  on(event: "output", listener: (event: { attachmentId: string; content: string }) => void): this;
  on(event: "exit", listener: (event: HostAttachmentExitEvent) => void): this;
  emit(event: "output", eventPayload: { attachmentId: string; content: string }): boolean;
  emit(event: "exit", eventPayload: HostAttachmentExitEvent): boolean;
}

export class PtyHostAttachmentManager extends EventEmitter {
  private readonly attachments = new Map<string, HostAttachmentRecord>();
  private readonly requestedClose = new Set<string>();
  private readonly pendingProcessTerminations = new Set<Promise<void>>();

  start(
    attachmentId: string,
    input: {
      command: string;
      args: string[];
      cwd: string;
      env: Record<string, string>;
      cols?: number;
      rows?: number;
      closeStrategy?: "pty-kill" | "process-kill";
    }
  ): number | null {
    try {
      const ptyProcess = spawn(input.command, input.args, {
        cols: input.cols ?? 120,
        rows: input.rows ?? 30,
        cwd: input.cwd,
        env: input.env,
        name: "xterm-color"
      });

      const processId = normalizeProcessId(ptyProcess.pid);
      this.attachments.set(attachmentId, {
        pty: ptyProcess,
        processId,
        closeStrategy: input.closeStrategy ?? "pty-kill"
      });

      ptyProcess.onData((content) => {
        this.emit("output", {
          attachmentId,
          content
        });
      });

      ptyProcess.onExit((event) => {
        this.attachments.delete(attachmentId);
        const requestedClose = this.requestedClose.delete(attachmentId);

        this.emit("exit", {
          attachmentId,
          exitCode: event.exitCode ?? null,
          requestedClose
        });
      });

      return processId;
    } catch (error) {
      throw new AppError({
        statusCode: 502,
        errorCode: "PTY_START_FAILED",
        detail: error instanceof Error ? error.message : "PTY 启动失败"
      });
    }
  }

  write(attachmentId: string, content: string): void {
    const runtime = this.attachments.get(attachmentId);

    if (!runtime) {
      throw new AppError({
        statusCode: 409,
        errorCode: "TERMINAL_NOT_RUNNING",
        detail: "终端当前不可写入"
      });
    }

    runtime.pty.write(content);
  }

  resize(attachmentId: string, cols: number, rows: number): void {
    const runtime = this.attachments.get(attachmentId);

    if (!runtime) {
      throw new AppError({
        statusCode: 409,
        errorCode: "TERMINAL_NOT_RUNNING",
        detail: "终端当前不可调整尺寸"
      });
    }

    runtime.pty.resize(cols, rows);
  }

  close(attachmentId: string): void {
    const runtime = this.attachments.get(attachmentId);

    if (!runtime) {
      return;
    }

    this.requestedClose.add(attachmentId);

    if (runtime.closeStrategy === "process-kill" && runtime.processId) {
      const termination = terminateProcessById(runtime.processId).catch(() => {
        // 进程已经结束或权限不足时退回到 @lydell/node-pty 默认关闭逻辑。
        runtime.pty.kill();
      });
      this.pendingProcessTerminations.add(termination);
      void termination.finally(() => {
        this.pendingProcessTerminations.delete(termination);
      });
      return;
    }

    runtime.pty.kill();
  }

  isRunning(attachmentId: string): boolean {
    return this.attachments.has(attachmentId);
  }

  getProcessId(attachmentId: string): number | null {
    return this.attachments.get(attachmentId)?.processId ?? null;
  }

  closeAll(): void {
    for (const attachmentId of this.attachments.keys()) {
      this.close(attachmentId);
    }
  }

  async waitForPendingClosures(): Promise<void> {
    await Promise.all([...this.pendingProcessTerminations]);
  }
}

function normalizeProcessId(processId: number | undefined): number | null {
  if (typeof processId !== "number" || !Number.isInteger(processId) || processId <= 0) {
    return null;
  }

  return processId;
}
