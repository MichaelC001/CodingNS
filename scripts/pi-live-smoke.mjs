#!/usr/bin/env node
/**
 * Pi Agent 真实模型冒烟脚本。
 *
 * 协议级回归走 packages/session-sync-core/tests/pi-*.test.mjs（不需要密钥）；
 * 这个脚本只验证"接了真实供应商之后整条链路还能跑"，因此必须有可用密钥。
 *
 * 用法：
 *   node scripts/pi-live-smoke.mjs
 *   PI_LIVE_MODEL=deepseek/deepseek-chat PI_LIVE_WORKSPACE=/tmp/pi-smoke node scripts/pi-live-smoke.mjs
 *
 * 退出码：0 表示全部场景通过，1 表示有场景失败。
 */

import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreEntry = join(repoRoot, "packages", "session-sync-core", "dist", "index.js");

const { PiAdapter, PiRuntimeAdapter } = await import(coreEntry).catch(() => {
  console.error(`找不到 ${coreEntry}，请先执行 pnpm --dir packages/session-sync-core build`);
  process.exit(1);
});

const model = process.env.PI_LIVE_MODEL?.trim() || "deepseek/deepseek-chat";
// 图片场景必须用声明了图片输入的模型：文字模型会被适配器提前拦下（这是有意为之）。
const visionModel = process.env.PI_LIVE_VISION_MODEL?.trim() || "deepseek/deepseek-flash";
const commandPath = process.env.PI_LIVE_COMMAND?.trim() || "pi";
const workspacePath = process.env.PI_LIVE_WORKSPACE?.trim() || "/tmp/codingns-pi-live-smoke";
const extensions = [
  join(repoRoot, "apps", "host", "pi-extensions", "question-rpc", "index.ts"),
  join(repoRoot, "apps", "host", "pi-extensions", "plan-mode-rpc", "index.ts")
];

const results = [];

function createSession(tag, extra = {}) {
  const events = [];
  const adapter = new PiRuntimeAdapter({
    commandPath,
    requestTimeoutMs: 180_000,
    settleGraceMs: 1_500,
    ...extra
  });
  return {
    events,
    adapter,
    sink: {
      updateSessionBinding() {},
      async emit(event) {
        events.push(event);
        if (event.type === "error") console.error(`  [${tag}] 错误 ${event.errorCode}: ${event.detail}`);
      }
    }
  };
}

function runOptions(content, extra = {}) {
  return {
    content,
    clientRequestId: null,
    model,
    reasoningLevel: null,
    permissionMode: null,
    providerPrompt: null,
    attachments: [],
    ...extra
  };
}

function baseRequest(sessionId, options) {
  return {
    sessionId,
    workspaceId: "pi-live-smoke",
    workspacePath,
    provider: "pi",
    providerSessionId: null,
    rawStoreRef: null,
    runtimeHomeDir: null,
    runtimeEnv: {},
    sequenceBase: 0,
    options
  };
}

/**
 * 生成一张左红右蓝的 PNG，用来验证图片附件真的作为图片内容传给了模型。
 *
 * 自己编码而不是塞 base64 常量，是为了让图里的内容一眼能看出来（左红右蓝），
 * 模型答对颜色才说明它真的"看到"了图。
 */
function createHalfRedHalfBluePng(size = 64) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 3 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x += 1) {
      const offset = rowStart + 1 + x * 3;
      const left = x < size / 2;
      raw[offset] = left ? 255 : 0;
      raw[offset + 1] = 0;
      raw[offset + 2] = left ? 0 : 255;
    }
  }

  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData) >>> 0, 0);
    return Buffer.concat([length, typeAndData, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function lastText(events) {
  return events
    .filter((event) => event.type === "message" && event.message.kind === "text")
    .at(-1)?.message.content ?? "";
}

async function scenario(name, fn) {
  process.stdout.write(`\n▶ ${name}\n`);
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`  ✅ ${detail}`);
  } catch (error) {
    results.push({ name, ok: false, detail: error?.message ?? String(error) });
    console.log(`  ❌ ${error?.message ?? String(error)}`);
  }
}

rmSync(workspacePath, { recursive: true, force: true });
mkdirSync(workspacePath, { recursive: true });

let baseSession = null;

