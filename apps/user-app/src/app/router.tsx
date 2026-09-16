import type { ComponentType, ReactNode } from "react";
import {
  Navigate,
  Outlet,
  createBrowserRouter,
  createMemoryRouter,
  useLocation,
  useParams
} from "react-router-dom";

import { useClientConfigSelector } from "../config/client-config-store";
import { useHostRuntimeBoundaryKey } from "../config/host-runtime-store";
import { LoginPage } from "../features/auth/pages/LoginPage";
import { TrustedEntryLandingPage } from "../features/auth/pages/TrustedEntryLandingPage";
import { useAuthSelector } from "../features/auth/store/auth-store";
import { BUTLER_FEATURE_ENABLED } from "../features/butler/butler-feature-status";
import { OnboardingEntryGuard } from "../features/setup/components/OnboardingEntryGuard";
import { resolveWorkbenchShellMode } from "../features/workbench/components/workbench-shell-mode";
import { usePlatform } from "../platform/platform-provider";
import { shouldShowTrustedEntryLanding } from "../config/trusted-entry-mode";
import { t } from "../shared/i18n";

function RuntimeResetBoundary({
  runtimeKey,
  children
}: {
  runtimeKey: string;
  children: ReactNode;
}) {
  return <div key={runtimeKey}>{children}</div>;
}

function AuthenticatedRuntimeOutlet() {
  const runtimeKey = useHostRuntimeBoundaryKey();

  return (
    <RuntimeResetBoundary runtimeKey={runtimeKey}>
      <Outlet />
    </RuntimeResetBoundary>
  );
}

function RequireAuth() {
  const config = useClientConfigSelector((state) => state);
  const platform = usePlatform();
  const session = useAuthSelector((state) => state.session);
  const sessionReady = useAuthSelector((state) => state.sessionReady);
  const location = useLocation();

  if (shouldShowTrustedEntryLanding(config, platform.platform)) {
    return <TrustedEntryLandingPage />;
  }

  if (!session) {
    const returnTo = `${location.pathname}${location.search}`;

    if (import.meta.env.MODE === "test") {
      if (typeof window !== "undefined") {
        window.history.replaceState({}, "", `/login?returnTo=${encodeURIComponent(returnTo)}`);
      }

      return <LoginPage />;
    }

    return <Navigate to={`/login?returnTo=${encodeURIComponent(returnTo)}`} replace />;
  }

  if (!sessionReady) {
    return <div>{t("common.loading")}</div>;
  }

  return <AuthenticatedRuntimeOutlet />;
}

function TrustedEntryAwareLoginPage() {
  const config = useClientConfigSelector((state) => state);
  const platform = usePlatform();

  if (shouldShowTrustedEntryLanding(config, platform.platform)) {
    return <TrustedEntryLandingPage />;
  }

  return <LoginPage />;
}

function WorkbenchIndexRedirect() {
  const platform = usePlatform();
  const shellMode = resolveWorkbenchShellMode(platform);

  return <Navigate to={shellMode === "mobile" ? "/workspaces" : "/landing"} replace />;
}

function LegacyWorkspaceChatRedirect() {
  const { workspaceId, chatId } = useParams<{ workspaceId?: string; chatId?: string }>();
  const location = useLocation();
  const isNewChat = location.pathname.endsWith("/chats/new") || chatId === "new";
  const destination = isNewChat
    ? "/chats/new"
    : chatId
      ? `/chats/${encodeURIComponent(chatId)}`
      : "/chats";

  return (
    <Navigate
      to={`${destination}${location.search}`}
      replace
      state={workspaceId ? { workspaceId } : undefined}
    />
  );
}

function lazyRouteComponent<T extends Record<string, unknown>, K extends keyof T>(
  load: () => Promise<T>,
  exportName: K
) {
  return async () => {
    const module = await load();

    return {
      Component: module[exportName] as ComponentType<object>
    };
  };
}

