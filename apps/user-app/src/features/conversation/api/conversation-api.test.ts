import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelWorkspaceSessionScan,
  createWorktree,
  getParallelGroupDetail,
  getSessionMessages,
  getWorkspaceSessionScanStatus,
  listWorkspaceSessions,
  requestWorkspaceSessionScan,
  resetSessionMessageRequestCacheForTesting
} from "./conversation-api";

const { request } = vi.hoisted(() => ({
  request: vi.fn()
}));

vi.mock("../../../network/http-client", () => ({
  httpClient: {
    request
  }
}));

describe("conversation-api 会话请求边界", () => {
  beforeEach(() => {
    resetSessionMessageRequestCacheForTesting();
    request.mockReset();
  });

  it("普通列表只请求索引，不请求历史、虚拟会话或子 Agent 数据", async () => {
    request.mockResolvedValue({ items: [] });

    await listWorkspaceSessions("workspace-1", { targetHostId: "peer-1" });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "/api/sessions?workspaceId=workspace-1",
      { targetHostId: "peer-1" }
    );
    expect(request.mock.calls.some(([url]) => String(url).includes("/messages"))).toBe(false);
  });

  it("普通列表即使包含子 Agent 和并行摘要，也不会额外加载虚拟会话或历史", async () => {
    request.mockResolvedValue({
      items: [
        {
          sessionId: "parent-session",
          parentSessionId: null,
          isSubagent: false,
          parallelGroup: {
            groupId: "parallel-group-1",
            role: "anchor",
            memberCount: 2
          }
        },
        {
          sessionId: "child-session",
          parentSessionId: "parent-session",
          isSubagent: true,
          subagentLabel: "worker"
        }
      ]
    });

    const response = await listWorkspaceSessions("workspace-1");

    expect(response.items).toHaveLength(2);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.some(([url]) => String(url).includes("/messages"))).toBe(false);
    expect(request.mock.calls.some(([url]) => String(url).includes("parallel-groups"))).toBe(false);
  });

  it("子 Agent 历史和并行详情只在对应详情动作后各请求一次", async () => {
    request
      .mockResolvedValueOnce({
        items: [{
          sessionId: "parent-session",
          parentSessionId: null,
          isSubagent: false,
          parallelGroup: {
            groupId: "parallel-group-1",
            role: "anchor",
            memberCount: 2
          }
        }, {
          sessionId: "subagent-session",
          parentSessionId: "parent-session",
          isSubagent: true,
          subagentLabel: "worker"
        }]
      })
      .mockResolvedValueOnce({ messages: [], cursor: null, nextCursor: null, total: 0 })
      .mockResolvedValueOnce({ group: { id: "parallel-group-1" }, members: [] });

    await listWorkspaceSessions("workspace-1");
    expect(request).toHaveBeenCalledTimes(1);

    await getSessionMessages("subagent-session", null, 30, "backward");
    await getParallelGroupDetail("parallel-group-1");

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[1]?.[0]).toBe(
      "/api/sessions/subagent-session/messages?limit=30&direction=backward"
    );
    expect(request.mock.calls[2]?.[0]).toBe("/api/parallel-groups/parallel-group-1");
  });

  it("打开具体会话时只请求带游标协议的首屏历史", async () => {
    request.mockResolvedValue({ messages: [], cursor: null, nextCursor: "older-1", total: 120 });

    await getSessionMessages("session-1", null, 30, "backward", { targetHostId: "peer-1" });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "/api/sessions/session-1/messages?limit=30&direction=backward",
      expect.objectContaining({ targetHostId: "peer-1", signal: expect.any(AbortSignal) })
    );
  });

  it("同一会话、同一分页和同一 Host 会复用带 AbortSignal 的同一个 Promise", async () => {
    const response = {
      messages: [],
      cursor: null,
      nextCursor: null,
      total: 0
    };
    request.mockResolvedValue(response);

    const first = getSessionMessages(
      "session-1",
      null,
      20,
      "backward",
      { targetHostId: "peer-1", signal: new AbortController().signal }
    );
    const second = getSessionMessages(
      "session-1",
      null,
      20,
      "backward",
      { targetHostId: "peer-1", signal: new AbortController().signal }
    );

    expect(second).toBe(first);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "/api/sessions/session-1/messages?limit=20&direction=backward",
      expect.objectContaining({
        targetHostId: "peer-1",
        signal: expect.any(AbortSignal)
      })
    );

    await first;
  });

  it("不同 cursor、limit、direction 或 Host 保持独立请求", async () => {
    request.mockResolvedValue({ messages: [], cursor: null, nextCursor: null, total: 0 });

    getSessionMessages("session-1", null, 20, "backward", { targetHostId: "peer-1" });
    getSessionMessages("session-1", "cursor-1", 20, "backward", { targetHostId: "peer-1" });
    getSessionMessages("session-1", null, 10, "backward", { targetHostId: "peer-1" });
    getSessionMessages("session-1", null, 20, "forward", { targetHostId: "peer-1" });
    getSessionMessages("session-1", null, 20, "backward", { targetHostId: "peer-2" });

    expect(request).toHaveBeenCalledTimes(5);
  });

  it("调用前已取消的历史请求不会新建网络请求", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      getSessionMessages("session-1", null, 20, "backward", { signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(request).not.toHaveBeenCalled();
  });

  it("唯一订阅者取消后会清掉失效缓存，后续同参数调用可以重新请求", async () => {
    request.mockImplementation((_url: string, options: { signal?: AbortSignal }) => (
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => {
          reject(new DOMException("已取消", "AbortError"));
        }, { once: true });
      })
    ));

    const firstController = new AbortController();
    const first = getSessionMessages("session-1", null, 20, "backward", {
      signal: firstController.signal
    });
    void first.catch(() => undefined);
    firstController.abort();

    const second = getSessionMessages("session-1", null, 20, "backward");

    expect(second).not.toBe(first);
    expect(request).toHaveBeenCalledTimes(2);
    resetSessionMessageRequestCacheForTesting();
  });

  it("扫描的创建、状态查询和取消都沿用同一个远程 Host", async () => {
    request
      .mockResolvedValueOnce({ taskId: "task-1" })
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce({ status: "cancelled" });

    await requestWorkspaceSessionScan("workspace-1", { targetHostId: "peer-1" });
    await getWorkspaceSessionScanStatus("workspace-1", { targetHostId: "peer-1" });
    await cancelWorkspaceSessionScan("workspace-1", { targetHostId: "peer-1" });

    expect(request).toHaveBeenNthCalledWith(
      1,
      "/api/sessions/discovery/scan",
      expect.objectContaining({ method: "POST", targetHostId: "peer-1" })
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/api/sessions/discovery/status?workspaceId=workspace-1",
      expect.objectContaining({ targetHostId: "peer-1" })
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      "/api/sessions/discovery/scan?workspaceId=workspace-1",
      expect.objectContaining({ method: "DELETE", targetHostId: "peer-1" })
    );
  });

  it("创建子工作树会沿用当前远程 Host", async () => {
    request.mockResolvedValue({ workspace: {}, meta: {} });

    await createWorktree(
      { sourceWorkspaceId: "workspace-1", branchName: "feat/child" },
      { targetHostId: "peer-1" }
    );

    expect(request).toHaveBeenCalledWith(
      "/api/worktrees",
      expect.objectContaining({ method: "POST", targetHostId: "peer-1" })
    );
  });

  it("并行会话详情支持带 Host 作用域的请求", async () => {
    request.mockResolvedValue({ group: { id: "group-1" }, members: [] });

    await getParallelGroupDetail("group-1", { targetHostId: "peer-1" });

    expect(request).toHaveBeenCalledWith(
      "/api/parallel-groups/group-1",
      expect.objectContaining({ targetHostId: "peer-1" })
    );
  });
});