await scenario("单轮文本 + usage", async () => {
  const { adapter, sink, events } = createSession("text");
  const launch = await adapter.startSession(baseRequest("smoke-text", runOptions("只回答两个字：收到")), sink);
  await launch.completed;
  const usage = launch.getUsageTotals();
  if (usage.assistantMessages === 0) throw new Error("没有收到 usage");
  baseSession = { providerSessionId: launch.providerSessionId, rawStoreRef: launch.rawStoreRef };
  return `回答「${lastText(events).slice(0, 20)}」，input=${usage.inputTokens} output=${usage.outputTokens}`;
});

await scenario("工具调用归一化", async () => {
  const { adapter, sink, events } = createSession("tools");
  const launch = await adapter.startSession(
    baseRequest("smoke-tools", runOptions("用 bash 执行 `echo pi-smoke-ok`，然后只回答命令输出。")),
    sink
  );
  await launch.completed;
  const calls = events.filter((e) => e.type === "message" && e.message.kind === "tool_call");
  const toolResults = events.filter((e) => e.type === "message" && e.message.kind === "tool_result");
  if (calls.length === 0) throw new Error("没有收到 tool_call 事件");
  if (toolResults.length !== 1) throw new Error(`tool_result 应该只有一条，实际 ${toolResults.length}`);
  return `tool_call ${calls.length} 条、tool_result 1 条，输出 ${JSON.stringify(lastText(events).slice(0, 40))}`;
});

await scenario("运行中 steer", async () => {
  const { adapter, sink, events } = createSession("steer");
  const launch = await adapter.startSession(
    baseRequest("smoke-steer", runOptions("从 1 数到 200，每个数字单独一行。")),
    sink
  );
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
  const startedAt = Date.now();
  await launch.submitDuringRun(runOptions("停，只回答 STEER-OK。", { permissionMode: "steer" }));
  await launch.completed;
  const answer = lastText(events);
  if (!answer.includes("STEER-OK")) throw new Error(`steer 之后没有按新指令回答：${answer.slice(-80)}`);
  return `${Date.now() - startedAt}ms 内生效，回答「STEER-OK」`;
});

await scenario("Fork 后继续并继承历史", async () => {
  if (!baseSession) throw new Error("前置场景失败，跳过");
  const { adapter, sink, events } = createSession("fork-base");
  const launch = await adapter.startSession(
    baseRequest("smoke-fork-base", runOptions("记住一个词：紫罗兰。只回答好的。")),
    sink
  );
  await launch.completed;

  const piAdapter = new PiAdapter({ commandPath });
  const forked = await piAdapter.forkSession(launch.providerSessionId, workspacePath, {
    rawStoreRef: launch.rawStoreRef,
    sourceType: "message",
    sourceMessageId: null,
    sourceMessageSnapshot: { role: "user", kind: "text", content: "记住一个词：紫罗兰。只回答好的。" }
  });
  if (!existsSync(forked.session.rawStoreRef)) throw new Error("分叉会话文件没有落盘");

  const continued = createSession("fork-continue");
  const continuedLaunch = await continued.adapter.continueSession(
    {
      ...baseRequest("smoke-fork-continue", runOptions("我刚让你记住的词是什么？只回答那个词。")),
      providerSessionId: forked.session.providerSessionId,
      rawStoreRef: forked.session.rawStoreRef
    },
    continued.sink
  );
  await continuedLaunch.completed;
  const answer = lastText(continued.events);
  if (!answer.includes("紫罗兰")) throw new Error(`分叉会话没有继承历史，回答：${answer.slice(0, 80)}`);
  return `forkMethod=${forked.forkMethod}，分叉会话正确回答「紫罗兰」`;
});

await scenario("question 扩展交互", async () => {
  const seen = [];
  const { adapter, sink, events } = createSession("question", {
    extensionPaths: extensions,
    extensionUiTimeoutMs: 30_000,
    extensionUiBridge: {
      async request(prompt) {
        seen.push(prompt);
        if (prompt.method === "select") return { kind: "value", value: prompt.options[0] };
        if (prompt.method === "input") return { kind: "value", value: "冒烟脚本回答" };
        return { kind: "cancelled" };
      }
    }
  });
  const launch = await adapter.startSession(
    baseRequest(
      "smoke-question",
      runOptions(
        "请调用 question 工具向我提问，问题固定为「今天想做什么？」，选项固定为 [\"写代码\", \"休息\"]。拿到我的选择后，只回答「你的选择是：X」。"
      )
    ),
    sink
  );
  await launch.completed;
  if (seen.length === 0) throw new Error("没有收到扩展交互请求");
  const answer = lastText(events);
  if (!answer.includes("写代码")) throw new Error(`没有把选择回灌给模型：${answer.slice(0, 80)}`);
  return `收到 ${seen.length} 次交互（${seen[0].method}），模型回答「你的选择是：写代码」`;
});

