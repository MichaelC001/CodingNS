import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { t } from "../../../shared/i18n";
import type { WorkspaceDto } from "../../conversation/api/conversation-api";
import { MobileCreateSessionSheet } from "./MobileCreateSessionSheet";

const { requestWorkspaceSessionScan, getWorkspaceSessionScanStatus } = vi.hoisted(() => ({
  requestWorkspaceSessionScan: vi.fn(),
  getWorkspaceSessionScanStatus: vi.fn()
}));

vi.mock("../../conversation/api/conversation-api", async () => {
  const actual = await vi.importActual<typeof import("../../conversation/api/conversation-api")>(
    "../../conversation/api/conversation-api"
  );
  return {
    ...actual,
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
    expect(requestWorkspaceSessionScan).toHaveBeenCalledWith(workspace.id, { targetHostId: "peer-1" });
  });
});
