import test from "node:test";
import assert from "node:assert/strict";

import { PiEventNormalizer } from "../dist/index.js";

function createNormalizer(overrides = {}) {
  const events = [];
  const normalizer = new PiEventNormalizer({
    sessionId: "session-1",
    sequenceBase: 10,
    emit: (event) => events.push(event),
    now: () => "2026-09-15T00:00:00.000Z",
    ...overrides
  });
  normalizer.setBinding({ providerSessionId: "pi-session-1", rawStoreRef: "/pi/sessions/s1.jsonl" });
  return { normalizer, events };
}

function textDelta(delta, contentIndex = 0) {
  return {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex, delta }
  };
}

test("文本增量合并为一条消息，message_end 用权威快照覆盖", () => {
  const { normalizer, events } = createNormalizer();

  normalizer.handle({ type: "message_start" });
  normalizer.handle(textDelta("你"));
  normalizer.handle(textDelta("好"));
  normalizer.handle(textDelta("，世界"));

  const textEvents = events.filter((event) => event.type === "message");
  assert.equal(textEvents.length, 3);
  assert.equal(new Set(textEvents.map((event) => event.message.messageId)).size, 1);
  assert.equal(textEvents.at(-1).message.content, "你好，世界");
  assert.equal(textEvents.at(-1).message.provider, "pi");
  assert.equal(textEvents.at(-1).message.providerSessionId, "pi-session-1");
  assert.equal(textEvents.at(-1).message.role, "assistant");
  assert.equal(textEvents.at(-1).message.kind, "text");

  // 权威快照与增量内容不同时，以 message_end 为准，但 messageId 不变。
  normalizer.handle({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "你好，世界！" }], usage: {} }
  });

  const lastText = events.filter((event) => event.type === "message").at(-1);
  assert.equal(lastText.message.content, "你好，世界！");
  assert.equal(lastText.message.messageId, textEvents.at(-1).message.messageId);
});

test("思考和文本是两条独立消息轨道", () => {
  const { normalizer, events } = createNormalizer();

  normalizer.handle({ type: "message_start" });
  normalizer.handle({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "先分析" } });
  normalizer.handle(textDelta("结论"));

  const messages = events.filter((event) => event.type === "message").map((event) => event.message);
  const thinking = messages.filter((message) => message.kind === "thinking");
  const text = messages.filter((message) => message.kind === "text");

  assert.equal(thinking.length, 1);
  assert.equal(thinking[0].content, "先分析");
  assert.equal(text.length, 1);
  assert.equal(text[0].content, "结论");
  assert.notEqual(thinking[0].messageId, text[0].messageId);
});

test("工具调用增量合并，工具结果只发一次并保留状态", () => {
  const { normalizer, events } = createNormalizer();

  normalizer.handle({ type: "message_start" });
  normalizer.handle({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "read" } });
  normalizer.handle({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "{\"path\":" } });
  normalizer.handle({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "\"README.md\"}" } });
  normalizer.handle({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { id: "call-1", name: "read", arguments: { path: "README.md" } } } });

  normalizer.handle({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "README.md" } });
  normalizer.handle({ type: "tool_execution_update", toolCallId: "call-1", toolName: "read", partialResult: "部分输出" });
  normalizer.handle({ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: "文件内容", isError: false });
  // 重复的结束事件不应再发一条 tool_result。
  normalizer.handle({ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: "文件内容", isError: false });

  const toolCalls = events.filter((event) => event.type === "message" && event.message.kind === "tool_call");
  const toolResults = events.filter((event) => event.type === "message" && event.message.kind === "tool_result");

  assert.ok(toolCalls.length >= 4);
  assert.equal(new Set(toolCalls.map((event) => event.message.messageId)).size, 1);
  assert.equal(toolCalls.at(-1).message.toolCall.callId, "call-1");
  assert.equal(toolCalls.at(-1).message.toolCall.name, "read");
  assert.equal(toolCalls.at(-1).message.toolCall.status, "running");
  assert.match(toolCalls.at(-1).message.toolCall.input, /README\.md/);

  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0].message.role, "tool");
  assert.equal(toolResults[0].message.toolCall.status, "completed");
  assert.equal(toolResults[0].message.toolCall.output, "文件内容");
  assert.equal(toolResults[0].message.toolCall.error, null);
});

test("工具执行失败归一化为 failed 结果", () => {
  const { normalizer, events } = createNormalizer();

  normalizer.handle({ type: "tool_execution_start", toolCallId: "call-2", toolName: "bash", args: { command: "exit 1" } });
  normalizer.handle({ type: "tool_execution_end", toolCallId: "call-2", toolName: "bash", result: "命令失败", isError: true });

  const result = events.filter((event) => event.type === "message" && event.message.kind === "tool_result").at(-1);
  assert.equal(result.message.toolCall.status, "failed");
  assert.equal(result.message.toolCall.error, "命令失败");
  assert.equal(result.message.toolCall.output, null);
});

test("turn_start/turn_end 只记状态，不产生终态", () => {
  const { normalizer, events } = createNormalizer();

  normalizer.handle({ type: "turn_start" });
  normalizer.handle({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] });

  assert.deepEqual(
    events.map((event) => event.detail),
    ["PI_TURN_STARTED", "PI_TURN_ENDED"]
  );
  assert.equal(events.some((event) => event.type === "complete"), false);
  assert.equal(normalizer.isTerminal(), false);
});

