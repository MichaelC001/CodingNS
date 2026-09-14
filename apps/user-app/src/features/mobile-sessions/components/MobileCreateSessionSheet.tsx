import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import {
  ModalField,
  ModalActions,
  ModalList,
  ModalListItem,
  ModalSection,
  ModalTag
} from "../../../components/ModalAtoms";
import { MobileSheet } from "../../../components/MobileSheet";
import { useHaptics } from "../../../shared/haptics";
import { t } from "../../../shared/i18n";
import {
  cancelWorkspaceSessionScan,
  getWorkspaceSessionScanStatus,
  requestWorkspaceSessionScan,
  type ProviderId,
  type WorkspaceDto
} from "../../conversation/api/conversation-api";
import { SessionProviderPicker } from "../../conversation/components/SessionProviderPicker";
import type { MobileWorkspaceOption } from "../../workbench/utils/mobile-workspace-tree";

interface MobileCreateSessionSheetProps {
  readonly open: boolean;
  readonly workspaces: readonly WorkspaceDto[];
  readonly workspaceOptions?: readonly MobileWorkspaceOption[];
  readonly initialWorkspaceId: string | null;
  readonly resolveTargetHostId?: (workspaceId: string) => string | null;
  readonly onClose: () => void;
  readonly onSelect: (workspaceId: string, provider: ProviderId) => void;
}

