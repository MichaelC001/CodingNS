/**
 * 远程连接的运行状态（spec001.9 W2.1 / W2.3）
 *
 * 界面上要能看到三件事：
 * 1. 现在有没有连上远程 Host
 * 2. 连上了走的是直连还是经中继（W2.3）
 * 3. 出错时错在哪一步，好给用户一句人话提示
 *
 * 这个 store 只存展示用的状态，不参与连接逻辑。
 * 连接逻辑在 `tunnel-client.ts` 和 `tunnel-session.ts` 里。
 */

import { useSyncExternalStore } from "react";

import type { TunnelLinkInfo, TunnelLinkTransportKind } from "./link-info";
import type { WebRtcTunnelErrorCode } from "./errors";

export type WebRtcLinkPhase = "idle" | "connecting" | "connected" | "failed" | "closed";

export interface WebRtcLinkSnapshot {
  phase: WebRtcLinkPhase;
  /** 当前连的是哪个 Host（Host 配置 id，用来区分多 Host 场景）。 */
  hostId: string | null;
  tunnelDomain: string | null;
  /** 链路类型：`p2p` 直连 / `relay` 经中继。还没协商出来时为 null。 */
  transportKind: TunnelLinkTransportKind | null;
  linkInfo: TunnelLinkInfo | null;
  errorCode: WebRtcTunnelErrorCode | null;
  errorDetail: string | null;
  connectedAt: string | null;
}

const INITIAL_SNAPSHOT: WebRtcLinkSnapshot = {
  phase: "idle",
  hostId: null,
  tunnelDomain: null,
  transportKind: null,
  linkInfo: null,
  errorCode: null,
  errorDetail: null,
  connectedAt: null
};

class WebRtcLinkStore {
  private snapshot: WebRtcLinkSnapshot = INITIAL_SNAPSHOT;
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): WebRtcLinkSnapshot => this.snapshot;

  /** 开始建连。 */
  markConnecting(hostId: string, tunnelDomain: string): void {
    this.update({
      phase: "connecting",
      hostId,
      tunnelDomain,
      transportKind: null,
      linkInfo: null,
      errorCode: null,
      errorDetail: null,
      connectedAt: null
    });
  }

  /** 通道已经打开。 */
  markConnected(): void {
    if (this.snapshot.phase === "connected") {
      this.update({
        connectedAt: this.snapshot.connectedAt ?? new Date().toISOString()
      });
      return;
    }

    this.update({
      phase: "connected",
      errorCode: null,
      errorDetail: null,
      connectedAt: new Date().toISOString()
    });
  }

  /** 链路类型协商出来了（可能从「还没确定」变成直连或经中继）。 */
  updateLinkInfo(info: TunnelLinkInfo | null): void {
    this.update({
      transportKind: info?.transportKind ?? null,
      linkInfo: info
    });
  }

  /** 出错。保留错误码，交给界面翻译成人话。 */
  markFailed(errorCode: WebRtcTunnelErrorCode, errorDetail: string | null): void {
    this.update({
      phase: "failed",
      transportKind: null,
      linkInfo: null,
      errorCode,
      errorDetail,
      connectedAt: null
    });
  }

  /** 连接被正常关闭。 */
  markClosed(): void {
    this.update({
      phase: "closed",
      transportKind: null,
      linkInfo: null,
      connectedAt: null
    });
  }

  /** 完全回到初始状态（切换 Host、退出登录时用）。 */
  reset(): void {
    this.update({ ...INITIAL_SNAPSHOT });
  }

  resetForTesting(): void {
    this.snapshot = INITIAL_SNAPSHOT;
    this.emit();
  }

  private update(patch: Partial<WebRtcLinkSnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...patch
    };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const webrtcLinkStore = new WebRtcLinkStore();

export function useWebRtcLinkSelector<T>(selector: (state: WebRtcLinkSnapshot) => T): T {
  return useSyncExternalStore(webrtcLinkStore.subscribe, () =>
    selector(webrtcLinkStore.getState()));
}

/** 链路类型对应的 i18n 键。界面上不出现 ICE 术语。 */
export function resolveLinkTransportLabelKey(kind: TunnelLinkTransportKind | null): string | null {
  switch (kind) {
    case "p2p":
      return "settings.remoteAccessLinkTypeP2p";
    case "relay":
      return "settings.remoteAccessLinkTypeRelay";
    default:
      return null;
  }
}