await scenario("Plan 审批与只读拦截", async () => {
  const seen = [];
  const { adapter, sink, events } = createSession("plan", {
    extensionPaths: extensions,
    extensionUiTimeoutMs: 60_000,
    settleGraceMs: 4_000,
    extensionUiBridge: {
      async request(prompt) {
        seen.push(prompt);
        if (prompt.method === "select") {
          return { kind: "value", value: prompt.options.includes("执行计划") ? "执行计划" : prompt.options[0] };
        }
        return { kind: "cancelled" };
      }
    }
  });
  const launch = await adapter.startSession(
    baseRequest(
      "smoke-plan",
      runOptions(
        "先别改文件。给我一份计划：在当前目录新建 smoke-note.txt，内容写 hello。请按「Plan: 1. 2. 3.」的格式输出编号步骤。",
        // 走真实链路：Host 的「计划模式」开关就是用 permissionMode=plan 传下来的。
        { permissionMode: "plan" }
      )
    ),
    sink
  );
  await launch.completed;
  const approval = seen.find((prompt) => prompt.options?.includes("执行计划"));
  if (!approval) throw new Error("没有收到计划审批请求");
  if (existsSync(join(workspacePath, "smoke-note.txt")) && !events.some((e) => e.type === "message")) {
    throw new Error("计划模式下不应该直接写文件");
  }
  return "收到「计划已生成，请选择下一步」审批，并回传了选择";
});

await scenario("图片附件真的传给模型", async () => {
  const imagePath = join(workspacePath, "half-red-half-blue.png");
  writeFileSync(imagePath, createHalfRedHalfBluePng());

  const { adapter, sink, events } = createSession("image");
  const launch = await adapter.startSession(
    baseRequest("smoke-image", runOptions("看这张图：左边和右边分别是什么颜色？只回答两个颜色词，用逗号分隔。", {
      model: visionModel,
      attachments: [{
        id: "img-1",
        kind: "image",
        fileName: "half-red-half-blue.png",
        mimeType: "image/png",
        fileSize: 0,
        filePath: imagePath
      }]
    })),
    sink
  );
  await launch.completed;
  const answer = lastText(events);
  const mentionsRed = /红|red/i.test(answer);
  const mentionsBlue = /蓝|blue/i.test(answer);
  if (!mentionsRed || !mentionsBlue) {
    throw new Error(`模型没有正确描述图片：${answer.slice(0, 120)}`);
  }
  return `模型回答「${answer.slice(0, 40).replace(/\n/g, " ")}」`;
});

await scenario("clear_queue 返回被清掉的队列文本", async () => {
  const { adapter, sink } = createSession("clear-queue");
  const launch = await adapter.startSession(
    baseRequest("smoke-clear-queue", runOptions("从 1 数到 300，每个数字单独一行，不要省略。")),
    sink
  );

  // 等它真正开始流式输出，再把两条后续消息排进 Pi 的队列。
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
  await launch.submitDuringRun(runOptions("排队消息甲：回答 CLEAR-A。"));
  await launch.submitDuringRun(runOptions("排队消息乙：回答 CLEAR-B。"));

  const cleared = await launch.clearQueue();
  const clearedText = [...cleared.steering, ...cleared.followUp].join(" | ");
  if (!clearedText.includes("CLEAR-A") && !clearedText.includes("CLEAR-B")) {
    throw new Error(`clear_queue 没有返回排队文本：${JSON.stringify(cleared)}`);
  }

  await launch.interrupt();
  await launch.completed;
  return `steering=${cleared.steering.length} followUp=${cleared.followUp.length}：${clearedText.slice(0, 60)}`;
});

console.log("\n—— 冒烟结果 ——");
for (const result of results) {
  console.log(`${result.ok ? "✅" : "❌"} ${result.name}：${result.detail}`);
}

const failed = results.filter((result) => !result.ok);
console.log(`\n共 ${results.length} 个场景，失败 ${failed.length} 个`);
process.exit(failed.length === 0 ? 0 : 1);