// 会受首次运行向导入口判定影响的路由：判定没走完之前，这些页面都可能被换成向导。
const onboardingGuardedRoutes = [
  {
    path: "/bootstrap",
    lazy: lazyRouteComponent(
      () => import("../features/auth/pages/BootstrapPage"),
      "BootstrapPage"
    )
  },
  {
    path: "/login",
    element: <TrustedEntryAwareLoginPage />
  },
  {
    path: "/",
    element: <RequireAuth />,
    children: [
      {
        path: "desktop-window/:windowId",
        lazy: lazyRouteComponent(
          () => import("../features/desktop-window/DesktopWindowPage"),
          "DesktopWindowPage"
        )
      },
      {
        lazy: lazyRouteComponent(
          () => import("../features/workbench/components/WorkbenchShellRoute"),
          "WorkbenchShellRoute"
        ),
        children: [
          {
            index: true,
            element: <WorkbenchIndexRedirect />
          },
          {
            path: "landing",
            lazy: lazyRouteComponent(
              () => import("../features/workbench/pages/WorkbenchLandingPage"),
              "WorkbenchLandingPage"
            )
          },
          {
            path: "workspaces",
            lazy: lazyRouteComponent(
              () => import("../features/mobile-workspaces/pages/WorkspaceHomePage"),
              "WorkspaceHomePage"
            )
          },
          {
            path: "workspaces/:workspaceId",
            lazy: lazyRouteComponent(
              () => import("../features/mobile-workspaces/pages/WorkspaceDetailPage"),
              "WorkspaceDetailPage"
            )
          },
          {
            path: "workspaces/:workspaceId/sessions",
            lazy: lazyRouteComponent(
              () => import("../features/mobile-sessions/pages/SessionIndexPage"),
              "SessionIndexPage"
            )
          },
          {
            path: "workspaces/:workspaceId/sessions/:sessionId",
            lazy: lazyRouteComponent(
              () => import("../features/conversation/pages/ConversationPage"),
              "ConversationPage"
            )
          },
          {
            path: "documents",
            element: null
          },
          {
            path: "workbench",
            element: null
          },
          {
            path: "chats",
            lazy: lazyRouteComponent(
              () => import("../features/mobile-chats/pages/ChatIndexPage"),
              "ChatIndexPage"
            )
          },
          {
            path: "chats/new",
            lazy: lazyRouteComponent(
              () => import("../features/pure-conversation/PureConversationPage"),
              "PureConversationPage"
            )
          },
          {
            path: "chats/:chatId",
            lazy: lazyRouteComponent(
              () => import("../features/pure-conversation/PureConversationPage"),
              "PureConversationPage"
            )
          },
          {
            path: "workspaces/:workspaceId/chats",
            element: <LegacyWorkspaceChatRedirect />
          },
          {
            path: "workspaces/:workspaceId/chats/new",
            element: <LegacyWorkspaceChatRedirect />
          },
          {
            path: "workspaces/:workspaceId/chats/:chatId",
            element: <LegacyWorkspaceChatRedirect />
          },
          {
            path: "workspaces/:workspaceId/tools",
            lazy: lazyRouteComponent(
              () => import("../features/mobile-tools/ToolsHomePage"),
              "ToolsHomePage"
            )
          },
          {
            path: "workspaces/:workspaceId/tools/files",
            lazy: lazyRouteComponent(
              () => import("../features/mobile-tools/ToolFilesPage"),
              "ToolFilesPage"
            )
          },
          {
            path: "workspaces/:workspaceId/tools/git",
            lazy: lazyRouteComponent(
              () => import("../features/mobile-tools/ToolGitPage"),
              "ToolGitPage"
            )
          },
          {
            path: "workspaces/:workspaceId/tools/processes",
            lazy: lazyRouteComponent(
              () => import("../features/mobile-tools/ToolProcessesPage"),
              "ToolProcessesPage"
            )
          },
          {
            path: "workspaces/:workspaceId/terminals",
            lazy: lazyRouteComponent(
              () => import("../features/terminal/pages/TerminalPage"),
              "TerminalPage"
            )
          },
          {
            path: "workspaces/:workspaceId/plugins",
            lazy: lazyRouteComponent(
              () => import("../features/plugins/pages/PluginsListPage"),
              "PluginsListPage"
            )
          },
          {
            path: "workspaces/:workspaceId/plugins/:pluginId",
            lazy: lazyRouteComponent(
              () => import("../features/plugins/pages/PluginDetailPage"),
              "PluginDetailPage"
            )
          },
          {
            path: "workspaces/:workspaceId/plugins/:pluginId/run",
            lazy: lazyRouteComponent(
              () => import("../features/plugins/pages/PluginContainerPage"),
              "PluginContainerPage"
            )
          },
          ...(BUTLER_FEATURE_ENABLED ? [{
            path: "workspaces/:workspaceId/butler",
            lazy: lazyRouteComponent(
              () => import("../features/butler/pages/AdaptiveButlerPage"),
              "AdaptiveButlerPage"
            )
          }] : []),
          {
            path: "settings",
            lazy: lazyRouteComponent(
              () => import("../features/settings/pages/SettingsPage"),
              "SettingsPage"
            )
          },
          {
            path: "settings/:section",
            lazy: lazyRouteComponent(
              () => import("../features/settings/pages/SettingsPage"),
              "SettingsPage"
            )
          },
          {
            path: "*",
            element: <WorkbenchIndexRedirect />
          }
        ]
      }
    ]
  }
];

// 向导入口本身、中继连接页和桌面窗口预览不走守卫，避免打断这些独立流程。
const appRoutes = [
  {
    path: "/setup",
    lazy: lazyRouteComponent(
      () => import("../features/setup/pages/SetupWizardPage"),
      "SetupWizardPage"
    )
  },
  {
    path: "/connect/:tunnelDomain",
    lazy: lazyRouteComponent(
      () => import("../features/auth/pages/RelayConnectEntryPage"),
      "RelayConnectEntryPage"
    )
  },
  {
    path: "/desktop-window-preview",
    lazy: lazyRouteComponent(
      () => import("../features/desktop-window/DesktopDetachPreviewPage"),
      "DesktopDetachPreviewPage"
    )
  },
  {
    element: <OnboardingEntryGuard />,
    children: onboardingGuardedRoutes
  }
];

export function createAppRouter() {
  if (import.meta.env.MODE === "test") {
    const initialEntry =
      typeof window === "undefined" ? "/" : `${window.location.pathname}${window.location.search}`;

    return createMemoryRouter(appRoutes, {
      initialEntries: [initialEntry]
    });
  }

  return createBrowserRouter(appRoutes);
}
