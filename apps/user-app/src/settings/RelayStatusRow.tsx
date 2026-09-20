import { useCallback, useEffect, useState } from "react";

import { useClientConfigSelector } from "../config/client-config-store";
import { getActiveHost } from "../config/client-config-types";
import { resolveRelayControlBaseUrl } from "../config/relay-control-site-config";
import { probeControlSiteHealth } from "../network/webrtc/control-site-client";
import {
  resolveLinkTransportLabelKey,
  useWebRtcLinkSelector
} from "../network/webrtc/webrtc-link-store";
import { useT } from "../shared/i18n";

/**
 * 设置页「远程访问」区块的状态行（spec001.9 W2.6）
 *
 * 只回答四个事实，不做任何配置动作：
 * 1. 这台电脑的远程访问开没开
 * 2. 四级域名是什么
 * 3. 现在能不能连上 CodingNS Connect 服务器
 * 4. 当前链路是直连还是经中继
 *
 * 前两项直接读当前 Host 的本地配置，不用请求；服务器状态在打开设置页时探一次，
 * 之后由用户点「刷新」，不自己起定时器，避免在设置页长出一个新的轮询。
 *
 * 没开远程访问时只显示「启用状态：未启用」一项：后面三项这时候没有意义，
 * 也没必要去探服务器。
 */
export function RelayStatusRow() {
  const translate = useT();
  const relayTunnel = useClientConfigSelector((state) => getActiveHost(state)?.relayTunnel ?? null);
  const linkSnapshot = useWebRtcLinkSelector((state) => state);
  const [serverState, setServerState] = useState<"checking" | "reachable" | "unreachable">("checking");
  const enabled = Boolean(relayTunnel?.enabled);
  const controlBaseUrl = resolveRelayControlBaseUrl(relayTunnel?.controlBaseUrl);

  const probeServer = useCallback((): void => {
    setServerState("checking");

    void probeControlSiteHealth(controlBaseUrl).then((result) => {
      setServerState(result.reachable ? "reachable" : "unreachable");
    });
  }, [controlBaseUrl]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let active = true;

    void probeControlSiteHealth(controlBaseUrl).then((result) => {
      if (active) {
        setServerState(result.reachable ? "reachable" : "unreachable");
      }
    });

    return () => {
      active = false;
    };
  }, [controlBaseUrl, enabled]);

  return (
    <div className="settings-row settings-row-stacked">
      <div className="settings-relay-status-header">
        <span className="settings-row-title settings-row-title-strong">
          {translate("settings.remoteAccessStatusTitle")}
        </span>
        {enabled ? (
          <button
            className="settings-button"
            type="button"
            disabled={serverState === "checking"}
            onClick={probeServer}
          >
            {translate("settings.relayStatusRefreshAction")}
          </button>
        ) : null}
      </div>

      <div className="settings-relay-status-items">
        <RelayStatusItem
          label={translate("settings.relayStatusEnabledLabel")}
          value={
            enabled
              ? translate("settings.relayStatusEnabledValue")
              : translate("settings.relayStatusDisabledValue")
          }
        />
        {enabled ? (
          <>
            <RelayStatusItem
              label={translate("settings.relayStatusTunnelDomainLabel")}
              value={relayTunnel?.tunnelDomain?.trim() || translate("settings.relayStatusDomainUnbound")}
            />
            <RelayStatusItem
              label={translate("settings.relayStatusServerLabel")}
              value={resolveServerStateLabel(serverState, translate)}
            />
            <RelayStatusItem
              label={translate("settings.relayStatusLinkModeLabel")}
              value={resolveLinkModeLabel(linkSnapshot.phase, linkSnapshot.transportKind, translate)}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

function RelayStatusItem({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="settings-relay-status-item">
      <span className="settings-relay-status-item-label">{label}</span>
      <span className="settings-relay-status-item-value">{value}</span>
    </div>
  );
}

function resolveServerStateLabel(
  state: "checking" | "reachable" | "unreachable",
  translate: (key: string) => string
): string {
  switch (state) {
    case "checking":
      return translate("settings.relayStatusServerChecking");
    case "reachable":
      return translate("settings.relayStatusServerReachable");
    default:
      return translate("settings.relayStatusServerUnreachable");
  }
}

/** 链路文案。直连 / 经中继用普通用户能懂的说法，不暴露 ICE 术语。 */
function resolveLinkModeLabel(
  phase: string,
  transportKind: "p2p" | "relay" | null,
  translate: (key: string) => string
): string {
  if (phase === "connecting") {
    return translate("settings.relayStatusLinkModeConnecting");
  }

  if (phase !== "connected") {
    return translate("settings.relayStatusLinkModeIdle");
  }

  const linkTypeLabelKey = resolveLinkTransportLabelKey(transportKind);

  return linkTypeLabelKey
    ? translate(linkTypeLabelKey)
    : translate("settings.relayStatusLinkModeUnknown");
}
