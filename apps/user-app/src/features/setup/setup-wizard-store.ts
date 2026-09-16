import { useSyncExternalStore } from "react";

import type { HostSetupEnvironmentSnapshot } from "../../config/client-config-types";
import type { HostSetupProgressEvent } from "./host-setup-events";

export type SetupWizardRole = "client" | "server";

export const DEFAULT_SERVER_PORT = 3002;
export const DEFAULT_SERVER_DATA_DIR = "~/.codingns";

export interface SetupServerOptions {
  port: number;
  dataDir: string;
  autostart: boolean;
  allowLanAccess: boolean;
}

export interface SetupInstallStep {
  stepId: string;
  status: string;
  message?: string;
}

export interface SetupInstallError {
  code: string;
  message: string;
  detail: string | null;
  logPath: string | null;
}

export type SetupInstallStatus = "idle" | "running" | "succeeded" | "failed" | "cancelled";

export interface SetupInstallState {
  taskId: string | null;
  status: SetupInstallStatus;
  steps: SetupInstallStep[];
  logs: string[];
  error: SetupInstallError | null;
  download: { receivedBytes: number; totalBytes: number | null } | null;
}

function createEmptyInstallState(): SetupInstallState {
  return {
    taskId: null,
    status: "idle",
    steps: [],
    logs: [],
    error: null,
    download: null
  };
}

function createDefaultServerOptions(): SetupServerOptions {
  return {
    port: DEFAULT_SERVER_PORT,
    dataDir: DEFAULT_SERVER_DATA_DIR,
    autostart: true,
    allowLanAccess: true
  };
}

export type SetupWizardStepId =
  | "role"
  | "client-endpoint"
  | "server-environment"
  | "server-options"
  | "server-installing";

export interface SetupWizardState {
  role: SetupWizardRole | null;
  stepId: SetupWizardStepId;
  /** 客户端分支：地址是否已经测通并写进 host profile。 */
  clientEndpointReady: boolean;
  /** 服务端分支：环境快照、安装参数和安装进度。 */
  serverEnvironment: HostSetupEnvironmentSnapshot | null;
  serverOptions: SetupServerOptions;
  install: SetupInstallState;
}

const CLIENT_STEPS: SetupWizardStepId[] = ["role", "client-endpoint"];
const SERVER_STEPS: SetupWizardStepId[] = [
  "role",
  "server-environment",
  "server-options",
  "server-installing"
];

export function getSetupWizardSteps(role: SetupWizardRole | null): SetupWizardStepId[] {
  return role === "server" ? SERVER_STEPS : CLIENT_STEPS;
}

function firstStepForRole(role: SetupWizardRole): SetupWizardStepId {
  return role === "server" ? "server-environment" : "client-endpoint";
}

class SetupWizardStore {
  private state: SetupWizardState = {
    role: null,
    stepId: "role",
    clientEndpointReady: false,
    serverEnvironment: null,
    serverOptions: createDefaultServerOptions(),
    install: createEmptyInstallState()
  };

  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): SetupWizardState => this.state;

  reset(): void {
    this.state = {
      role: null,
      stepId: "role",
      clientEndpointReady: false,
      serverEnvironment: null,
      serverOptions: createDefaultServerOptions(),
      install: createEmptyInstallState()
    };
    this.emit();
  }

  setServerEnvironment(snapshot: HostSetupEnvironmentSnapshot | null): void {
    this.state = {
      ...this.state,
      serverEnvironment: snapshot
    };
    this.emit();
  }

  patchServerOptions(patch: Partial<SetupServerOptions>): void {
    this.state = {
      ...this.state,
      serverOptions: {
        ...this.state.serverOptions,
        ...patch
      }
    };
    this.emit();
  }

  beginInstall(taskId: string): void {
    this.state = {
      ...this.state,
      install: {
        ...createEmptyInstallState(),
        taskId,
        status: "running"
      }
    };
    this.emit();
  }

  applyInstallEvent(event: HostSetupProgressEvent): void {
    if (this.state.install.taskId && event.taskId !== this.state.install.taskId) {
      return;
    }

    const install = this.state.install;

    switch (event.type) {
      case "step": {
        if (!event.stepId) {
          return;
        }

        const entry: SetupInstallStep = {
          stepId: event.stepId,
          status: event.status ?? "running",
          message: event.message
        };
        const steps = [...install.steps];
        const index = steps.findIndex((step) => step.stepId === event.stepId);

        if (index >= 0) {
          steps[index] = entry;
        } else {
          steps.push(entry);
        }

        this.state = {
          ...this.state,
          install: {
            ...install,
            steps,
            status: event.status === "failed" ? "failed" : install.status
          }
        };
        break;
      }
      case "log": {
        if (!event.message) {
          return;
        }

        this.state = {
          ...this.state,
          install: {
            ...install,
            logs: [...install.logs, event.message].slice(-200)
          }
        };
        break;
      }
      case "download": {
        this.state = {
          ...this.state,
          install: {
            ...install,
            download: {
              receivedBytes: event.receivedBytes ?? 0,
              totalBytes: event.totalBytes ?? null
            }
          }
        };
        break;
      }
      case "result": {
        this.state = {
          ...this.state,
          install: {
            ...install,
            status: "succeeded"
          }
        };
        break;
      }
      case "error": {
        this.state = {
          ...this.state,
          install: {
            ...install,
            status: event.code === "INSTALL_CANCELLED" ? "cancelled" : "failed",
            error: {
              code: event.code ?? "INSTALL_FAILED",
              message: event.message ?? "安装失败",
              detail: event.detail ?? null,
              logPath: event.logPath ?? null
            }
          }
        };
        break;
      }
      default:
        return;
    }

    this.emit();
  }

  markInstallCancelled(): void {
    this.state = {
      ...this.state,
      install: {
        ...this.state.install,
        status: "cancelled"
      }
    };
    this.emit();
  }

  clearInstall(): void {
    this.state = {
      ...this.state,
      install: createEmptyInstallState()
    };
    this.emit();
  }

  markClientEndpointReady(): void {
    if (this.state.clientEndpointReady) {
      return;
    }

    this.state = {
      ...this.state,
      clientEndpointReady: true
    };
    this.emit();
  }

  selectRole(role: SetupWizardRole): void {
    const nextState: SetupWizardState = {
      ...this.state,
      role,
      stepId: firstStepForRole(role),
      clientEndpointReady: false
    };

    if (this.state.role === nextState.role && this.state.stepId === nextState.stepId) {
      return;
    }

    this.state = nextState;
    this.emit();
  }

  goNext(): void {
    if (!this.state.role) {
      return;
    }

    const steps = getSetupWizardSteps(this.state.role);
    const currentIndex = steps.indexOf(this.state.stepId);

    if (currentIndex < 0 || currentIndex >= steps.length - 1) {
      return;
    }

    this.state = {
      ...this.state,
      stepId: steps[currentIndex + 1]
    };
    this.emit();
  }

  goBack(): void {
    const steps = getSetupWizardSteps(this.state.role);
    const currentIndex = steps.indexOf(this.state.stepId);

    if (currentIndex <= 0) {
      return;
    }

    this.state = {
      ...this.state,
      stepId: steps[currentIndex - 1]
    };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const setupWizardStore = new SetupWizardStore();

export function useSetupWizardSelector<T>(selector: (state: SetupWizardState) => T): T {
  return useSyncExternalStore(setupWizardStore.subscribe, () => selector(setupWizardStore.getState()));
}
