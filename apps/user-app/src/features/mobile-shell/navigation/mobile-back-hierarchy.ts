import { matchPath } from "react-router-dom";

import type { WorkspaceRef } from "../../conversation/api/conversation-api";
import { buildWorkspaceSessionIndexPath } from "../../workbench/utils/workbench-navigation";
import { resolveMobileToolBackHref } from "../components/mobile-workbench-shell-route";

/**
 * 移动端返回层级。
 *
 * 规则固定为：会话消息页 → 会话列表 → 工作区首页 → 退出程序。
 * 设置子页面 → 设置列表 → 工作区首页。
 * 其余一级页面（工作区详情、工具、终端等）先回工作区首页。
 * 这里不看浏览历史，只看当前地址，避免返回键在历史页面里乱跳。
 */
export const MOBILE_WORKSPACE_HOME_PATH = "/workspaces";
export const MOBILE_CHAT_INDEX_PATH = "/chats";
export const MOBILE_SETTINGS_PATH = "/settings";

export type MobileBackTarget =
  | { readonly kind: "navigate"; readonly to: string }
  | { readonly kind: "exit" };

export interface MobileBackLocationInput {
  readonly pathname: string;
  readonly search?: string;
}

const WORKSPACE_SESSION_PATH = "/workspaces/:workspaceId/sessions/:sessionId";
const WORKSPACE_SESSION_INDEX_PATH = "/workspaces/:workspaceId/sessions";
const WORKSPACE_CHAT_INDEX_PATH = "/workspaces/:workspaceId/chats";
const SETTINGS_SECTION_PATH = "/settings/:section";
const CHAT_MESSAGE_PATHS = ["/chats/:chatId", "/chats/new"] as const;
const WORKSPACE_CHAT_MESSAGE_PATHS = [
  "/workspaces/:workspaceId/chats/:chatId",
  "/workspaces/:workspaceId/chats/new"
] as const;

export function resolveMobileBackTarget(input: MobileBackLocationInput): MobileBackTarget {
  const pathname = normalizePathname(input.pathname);

  // 工作区首页就是移动端的主页面，再按一次才退出程序。
  if (pathname === MOBILE_WORKSPACE_HOME_PATH) {
    return { kind: "exit" };
  }

  const sessionMatch = matchPath(WORKSPACE_SESSION_PATH, pathname);
  const workspaceId = sessionMatch?.params.workspaceId?.trim();

  if (workspaceId) {
    return {
      kind: "navigate",
      to: buildWorkspaceSessionIndexPath(workspaceId, resolveWorkspaceRef(workspaceId, input.search))
    };
  }

  if (
    matchesAnyPath(CHAT_MESSAGE_PATHS, pathname)
    || matchesAnyPath(WORKSPACE_CHAT_MESSAGE_PATHS, pathname)
  ) {
    return { kind: "navigate", to: MOBILE_CHAT_INDEX_PATH };
  }

  if (
    matchPath(WORKSPACE_SESSION_INDEX_PATH, pathname)
    || matchPath(WORKSPACE_CHAT_INDEX_PATH, pathname)
    || pathname === MOBILE_CHAT_INDEX_PATH
  ) {
    return { kind: "navigate", to: MOBILE_WORKSPACE_HOME_PATH };
  }

  // 设置子页面先回设置列表；设置列表本身是底部 tab 的一级页面，走工作区首页规则。
  if (matchPath(SETTINGS_SECTION_PATH, pathname)) {
    return { kind: "navigate", to: MOBILE_SETTINGS_PATH };
  }

  // 工具详情页先回工具首页，和顶部返回按钮保持一致；工具首页本身走上面的工作区首页规则。
  const toolsHomeHref = resolveMobileToolBackHref(pathname, input.search ?? "");

  if (toolsHomeHref) {
    return { kind: "navigate", to: toolsHomeHref };
  }

  return { kind: "navigate", to: MOBILE_WORKSPACE_HOME_PATH };
}

function matchesAnyPath(patterns: readonly string[], pathname: string): boolean {
  return patterns.some((pattern) => Boolean(matchPath(pattern, pathname)));
}

function normalizePathname(pathname: string): string {
  const trimmed = pathname.trim();

  if (trimmed.length > 1 && trimmed.endsWith("/")) {
    return trimmed.replace(/\/+$/, "") || "/";
  }

  return trimmed;
}

function resolveWorkspaceRef(workspaceId: string, search?: string): WorkspaceRef {
  const targetHostId = new URLSearchParams(search ?? "").get("targetHostId")?.trim();

  return {
    hostId: targetHostId || "current",
    workspaceId
  };
}
