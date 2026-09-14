import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { t } from "../../../shared/i18n";
import type { WorkspaceDto } from "../../conversation/api/conversation-api";
import { MobileCreateSessionSheet } from "./MobileCreateSessionSheet";

const {
  cancelWorkspaceSessionScan,
  requestWorkspaceSessionScan,
  getWorkspaceSessionScanStatus
} = vi.hoisted(() => ({
  cancelWorkspaceSessionScan: vi.fn(),
  requestWorkspaceSessionScan: vi.fn(),
  getWorkspaceSessionScanStatus: vi.fn()
}));

vi.mock("../../conversation/api/conversation-api", async () => {
  const actual = await vi.importActual<typeof import("../../conversation/api/conversation-api")>(
    "../../conversation/api/conversation-api"
  );
  return {
    ...actual,
    cancelWorkspaceSessionScan,
    requestWorkspaceSessionScan,
    getWorkspaceSessionScanStatus
  };
});

vi.mock("../../conversation/components/SessionProviderPicker", () => ({
  SessionProviderPicker: () => <div data-testid="session-provider-picker" />
}));

const workspace: WorkspaceDto = {
  id: "workspace-1",
  name: "项目一",
  path: "/tmp/workspace-1",
  repoRoot: "/tmp/workspace-1"
};

describe("MobileCreateSessionSheet 扫描动作", () => {
  beforeEach(() => {
    cancelWorkspaceSessionScan.mockReset();
    requestWorkspaceSessionScan.mockReset();
    getWorkspaceSessionScanStatus.mockReset();
  });

  it("点击扫描按钮后复用任务并显示完成数量", async () => {
    requestWorkspaceSessionScan.mockResolvedValue({
      workspaceId: workspace.id,
      taskId: "task-1",
      deduped: false,
      taskType: "workspace.discovery.explicit_scan",
      executionLane: "helper_process"
    });
    getWorkspaceSessionScanStatus
      .mockResolvedValueOnce({ workspaceId: workspace.id, taskId: "task-1", status: "running" })
      .mockResolvedValueOnce({
        workspaceId: workspace.id,
        taskId: "task-1",
        status: "succeeded",
        resultCount: 3,
        errorMessage: null
      });

    const user = userEvent.setup();
    render(
      <MobileCreateSessionSheet
        open
        workspaces={[workspace]}
        initialWorkspaceId={workspace.id}
        resolveTargetHostId={() => "peer-1"}
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: t("shell.workspaceSessionScanAction") }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: t("shell.workspaceSessionScanSucceeded", { count: 3 }) }))
        .toBeInTheDocument();
    });
    expect(requestWorkspaceSessionScan).toHaveBeenCalledWith(
      workspace.id,
      expect.objectContaining({
        targetHostId: "peer-1",
        signal: expect.any(AbortSignal)
      })
    );
    expect(getWorkspaceSessionScanStatus).toHaveBeenCalledWith(
      workspace.id,
      expect.objectContaining({ targetHostId: "peer-1", signal: expect.any(AbortSignal) })
    );
  });

  it("扫描进行中会禁用按钮，重复点击不会创建第二个任务", async () => {
    let resolveScan: ((value: unknown) => void) | null = null;
    requestWorkspaceSessionScan.mockImplementation(
      () => new Promise((resolve) => {
        resolveScan = resolve;
      })
    );
    getWorkspaceSessionScanStatus.mockResolvedValue({
      workspaceId: workspace.id,
      taskId: "task-2",
      status: "succeeded",
      resultCount: 1,
      errorMessage: null
    });

    const user = userEvent.setup();
    render(
      <MobileCreateSessionSheet
        open
        workspaces={[workspace]}
        initialWorkspaceId={workspace.id}
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    const scanButton = screen.getByRole("button", { name: t("shell.workspaceSessionScanAction") });
    await user.click(scanButton);
    await waitFor(() => expect(scanButton).toBeDisabled());

    await user.click(scanButton);
    expect(requestWorkspaceSessionScan).toHaveBeenCalledTimes(1);

    resolveScan?.({
      workspaceId: workspace.id,
      taskId: "task-2",
      deduped: true,
      taskType: "workspace.discovery.explicit_scan",
      executionLane: "helper_process"
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: t("shell.workspaceSessionScanSucceeded", { count: 1 }) }))
        .toBeInTheDocument();
    });
  });

  it("扫描失败会保留弹窗并显示错误状态", async () => {
    requestWorkspaceSessionScan.mockRejectedValue(new Error("扫描失败"));

    const user = userEvent.setup();
    render(
      <MobileCreateSessionSheet
        open
        workspaces={[workspace]}
        initialWorkspaceId={workspace.id}
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: t("shell.workspaceSessionScanAction") }));

    await waitFor(() => {
      expect(screen.getByText(t("shell.workspaceSessionScanFailed"))).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: t("shell.workspaceSessionScanAction") })).toBeInTheDocument();
  });

  it("远程工作区取消扫描时会沿用扫描开始时的 targetHostId", async () => {
    let resolveScan: ((value: unknown) => void) | null = null;
    requestWorkspaceSessionScan.mockImplementation(
      () => new Promise((resolve) => {
        resolveScan = resolve;
      })
    );
    cancelWorkspaceSessionScan.mockResolvedValue({
      workspaceId: workspace.id,
      taskId: "task-3",
      status: "cancelled",
      resultCount: null,
      errorCode: null,
      errorMessage: null,
      progress: null
    });

    const user = userEvent.setup();
    render(
      <MobileCreateSessionSheet
        open
        workspaces={[workspace]}
        initialWorkspaceId={workspace.id}
        resolveTargetHostId={() => "peer-1"}
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: t("shell.workspaceSessionScanAction") }));
    const cancelButton = await screen.findByRole("button", { name: t("shell.workspaceSessionScanCancel") });
    await user.click(cancelButton);

    await waitFor(() => {
      expect(cancelWorkspaceSessionScan).toHaveBeenCalledWith(workspace.id, {
        targetHostId: "peer-1"
      });
      expect(screen.getByRole("button", { name: t("shell.workspaceSessionScanAction") })).toBeInTheDocument();
    });

    resolveScan?.({
      workspaceId: workspace.id,
      taskId: "task-3",
      deduped: false,
      taskType: "workspace.discovery.explicit_scan",
      executionLane: "helper_process"
    });
  });
});
