export const HOST_SETUP_PROGRESS_EVENT = "codingns://host-setup/progress";

export type HostSetupProgressEventType = "step" | "log" | "download" | "result" | "error";

export type HostSetupStepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface HostSetupProgressEvent {
  taskId: string;
  type: HostSetupProgressEventType;
  stepId?: string;
  status?: HostSetupStepStatus;
  label?: string;
  message?: string;
  receivedBytes?: number;
  totalBytes?: number;
  code?: string;
  detail?: string | null;
  logPath?: string | null;
  data?: unknown;
}

/**
 * 订阅安装进度事件。返回取消订阅的函数；非桌面端返回空实现。
 */
export async function listenHostSetupProgress(
  handler: (event: HostSetupProgressEvent) => void
): Promise<() => void> {
  if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) {
    return () => undefined;
  }

  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<HostSetupProgressEvent>(HOST_SETUP_PROGRESS_EVENT, (event) => {
    handler(event.payload);
  });

  return unlisten;
}
