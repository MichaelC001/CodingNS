import { describe, expect, it } from "vitest";

import { SessionPermissionRequestService } from "../../src/modules/sessions/session-permission-request-service.js";

/**
 * Pi 扩展交互桥的 Host 层用例。
 *
 * 这里只搭最小依赖：被测路径只用到请求登记、envelope 广播和回写等待，
 * 不碰会话历史、绑定仓库和鉴权，所以不需要起整个 Host。
 */
function createService() {
  const envelopes: Array<{ type: string; sessionId: string; request: Record<string, unknown> }> = [];
  const service = new SessionPermissionRequestService(
    {
      getSession: () => ({
        sessionId: "session-1",
        provider: "pi",
        providerSessionId: "pi-session-1"
      })
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    (envelope: never) => {
      envelopes.push(envelope as never);
    }
  );

  return { service, envelopes };
}

function createRequest(overrides: Partial<Parameters<SessionPermissionRequestService["handlePiExtensionUiRequest"]>[0]> = {}) {
  return {
    sessionId: "session-1",
    providerSessionId: "pi-session-1",
    requestId: "pi-ui-1",
    method: "select" as const,
    title: "今天想做什么？",
    message: null,
    options: ["写代码", "休息"],
    placeholder: null,
    prefill: null,
    timeoutMs: 60_000,
    ...overrides
  };
}

describe("Pi 扩展交互桥", () => {
  it("select 请求会变成等待用户选择的交互，并按原 id 回写选择", async () => {
    const { service, envelopes } = createService();

    const decisionPromise = service.handlePiExtensionUiRequest(createRequest());

    expect(envelopes).toHaveLength(1);
    const request = envelopes[0].request as {
      id: string;
      kind: string;
      title: string;
      requestKey: string;
      questions: Array<{ id: string; question: string; options: Array<{ label: string }> }>;
      actions: Array<{ value: string }>;
      status: string;
    };
    expect(envelopes[0].type).toBe("session.permission_request");
    expect(request.id).toBe("pi-ui-pi-ui-1");
    expect(request.requestKey).toBe("pi-ui-1");
    expect(request.kind).toBe("user_input");
    expect(request.status).toBe("pending");
    expect(request.title).toBe("Pi 扩展请求补充信息");
    expect(request.questions[0]?.question).toBe("今天想做什么？");
    expect(request.questions[0]?.options.map((option) => option.label)).toEqual(["写代码", "休息"]);
    expect(request.actions.map((action) => action.value)).toEqual(["answer", "cancel"]);

    const resolved = await service.replyToSessionPermissionRequest("session-1", "user-1", request.id, {
      action: "answer",
      answers: { "pi-extension-ui": ["写代码"] }
    });

    expect(resolved.status).toBe("approved");
    await expect(decisionPromise).resolves.toEqual({ kind: "value", value: "写代码" });
    expect(envelopes.at(-1)?.type).toBe("session.permission_request_resolved");
  });

  it("计划审批走独立的 plan_approval 形态，取消不会记成通过", async () => {
    const { service, envelopes } = createService();

    const approvalPromise = service.handlePiExtensionUiRequest(createRequest({
      requestId: "plan-1",
      title: "计划已生成，请选择下一步",
      options: ["执行计划", "继续完善计划", "修改计划", "取消"]
    }));

    const request = envelopes[0].request as {
      id: string;
      kind: string;
      title: string;
      actions: Array<{ value: string; tone: string }>;
    };
    expect(request.kind).toBe("plan_approval");
    expect(request.title).toBe("Pi 请求确认执行计划");
    expect(request.actions.map((action) => action.value)).toEqual([
      "执行计划",
      "继续完善计划",
      "修改计划",
      "取消"
    ]);
    expect(request.actions[0]?.tone).toBe("primary");
    expect(request.actions.at(-1)?.tone).toBe("danger");

    const approved = await service.replyToSessionPermissionRequest("session-1", "user-1", request.id, {
      action: "执行计划"
    });
    expect(approved.status).toBe("approved");
    await expect(approvalPromise).resolves.toEqual({ kind: "value", value: "执行计划" });

    // 取消分支：记成 cancelled，并且回给 Pi 的仍然是取消语义。
    const cancelledPromise = service.handlePiExtensionUiRequest(createRequest({
      requestId: "plan-2",
      title: "计划已生成，请选择下一步",
      options: ["执行计划", "继续完善计划", "修改计划", "取消"]
    }));
    const cancelledRequest = envelopes.at(-1)?.request as { id: string };
    const cancelled = await service.replyToSessionPermissionRequest("session-1", "user-1", cancelledRequest.id, {
      action: "取消"
    });
    expect(cancelled.status).toBe("cancelled");
    await expect(cancelledPromise).resolves.toEqual({ kind: "value", value: "取消" });
  });

  it("confirm 请求映射成允许/拒绝，回包是布尔值", async () => {
    const { service, envelopes } = createService();

    const decisionPromise = service.handlePiExtensionUiRequest(createRequest({
      requestId: "confirm-1",
      method: "confirm",
      title: "要删除这个文件吗？",
      message: "删除后无法恢复",
      options: []
    }));

    const request = envelopes[0].request as {
      id: string;
      kind: string;
      summary: string;
      actions: Array<{ value: string }>;
    };
    expect(request.kind).toBe("permissions");
    expect(request.summary).toBe("删除后无法恢复");
    expect(request.actions.map((action) => action.value)).toEqual(["allow", "deny"]);

    await service.replyToSessionPermissionRequest("session-1", "user-1", request.id, { action: "deny" });
    await expect(decisionPromise).resolves.toEqual({ kind: "confirmed", confirmed: false });
  });

  it("自由输入请求把用户输入当值回传，空值会被拒绝", async () => {
    const { service, envelopes } = createService();

    const decisionPromise = service.handlePiExtensionUiRequest(createRequest({
      requestId: "input-1",
      method: "input",
      title: "补充什么？",
      placeholder: "例如：还要考虑迁移脚本",
      options: []
    }));

    const request = envelopes[0].request as { id: string; questions: Array<{ question: string; allowOther: boolean }> };
    expect(request.questions[0]?.question).toContain("例如：还要考虑迁移脚本");
    expect(request.questions[0]?.allowOther).toBe(true);

    await expect(service.replyToSessionPermissionRequest("session-1", "user-1", request.id, {
      action: "answer",
      answers: {}
    })).rejects.toMatchObject({ errorCode: "INVALID_INPUT" });

    await service.replyToSessionPermissionRequest("session-1", "user-1", request.id, {
      action: "answer",
      answers: { "pi-extension-ui": ["加上回滚步骤"] }
    });
    await expect(decisionPromise).resolves.toEqual({ kind: "value", value: "加上回滚步骤" });
  });

  it("同一条 Pi 请求重复到达时复用一条记录，两个等待者拿到同一个结果", async () => {
    const { service, envelopes } = createService();

    const first = service.handlePiExtensionUiRequest(createRequest({ requestId: "dup-1" }));
    const second = service.handlePiExtensionUiRequest(createRequest({ requestId: "dup-1" }));

    expect(envelopes).toHaveLength(1);

    await service.replyToSessionPermissionRequest("session-1", "user-1", "pi-ui-dup-1", {
      action: "answer",
      answers: { "pi-extension-ui": ["休息"] }
    });

    await expect(first).resolves.toEqual({ kind: "value", value: "休息" });
    await expect(second).resolves.toEqual({ kind: "value", value: "休息" });
  });

  it("Host 收尾时挂起的扩展交互会收到取消，不会把 Pi 进程吊死", async () => {
    const { service, envelopes } = createService();

    const decisionPromise = service.handlePiExtensionUiRequest(createRequest({ requestId: "dispose-1" }));
    expect(envelopes).toHaveLength(1);

    await service.dispose();

    await expect(decisionPromise).resolves.toEqual({ kind: "cancelled" });
  });

  it("超时后返回取消并结束请求，避免前端一直显示等待", async () => {
    const { service } = createService();

    const decision = await service.handlePiExtensionUiRequest(createRequest({
      requestId: "timeout-1",
      timeoutMs: 20
    }));

    expect(decision).toEqual({ kind: "cancelled" });
  });

  it("不支持的确认动作会被拒绝，不会静默当成通过", async () => {
    const { service, envelopes } = createService();

    void service.handlePiExtensionUiRequest(createRequest({
      requestId: "invalid-1",
      method: "confirm",
      title: "继续吗",
      options: []
    }));

    const request = envelopes[0].request as { id: string };

    await expect(service.replyToSessionPermissionRequest("session-1", "user-1", request.id, {
      action: "maybe"
    })).rejects.toMatchObject({ errorCode: "INVALID_INPUT" });
  });
});
