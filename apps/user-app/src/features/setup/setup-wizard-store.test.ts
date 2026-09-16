import { beforeEach, describe, expect, it } from "vitest";

import { getSetupWizardSteps, setupWizardStore } from "./setup-wizard-store";

describe("首次运行向导状态机", () => {
  beforeEach(() => {
    setupWizardStore.reset();
  });

  it("选了客户端就进入连接步骤", () => {
    setupWizardStore.selectRole("client");

    expect(setupWizardStore.getState()).toMatchObject({
      role: "client",
      stepId: "client-endpoint",
      clientEndpointReady: false
    });
  });

  it("选了服务端就进入环境检测步骤", () => {
    setupWizardStore.selectRole("server");

    expect(setupWizardStore.getState()).toMatchObject({
      role: "server",
      stepId: "server-environment",
      clientEndpointReady: false
    });
  });

  it("还没选角色时前进不动", () => {
    setupWizardStore.goNext();

    expect(setupWizardStore.getState()).toMatchObject({
      role: null,
      stepId: "role",
      clientEndpointReady: false
    });
  });

  it("服务端分支可以逐步前进，到最后一步停住", () => {
    setupWizardStore.selectRole("server");

    setupWizardStore.goNext();
    expect(setupWizardStore.getState().stepId).toBe("server-options");

    setupWizardStore.goNext();
    expect(setupWizardStore.getState().stepId).toBe("server-installing");

    setupWizardStore.goNext();
    expect(setupWizardStore.getState().stepId).toBe("server-installing");
  });

  it("后退可以一路退回角色选择，并在第一步停住", () => {
    setupWizardStore.selectRole("server");
    setupWizardStore.goNext();
    setupWizardStore.goNext();

    setupWizardStore.goBack();
    expect(setupWizardStore.getState().stepId).toBe("server-options");

    setupWizardStore.goBack();
    expect(setupWizardStore.getState().stepId).toBe("server-environment");

    setupWizardStore.goBack();
    expect(setupWizardStore.getState().stepId).toBe("role");

    setupWizardStore.goBack();
    expect(setupWizardStore.getState().stepId).toBe("role");
  });

  it("中途换角色会把步骤切到新分支的第一步", () => {
    setupWizardStore.selectRole("server");
    setupWizardStore.goNext();

    setupWizardStore.selectRole("client");

    expect(setupWizardStore.getState()).toMatchObject({
      role: "client",
      stepId: "client-endpoint",
      clientEndpointReady: false
    });
  });

  it("客户端地址测通后可以标记就绪", () => {
    setupWizardStore.selectRole("client");

    setupWizardStore.markClientEndpointReady();

    expect(setupWizardStore.getState().clientEndpointReady).toBe(true);
  });

  it("换角色会清掉客户端就绪状态", () => {
    setupWizardStore.selectRole("client");
    setupWizardStore.markClientEndpointReady();

    setupWizardStore.selectRole("server");

    expect(setupWizardStore.getState().clientEndpointReady).toBe(false);
  });

  it("步骤列表跟着角色走", () => {
    expect(getSetupWizardSteps(null)).toEqual(["role", "client-endpoint"]);
    expect(getSetupWizardSteps("client")).toEqual(["role", "client-endpoint"]);
    expect(getSetupWizardSteps("server")).toEqual([
      "role",
      "server-environment",
      "server-options",
      "server-installing"
    ]);
  });

  it("重置会回到没选角色的初始状态", () => {
    setupWizardStore.selectRole("server");
    setupWizardStore.goNext();

    setupWizardStore.reset();

    expect(setupWizardStore.getState()).toMatchObject({
      role: null,
      stepId: "role",
      clientEndpointReady: false
    });
  });
});
