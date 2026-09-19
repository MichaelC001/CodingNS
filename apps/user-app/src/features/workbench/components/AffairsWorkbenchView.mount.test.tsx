import { render, screen } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { t } from "../../../shared/i18n";
import {
  createState,
  navigationGroups
} from "./AffairsWorkbenchView.test-support";
import {
  AffairsAuxiliaryPanel,
  AffairsSectionMenu,
  AffairsSidebarPanel,
  AffairsWorkbenchProvider,
  AffairsWorkbenchView
} from "./AffairsWorkbenchView";

/**
 * 助手服务（Butler）已经整体下线，右侧助手面板与工作台初始化页都已移除。
 * 这里只保留工作台本身在事务模式下的加载行为。
 */
describe("AffairsWorkbenchView 事务模式加载", () => {
  it("挂载后直接显示文档库内容，不再出现助手初始化页", async () => {
    function TestHarness(): ReactElement {
      const [state, setState] = useState(createState());

      return (
        <MemoryRouter initialEntries={["/workspaces/workspace-1/chats"]}>
          <AffairsWorkbenchProvider
            workspaceId="workspace-1"
            workspaceName="事务工作区"
            navigationGroups={navigationGroups}
            state={state}
            onStateChange={setState}
          >
            <div style={{ display: "flex", gap: 12 }}>
              <AffairsSectionMenu />
              <AffairsSidebarPanel />
              <AffairsWorkbenchView workspaceId="workspace-1" />
              <AffairsAuxiliaryPanel workspaceId="workspace-1" />
            </div>
          </AffairsWorkbenchProvider>
        </MemoryRouter>
      );
    }

    render(<TestHarness />);

    expect(await screen.findByText("Exchange 分层通讯簿.txt")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("shell.affairsInitSubmit") })).not.toBeInTheDocument();
    expect(screen.queryByText(t("shell.affairsInitRouteGuardHint"))).not.toBeInTheDocument();
  });
});
