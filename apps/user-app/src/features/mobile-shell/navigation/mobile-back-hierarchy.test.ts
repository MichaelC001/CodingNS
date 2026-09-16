import { describe, expect, it } from "vitest";

import { resolveMobileBackTarget } from "./mobile-back-hierarchy";

describe("resolveMobileBackTarget", () => {
  it("会话消息页回到同一个工作区的会话列表", () => {
    expect(
      resolveMobileBackTarget({
        pathname: "/workspaces/workspace-1/sessions/session-9"
      })
    ).toEqual({
      kind: "navigate",
      to: "/workspaces/workspace-1/sessions"
    });
  });

  it("会话列表回到工作区首页", () => {
    expect(
      resolveMobileBackTarget({
        pathname: "/workspaces/workspace-1/sessions"
      })
    ).toEqual({
      kind: "navigate",
      to: "/workspaces"
    });
  });

  it("工作区首页再按一次是退出程序", () => {
    expect(resolveMobileBackTarget({ pathname: "/workspaces" })).toEqual({ kind: "exit" });
  });

  it("对话消息页回到对话列表", () => {
    expect(resolveMobileBackTarget({ pathname: "/chats/chat-3" })).toEqual({
      kind: "navigate",
      to: "/chats"
    });
    expect(resolveMobileBackTarget({ pathname: "/chats/new" })).toEqual({
      kind: "navigate",
      to: "/chats"
    });
  });

  it("对话列表回到工作区首页", () => {
    expect(resolveMobileBackTarget({ pathname: "/chats" })).toEqual({
      kind: "navigate",
      to: "/workspaces"
    });
  });

  it("一级页面先回工作区首页", () => {
    for (const pathname of [
      "/workspaces/workspace-1",
      "/workspaces/workspace-1/terminals",
      "/settings",
      "/settings/relay"
    ]) {
      expect(resolveMobileBackTarget({ pathname })).toEqual({
        kind: "navigate",
        to: "/workspaces"
      });
    }
  });

  it("工具详情页先回工具首页", () => {
    expect(
      resolveMobileBackTarget({
        pathname: "/workspaces/workspace-1/tools/processes"
      })
    ).toEqual({
      kind: "navigate",
      to: "/workspaces/workspace-1/terminals"
    });

    expect(
      resolveMobileBackTarget({
        pathname: "/workspaces/workspace-1/tools/files"
      })
    ).toEqual({
      kind: "navigate",
      to: "/workspaces/workspace-1/tools?tab=files"
    });
  });

  it("工具首页回工作区首页，不会原地打转", () => {
    // 这里曾经会把返回目标算成工具首页自己，导致按返回没有任何反应。
    expect(
      resolveMobileBackTarget({
        pathname: "/workspaces/workspace-1/tools"
      })
    ).toEqual({
      kind: "navigate",
      to: "/workspaces"
    });

    expect(
      resolveMobileBackTarget({
        pathname: "/workspaces/workspace-1/tools",
        search: "?tab=git"
      })
    ).toEqual({
      kind: "navigate",
      to: "/workspaces"
    });
  });

  it("带尾斜杠的地址按同一层级处理", () => {
    expect(resolveMobileBackTarget({ pathname: "/workspaces/" })).toEqual({ kind: "exit" });
  });

  it("保留会话页上的目标主机参数", () => {
    expect(
      resolveMobileBackTarget({
        pathname: "/workspaces/workspace-1/sessions/session-9",
        search: "?targetHostId=host-2"
      })
    ).toEqual({
      kind: "navigate",
      to: "/workspaces/workspace-1/sessions?targetHostId=host-2"
    });
  });
});