export function MobileCreateSessionSheet({
  open,
  workspaces,
  workspaceOptions,
  initialWorkspaceId,
  resolveTargetHostId,
  onClose,
  onSelect
}: MobileCreateSessionSheetProps) {
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [scanStatus, setScanStatus] = useState<"idle" | "scanning" | "success" | "error">("idle");
  const [scanResultCount, setScanResultCount] = useState<number | null>(null);
  const activeScanRef = useRef<ActiveWorkspaceScan | null>(null);
  const haptics = useHaptics();
  const selectionOptions = useMemo(
    () =>
      workspaceOptions ?? workspaces.map((workspace) => ({
        workspace,
        label: workspace.name,
        subtitle: workspace.path,
        depth: 0,
        kind: "workspace" as const,
        meta: null
      })),
    [workspaceOptions, workspaces]
  );
  const selectionOptionKey = useMemo(
    () => selectionOptions.map((item) => item.workspace.id).join("|"),
    [selectionOptions]
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    setSelectedWorkspaceId(resolveInitialWorkspaceId(selectionOptions, initialWorkspaceId));
    setWorkspacePickerOpen(false);
    setScanStatus("idle");
    setScanResultCount(null);
  }, [initialWorkspaceId, open, selectionOptionKey]);

  useEffect(() => {
    if (open) {
      return;
    }

    activeScanRef.current?.controller.abort();
    activeScanRef.current = null;
  }, [open]);

  useEffect(() => {
    return () => {
      activeScanRef.current?.controller.abort();
      activeScanRef.current = null;
    };
  }, []);

  if (!open) {
    return null;
  }

  const selectedWorkspaceOption =
    selectionOptions.find((item) => item.workspace.id === selectedWorkspaceId) ??
    selectionOptions[0] ??
    null;

  async function handleScanWorkspace() {
    if (!selectedWorkspaceId || scanStatus === "scanning") {
      return;
    }

    const targetHostId = resolveTargetHostId?.(selectedWorkspaceId) ?? null;
    const scan: ActiveWorkspaceScan = {
      workspaceId: selectedWorkspaceId,
      targetHostId,
      controller: new AbortController(),
      cancelRequested: false
    };

    activeScanRef.current = scan;
    setScanStatus("scanning");
    setScanResultCount(null);

    try {
      await requestWorkspaceSessionScan(selectedWorkspaceId, {
        targetHostId,
        signal: scan.controller.signal
      });
      if (scan.controller.signal.aborted) {
        return;
      }

      let status = await getWorkspaceSessionScanStatus(selectedWorkspaceId, {
        targetHostId,
        signal: scan.controller.signal
      });
      for (let attempt = 0; attempt < 120 && (status.status === "queued" || status.status === "running"); attempt += 1) {
        if (!(await waitForScanPoll(scan.controller.signal, 500))) {
          return;
        }
        status = await getWorkspaceSessionScanStatus(selectedWorkspaceId, {
          targetHostId,
          signal: scan.controller.signal
        });
      }
      if (scan.controller.signal.aborted) {
        return;
      }

      if (status.status !== "succeeded") {
        throw new Error(status.errorMessage ?? t("shell.workspaceSessionScanFailed"));
      }
      setScanResultCount(status.resultCount);
      setScanStatus("success");
    } catch {
      if (!scan.cancelRequested && !scan.controller.signal.aborted) {
        setScanStatus("error");
      }
    } finally {
      if (activeScanRef.current === scan) {
        activeScanRef.current = null;
      }
    }
  }

  async function handleCancelWorkspaceScan() {
    const scan = activeScanRef.current;
    if (!scan) {
      return;
    }

    scan.cancelRequested = true;
    // 先停止本地轮询和共享请求，再通知实际工作区所在 Host 取消任务。
    scan.controller.abort();

    try {
      await cancelWorkspaceSessionScan(scan.workspaceId, {
        targetHostId: scan.targetHostId
      });
    } catch {
      // 取消请求失败时，服务端任务仍可能继续；本地不再继续轮询，避免污染其他会话。
    } finally {
      if (activeScanRef.current === scan) {
        activeScanRef.current = null;
        setScanStatus("idle");
        setScanResultCount(null);
      }
    }
  }

  return (
    <MobileSheet
      open={open}
      title={t("shell.createSessionModalTitle")}
      description={t("shell.createSessionModalDescription")}
      kind="form"
      height="three-quarter"
      className="mobile-create-session-sheet"
      cardClassName="mobile-create-session-sheet-card"
      bodyClassName="mobile-feature-form mobile-workspace-home-form mobile-create-session-form"
      showHandle
      onClose={onClose}
    >
      <ModalSection className="mobile-create-session-section" tone="accent">
        <ModalField label={t("shell.createSessionWorkspaceLabel")}>
          <button
            type="button"
            className="mobile-create-session-workspace-trigger"
            aria-label={`${t("shell.createSessionWorkspaceLabel")} ${selectedWorkspaceOption?.label ?? ""}`.trim()}
            aria-expanded={workspacePickerOpen ? "true" : "false"}
            disabled={selectionOptions.length === 0}
            onClick={() => {
              void haptics.trigger("selection");
              setWorkspacePickerOpen((current) => !current);
            }}
          >
            <span className="mobile-create-session-workspace-copy">
              <strong>{selectedWorkspaceOption?.label ?? t("common.unknown")}</strong>
              <span>{selectedWorkspaceOption?.subtitle ?? t("common.unknown")}</span>
            </span>
            <ChevronDownIcon expanded={workspacePickerOpen} />
          </button>
          {workspacePickerOpen ? (
            <ModalList className="mobile-workspace-home-group mobile-create-session-workspace-list" role="list">
              {selectionOptions.map((item) => (
                <ModalListItem
                  key={item.workspace.id}
                  as="button"
                  className="mobile-workspace-home-row mobile-create-session-workspace-row"
                  data-worktree-kind={item.kind}
                  data-worktree-depth={item.depth}
                  selected={item.workspace.id === selectedWorkspaceId}
                  trailing={
                    <span className="mobile-workspace-home-row-trailing">
                      {item.workspace.id === selectedWorkspaceId ? <CheckIcon /> : <ChevronRightIcon />}
                    </span>
                  }
                  style={
                    {
                      "--mobile-workspace-tree-depth": String(item.depth)
                    } as CSSProperties
                  }
                  onClick={() => {
                    if (item.workspace.id !== selectedWorkspaceId) {
                      void haptics.trigger("selection");
                    }
                    setSelectedWorkspaceId(item.workspace.id);
                    setWorkspacePickerOpen(false);
                  }}
                >
                  <span className="mobile-create-session-workspace-option-copy">
                    <strong>
                      {item.kind === "worktree" ? (
                        <ModalTag className="mobile-workspace-home-worktree-badge">
                          {t("shell.mobileWorktreeBadge")}
                        </ModalTag>
                      ) : null}
                      {item.label}
                    </strong>
                    <span>{item.subtitle}</span>
                  </span>
                </ModalListItem>
              ))}
            </ModalList>
          ) : null}
        </ModalField>
      </ModalSection>

      <ModalSection className="mobile-create-session-scan-section">
        <ModalActions align="start">
          <button
            type="button"
            className="secondary-button"
            disabled={!selectedWorkspaceId || scanStatus === "scanning"}
            onClick={() => {
              void haptics.trigger("selection");
              void handleScanWorkspace();
            }}
          >
            {scanStatus === "scanning"
              ? t("shell.workspaceSessionScanScanning")
              : scanStatus === "success"
                ? t("shell.workspaceSessionScanSucceeded", { count: scanResultCount ?? 0 })
                : t("shell.workspaceSessionScanAction")}
          </button>
          {scanStatus === "scanning" ? (
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                void haptics.trigger("selection");
                void handleCancelWorkspaceScan();
              }}
            >
              {t("shell.workspaceSessionScanCancel")}
            </button>
          ) : null}
        </ModalActions>
        {scanStatus === "error" ? (
          <span className="mobile-create-session-scan-error">{t("shell.workspaceSessionScanFailed")}</span>
        ) : null}
      </ModalSection>

      <ModalSection
        className="mobile-create-session-provider-block"
        heading={t("shell.createSessionProviderLabel")}
      >
        <SessionProviderPicker
          disabled={!selectedWorkspaceId}
          workspaceId={selectedWorkspaceId || null}
          onSelect={(provider) => {
            if (!selectedWorkspaceId) {
              return;
            }

            onSelect(selectedWorkspaceId, provider);
          }}
        />
      </ModalSection>
    </MobileSheet>
  );
}

interface ActiveWorkspaceScan {
  workspaceId: string;
  targetHostId: string | null;
  controller: AbortController;
  cancelRequested: boolean;
}

function waitForScanPoll(signal: AbortSignal, delayMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }

    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    const onAbort = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function resolveInitialWorkspaceId(
  workspaceOptions: readonly MobileWorkspaceOption[],
  initialWorkspaceId: string | null
) {
  if (initialWorkspaceId && workspaceOptions.some((item) => item.workspace.id === initialWorkspaceId)) {
    return initialWorkspaceId;
  }

  return workspaceOptions[0]?.workspace.id ?? "";
}

function ChevronDownIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="mobile-create-session-workspace-chevron"
      data-expanded={expanded ? "true" : "false"}
    >
      <path
        d="M4 6.5L8 10l4-3.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M6 3.5L10.5 8 6 12.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3.5 8.5L6.5 11.5L12.5 5.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}
