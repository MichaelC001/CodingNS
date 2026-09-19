import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { t } from "../../../shared/i18n";
import {
  butlerApiMock,
  butlerRuntimeCallsMock,
  createState,
  renderWorkbenchWithState,
  useButlerRuntimeStoreMock
} from "./AffairsWorkbenchView.test-support";

/**
 * 助手服务（Butler）已经整体下线：工作台加载不再依赖助手初始化状态，
 * 也不再在挂载时发起任何助手服务请求。这里锁定这些约束，避免以后回退。
 */
describe("AffairsWorkbenchView 与助手服务解耦", () => {
  it("助手运行时没有初始化时，工作台直接显示文档内容", async () => {
    useButlerRuntimeStoreMock.mockImplementation((_store, selector) => selector({
      initialized: false,
      loading: false,
      profile: null,
      activeProvider: "codex",
      controlSession: null,
      capabilities: null,
      messages: [],
      historyState: "idle",
      loadingOlderMessages: false,
      hasOlderMessages: false,
      runtimeHasActiveRun: false,
      runtimeCanInterrupt: false,
      contextUsage: null,
      permissionRequests: [],
      sending: false
    }));

    renderWorkbenchWithState(createState());

    expect(await screen.findByText("Exchange 分层通讯簿.txt")).toBeInTheDocument();
    expect(screen.queryByText(t("shell.affairsInitRouteGuardHint"))).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("shell.affairsInitSubmit") })).not.toBeInTheDocument();
  });

  it("助手服务连不上时不会把文档主区换成不可用页", async () => {
    useButlerRuntimeStoreMock.mockImplementation((_store, selector) => selector({
      initialized: false,
      loading: false,
      bootstrapErrorCode: "NETWORK_ERROR",
      error: "请求 http://127.0.0.1:4174/api/butler/profile 失败：fetch failed",
      profile: null,
      activeProvider: "codex",
      controlSession: null,
      capabilities: null,
      messages: [],
      historyState: "idle",
      loadingOlderMessages: false,
      hasOlderMessages: false,
      runtimeHasActiveRun: false,
      runtimeCanInterrupt: false,
      contextUsage: null,
      permissionRequests: [],
      sending: false
    }));

    renderWorkbenchWithState(createState());

    expect(await screen.findByText("Exchange 分层通讯簿.txt")).toBeInTheDocument();
    expect(screen.queryByText(t("shell.affairsHostUnavailableTitle"))).not.toBeInTheDocument();
    expect(screen.queryByText(t("shell.affairsInitRouteGuardHint"))).not.toBeInTheDocument();
  });

  it("助手服务返回无效响应时也不会阻塞工作台", async () => {
    useButlerRuntimeStoreMock.mockImplementation((_store, selector) => selector({
      initialized: false,
      loading: false,
      bootstrapErrorCode: "INVALID_RESPONSE",
      error: "服务返回了无效的 JSON 响应：Unexpected token '<'",
      profile: null,
      activeProvider: "codex",
      controlSession: null,
      capabilities: null,
      messages: [],
      historyState: "idle",
      loadingOlderMessages: false,
      hasOlderMessages: false,
      runtimeHasActiveRun: false,
      runtimeCanInterrupt: false,
      contextUsage: null,
      permissionRequests: [],
      sending: false
    }));

    renderWorkbenchWithState(createState());

    expect(await screen.findByText("Exchange 分层通讯簿.txt")).toBeInTheDocument();
    expect(screen.queryByText(t("shell.affairsConnectionCheckingTitle"))).not.toBeInTheDocument();
    expect(screen.queryByText(t("shell.affairsHostUnavailableErrorTitle"))).not.toBeInTheDocument();
  });

  it("工作台加载过程中不会发起任何助手服务请求", async () => {
    renderWorkbenchWithState(createState());

    expect(await screen.findByText("Exchange 分层通讯簿.txt")).toBeInTheDocument();
    expect(butlerApiMock.listButlerInboxItems).not.toHaveBeenCalled();
    expect(butlerApiMock.listButlerFollowUpTasks).not.toHaveBeenCalled();
    expect(butlerApiMock.listAssistantAutomations).not.toHaveBeenCalled();
    expect(butlerApiMock.listRecentAssistantAutomationRuns).not.toHaveBeenCalled();
    expect(butlerApiMock.listButlerControlSessions).not.toHaveBeenCalled();
    expect(butlerApiMock.listButlerProjects).not.toHaveBeenCalled();
    expect(butlerRuntimeCallsMock.initialize).not.toHaveBeenCalled();
  });

  it("右侧辅助面板不再提供助手标签", async () => {
    renderWorkbenchWithState({
      ...createState(),
      primarySection: "library",
      auxiliaryTab: "detail",
      selectedNodeId: "library:folder:root"
    });

    expect(await screen.findByText("Exchange 分层通讯簿.txt")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: t("shell.affairsAssistantTitle") })).not.toBeInTheDocument();
    expect(screen.queryByText(t("shell.affairsConnectionCheckingAuxiliaryEmpty"))).not.toBeInTheDocument();
  });

  it("偏好里停留在助手标签页时会降级到详情面板", async () => {
    renderWorkbenchWithState({
      ...createState(),
      primarySection: "library",
      auxiliaryTab: "assistant",
      selectedNodeId: "library:folder:root"
    });

    expect(await screen.findByText("Exchange 分层通讯簿.txt")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: t("shell.affairsAssistantTitle") })).not.toBeInTheDocument();
  });
});