test("agent_end 不结束运行，只有 agent_settled 发出 complete", () => {
  const { normalizer, events } = createNormalizer();

  normalizer.handle({ type: "agent_start" });
  normalizer.handle({ type: "agent_end", messages: [], willRetry: false });
  assert.equal(events.some((event) => event.type === "complete"), false);
  assert.equal(normalizer.isTerminal(), false);

  const turnEnd = events.filter((event) => event.type === "status" && event.detail === "PI_TURN_ENDED");
  assert.equal(turnEnd.length, 1);
  // agent_end 且不会自动重试时，这一轮运行的主体已经结束；
  // agent_settled 可能被扩展的 settled handler 挂住，所以这里必须先把状态收敛，
  // 否则会话会一直显示“进行中”。
  assert.equal(turnEnd[0].status, "completed");
  assert.equal(normalizer.hasSubjectCompleted(), true);

  normalizer.handle({ type: "agent_end", messages: [], willRetry: true });
  assert.equal(events.at(-1).detail, "PI_TURN_ENDED_WILL_RETRY");
  assert.equal(events.at(-1).status, "running");
  assert.equal(normalizer.hasSubjectCompleted(), false);

  normalizer.handle({ type: "agent_settled" });
  assert.equal(events.at(-1).type, "complete");
  assert.equal(events.at(-1).status, "completed");
  assert.equal(normalizer.isTerminal(), true);

  // 终态之后的事件不再广播，避免重复 complete。
  const before = events.length;
  normalizer.handle({ type: "agent_settled" });
  normalizer.handle(textDelta("迟到内容"));
  assert.equal(events.length, before);
});

test("agent_end 之后新的一轮会把主体完成标记清掉", () => {
  const { normalizer, events } = createNormalizer();

  normalizer.handle({ type: "agent_start" });
  normalizer.handle({ type: "agent_end", messages: [], willRetry: false });
  assert.equal(normalizer.hasSubjectCompleted(), true);

  // 计划审批之后扩展会回灌一条新消息，Pi 重新开始跑：状态必须回到 running。
  normalizer.handle({ type: "agent_start" });
  assert.equal(normalizer.hasSubjectCompleted(), false);
  assert.equal(events.at(-1).status, "running");
});

test("未知事件只记状态并保留原始引用，不阻断会话", () => {
  const { normalizer, events } = createNormalizer();

  normalizer.handle({ type: "some_future_event", payload: { keep: true }, rawEventRef: "x" });
  const unknown = events.at(-1);
  assert.equal(unknown.type, "status");
  assert.equal(unknown.status, "running");
  assert.equal(unknown.detail, "PI_UNKNOWN_EVENT:some_future_event");
  assert.ok(unknown.rawEventRef.includes("#pi-event=1"));
  assert.deepEqual(normalizer.getRawEventPayload(unknown.rawEventRef), {
    type: "some_future_event",
    payload: { keep: true },
    rawEventRef: "x"
  });

  // 未知事件之后照样能继续处理正常事件。
  normalizer.handle({ type: "message_start" });
  normalizer.handle(textDelta("继续"));
  assert.equal(events.at(-1).message.content, "继续");
});

test("usage 按 assistant 消息累加，缺失字段保持缺失", () => {
  const { normalizer } = createNormalizer();

  assert.deepEqual(normalizer.getUsageTotals(), {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: null,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: null,
    assistantMessages: 0
  });

  normalizer.handle({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      usage: {
        input: 100,
        output: 20,
        cacheRead: 5,
        cacheWrite: 0,
        totalTokens: 125,
        cost: { total: 0.01 }
      }
    }
  });

  const first = normalizer.getUsageTotals();
  assert.equal(first.inputTokens, 100);
  assert.equal(first.outputTokens, 20);
  assert.equal(first.cacheReadTokens, 5);
  assert.equal(first.totalTokens, 125);
  assert.equal(first.costUsd, 0.01);
  assert.equal(first.reasoningTokens, null);
  assert.equal(first.assistantMessages, 1);

  normalizer.handle({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      usage: {
        input: 50,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 7,
        totalTokens: 60,
        cost: { total: 0.02 }
      }
    }
  });

  const second = normalizer.getUsageTotals();
  assert.equal(second.inputTokens, 150);
  assert.equal(second.outputTokens, 30);
  assert.equal(second.reasoningTokens, 7);
  assert.equal(second.totalTokens, 185);
  assert.equal(second.costUsd, 0.03);
  assert.equal(second.assistantMessages, 2);
});

test("message_end 的工具结果消息不会和 tool_execution_end 重复", () => {
  const { normalizer, events } = createNormalizer();

  normalizer.handle({ type: "tool_execution_start", toolCallId: "call-3", toolName: "edit", args: {} });
  normalizer.handle({ type: "tool_execution_end", toolCallId: "call-3", toolName: "edit", result: "已写入", isError: false });
  normalizer.handle({
    type: "message_end",
    message: {
      role: "toolResult",
      toolCallId: "call-3",
      toolName: "edit",
      content: [{ type: "text", text: "已写入" }],
      isError: false
    }
  });

  const results = events.filter((event) => event.type === "message" && event.message.kind === "tool_result");
  assert.equal(results.length, 1);
});

test("assistant 错误消息发出可追踪的失败事件", () => {
  const { normalizer, events } = createNormalizer();

  normalizer.handle({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      usage: {},
      stopReason: "error",
      errorMessage: "No API key found for provider openai"
    }
  });

  const error = events.find((event) => event.type === "error");
  assert.ok(error);
  assert.equal(error.errorCode, "PI_AGENT_FAILED");
  assert.match(error.detail, /No API key/);
});
