import { useEffect } from "react";

import {
  resolveActiveConnectionRouteLabelKey,
  useActiveConnectionRouteSummary
} from "../../../config/active-connection-route";
import {
  resolveLinkTransportLabelKey,
  useWebRtcLinkSelector
} from "../../../network/webrtc/webrtc-link-store";
import { t } from "../../../shared/i18n";
import { useToast } from "../../../shared/toast";

import type { RuntimeConnectionState } from "../runtime/session-runtime-machine";

interface ConnectionBannerProps {
  connectionState: RuntimeConnectionState;
  onReconnect: () => void;
}

export function ConnectionBanner({ connectionState, onReconnect }: ConnectionBannerProps) {
  const { showToast, dismissToast } = useToast();
  const activeConnectionRoute = useActiveConnectionRouteSummary();
  const activeConnectionRouteLabel = activeConnectionRoute
    ? t(resolveActiveConnectionRouteLabelKey(activeConnectionRoute.kind))
    : null;
  const webRtcTransportKind = useWebRtcLinkSelector((state) => state.transportKind);
  // 走 CodingNS Connect 时，用户更关心「直连还是经中继」，所以优先显示这一层说法。
  const linkTypeLabelKey = resolveLinkTransportLabelKey(webRtcTransportKind);
  const linkTypeLabel = linkTypeLabelKey ? t(linkTypeLabelKey) : null;

  useEffect(() => {
    if (connectionState === "connected" || connectionState === "closed") {
      dismissToast("conversation-connection-state");
      return;
    }

    if (connectionState === "reconnect_failed") {
      showToast({
        id: "conversation-connection-state",
        title: t("conversation.connectionReconnectFailed"),
        description: linkTypeLabel
          ? t("conversation.reconnectFailedExplainWithLinkType", { linkType: linkTypeLabel })
          : activeConnectionRouteLabel
            ? t("conversation.reconnectFailedExplainWithRoute", { route: activeConnectionRouteLabel })
            : t("conversation.reconnectFailedExplain"),
        tone: "warning",
        durationMs: null,
        action: {
          label: t("conversation.reconnectButton"),
          onClick: onReconnect
        }
      });
      return;
    }

    showToast({
      id: "conversation-connection-state",
      title: t("conversation.connectionReconnecting"),
      description: linkTypeLabel
        ? t("conversation.reconnectExplainWithLinkType", { linkType: linkTypeLabel })
        : activeConnectionRouteLabel
          ? t("conversation.reconnectExplainWithRoute", { route: activeConnectionRouteLabel })
          : t("conversation.reconnectExplain"),
      tone: "info",
      durationMs: 3200
    });
  }, [
    activeConnectionRouteLabel,
    connectionState,
    dismissToast,
    linkTypeLabel,
    onReconnect,
    showToast
  ]);

  return null;
}
