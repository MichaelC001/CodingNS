/**
 * CodingNS 受控扩展：plan-mode-rpc（只读计划模式）
 *
 * 作用：打开一个「只能看、不能改」的模式。模型可以读文件、跑只读命令、搜索、提问，
 * 但不能 edit / write / 破坏性 bash。计划写完后弹一个选择框问用户下一步怎么走，
 * 用户的选择会作为一条用户消息回到会话里，模型据此继续。
 *
 * 为什么不用官方示例 examples/extensions/plan-mode：
 * 那个示例依赖 @earendil-works/pi-tui 的按键常量和彩色 widget（Key、theme.fg），
 * 在 RPC 模式下这些要么不可用，要么只是一堆 ANSI 转义字符，Host 拿不到有意义的内容。
 * 这里改写成纯 RPC 版本：只用 select / input 两种对话框 + notify / setStatus 通知。
 *
 * 启用方式（两条路都支持，优先 CLI flag）：
 * - 启动时传 --plan（pi.registerFlag 注册，pi.getFlag 读取）
 * - 或者设环境变量 PI_PLAN_MODE=1/true（Host 不方便传 flag 时的退路）
 *
 * 约束：只依赖 typebox / @earendil-works/pi-coding-agent 的类型；不抛异常导致 turn 失败。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	PLAN_MODE_NEXT_STEP_OPTIONS,
	PLAN_MODE_WRITE_TOOLS,
	extractPlanSteps,
	isBlockedPlanModeCommand,
	looksLikePlanRequest
} from "./policy.ts";




interface PlanModeState {
	enabled: boolean;
	/** 用户明确要求过「做计划」，避免用户随口一问就弹窗 */
	wantsPlan: boolean;
	/** 用户选了「执行计划」，这一轮放行写操作 */
	executing: boolean;
	/** 已经弹过下一步选择框，防止同一个回合里重复打扰 */
	askedThisTurn: boolean;
}

export default function planModeRpcExtension(pi: ExtensionAPI) {
	// 这条在扩展加载阶段就要登记，pi 解析 CLI 参数时才知道 --plan 是什么意思。
	// 注意 pi 只把"命令行真的出现过"的 flag 写进 flagValues，
	// 所以没传 --plan 时 pi.getFlag("plan") 是 undefined，不是 default 里的 false。
	pi.registerFlag("plan", {
		description: "以只读计划模式启动（禁止 edit/write 和破坏性 bash）",
		type: "boolean",
		default: false,
	});

	const state: PlanModeState = { enabled: false, wantsPlan: false, executing: false, askedThisTurn: false };

	/** 读过一次环境变量就缓存，后面重复读没意义 */
	let envPlanMode: boolean | undefined;
	function envSaysPlanMode(): boolean {
		if (envPlanMode === undefined) {
			const raw = process.env.PI_PLAN_MODE ?? process.env.PI_PLAN_MODE_RPC;
			envPlanMode = raw === "1" || raw?.toLowerCase() === "true";
		}
		return envPlanMode;
	}

	function applyStatus(ctx: ExtensionContext): void {
		if (state.executing) {
			ctx.ui.setStatus("plan-mode-rpc", "▶ 执行计划中");
			ctx.ui.setWidget("plan-mode-rpc", undefined);
			return;
		}
		if (state.enabled) {
			ctx.ui.setStatus("plan-mode-rpc", "⏸ 计划模式（只读）");
			ctx.ui.setWidget("plan-mode-rpc", ["计划模式：只允许读取类操作，edit/write 已被拦截"]);
			return;
		}
		ctx.ui.setStatus("plan-mode-rpc", undefined);
		ctx.ui.setWidget("plan-mode-rpc", undefined);
	}

	function setEnabled(ctx: ExtensionContext, enabled: boolean, reason: string): void {
		state.enabled = enabled;
		state.executing = false;
		if (!enabled) {
			state.wantsPlan = false;
			ctx.ui.notify(`计划模式已关闭（${reason}）。恢复完整工具权限。`, "info");
		} else {
			ctx.ui.notify(`计划模式已开启（${reason}）。edit/write 和破坏性 bash 会被拦截。`, "info");
		}
		applyStatus(ctx);
		persistState();
	}

	/**
	 * 把模式状态写进会话。用户中途 /plan 切换过之后，恢复会话时要按最后一次的选择来，
	 * 不能被启动参数盖掉。
	 */
	function persistState(): void {
		try {
			pi.appendEntry("plan-mode-rpc-state", { enabled: state.enabled });
		} catch {
			// 落盘失败不影响当前会话继续用
		}
	}




	/** 取事件里最后一条助手的纯文本 */
	function lastAssistantText(messages: readonly unknown[]): string {
		for (let i = messages.length - 1; i >= 0; i -= 1) {
			const message = messages[i] as { role?: string; content?: unknown } | undefined;
			if (!message || message.role !== "assistant") continue;
			if (typeof message.content === "string") return message.content;
			if (Array.isArray(message.content)) {
				return message.content
					.filter((block): block is { type: string; text: string } => {
						const candidate = block as { type?: string; text?: string };
						return candidate?.type === "text" && typeof candidate.text === "string";
					})
					.map((block) => block.text)
					.join("\n");
			}
		}
		return "";
	}

	/** 发消息给会话：RPC 下流式期间必须带 deliverAs，这里按空闲状态自动选 */
	function sendToSession(ctx: ExtensionContext, text: string): void {
		if (!text.trim()) return;
		try {
			if (ctx.isIdle()) {
				pi.sendUserMessage(text);
			} else {
				pi.sendUserMessage(text, { deliverAs: "followUp" });
			}
		} catch (error) {
			// 极端情况下（例如会话正在切换）发送会失败，退回自定义消息，至少让用户看到
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`发送消息失败：${message}`, "error");
		}
	}

	// ---------------------------------------------------------------------------
	// 只读拦截：只读计划模式的核心
	// ---------------------------------------------------------------------------
	pi.on("tool_call", async (event) => {
		// 用户已经确认执行计划时放行，否则计划永远没法落地
		if (!state.enabled || state.executing) return;

		if (PLAN_MODE_WRITE_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason:
					"计划模式下不允许修改：edit/write 已被禁用。请继续用 read/grep/find/ls 和只读 bash 调研，" +
					"把改动写进计划里，等用户确认执行后再改文件。",
			};
		}

		// bash 和 powershell 都要看：Windows 上 pi 用的是 powershell 工具，
		// 只挡 bash 等于在 Windows 上完全没有只读保护。
		if (event.toolName === "bash" || event.toolName === "powershell") {
			const input = event.input as { command?: unknown };
			const command = typeof input.command === "string" ? input.command : "";
			if (isBlockedPlanModeCommand(command)) {
				return {
					block: true,
					reason: `计划模式下不允许执行会改动状态的命令：${command}\n只允许读取、搜索、git 查询类命令。`,
				};
			}
		}
	});

	// ---------------------------------------------------------------------------
	// 上下文注入：让模型知道当前处在只读模式
	// ---------------------------------------------------------------------------
	pi.on("before_agent_start", async () => {
		if (state.executing) {
			return {
				message: {
					customType: "plan-mode-rpc",
					content:
						"[计划执行中] 用户已确认执行计划，写权限已恢复。按计划步骤依次落地，改完一个文件就说明改了什么。",
					display: false,
				},
			};
		}
		if (!state.enabled) return;
		return {
			message: {
				customType: "plan-mode-rpc",
				content:
					"[计划模式：只读] 现在只能读取和调研，edit/write 以及破坏性 bash 会被拦截。\n" +
					"请先用 read / grep / find / ls / 只读 bash 把事实查清楚，需要用户拍板时用 question 工具。\n" +
					'最终输出一份计划，格式固定为一行 "Plan:"（或 "计划："）开头，下面用 1. 2. 3. 编号列步骤。\n' +
					"不要尝试改文件，把要改的内容写进计划里。",
				display: false,
			},
		};
	});

	// ---------------------------------------------------------------------------
	// 记录用户意图：只有用户明确要计划时才在回合结束时弹选择框
	// ---------------------------------------------------------------------------
	pi.on("input", async (event) => {
		// 我们自己回灌的消息统一带 [plan-mode-rpc] 前缀，不算用户的新意图
		if (event.text.includes("[plan-mode-rpc]")) return;
		state.askedThisTurn = false;
		state.wantsPlan = state.enabled && looksLikePlanRequest(event.text);
	});

	// ---------------------------------------------------------------------------
	// 计划生成后征求下一步意见
	//
	// 注意：agent_settled 的事件体里没有 messages（Pi 的 settled 事件只有 type），
	// 所以计划步骤必须在 agent_end（那里带 messages）时先抓出来存着，
	// 到了 settled 再弹窗。
	// ---------------------------------------------------------------------------
	let pendingPlanSteps: string[] = [];

	pi.on("agent_end", async (event) => {
		if (!state.enabled) return;
		try {
			const assistantText = lastAssistantText(event.messages ?? []);
			pendingPlanSteps = extractPlanSteps(assistantText);
		} catch {
			pendingPlanSteps = [];
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		try {
			if (!state.enabled) return;
			if (!ctx.hasUI) return;
			if (!state.wantsPlan || state.askedThisTurn) return;
			if (ctx.hasPendingMessages()) return;

			const steps = pendingPlanSteps;
			if (steps.length === 0) return; // 还没写出计划，别打断
			pendingPlanSteps = [];

			state.askedThisTurn = true;
			ctx.ui.setWidget("plan-mode-rpc", steps);

			const choice = await ctx.ui.select("计划已生成，请选择下一步", PLAN_MODE_NEXT_STEP_OPTIONS);

			if (choice === undefined || choice === "取消") {
				state.enabled = false;
				state.wantsPlan = false;
				applyStatus(ctx);
				ctx.ui.notify("已退出计划模式，未执行计划。", "info");
				return;
			}

			if (choice === "执行计划") {
				state.executing = true;
				applyStatus(ctx);
				// applyStatus 在执行态会清掉 widget，这里把计划步骤重新贴回去，方便用户对照进度
				ctx.ui.setWidget("plan-mode-rpc", steps);
				ctx.ui.notify("开始执行计划，写权限已恢复。", "info");
				sendToSession(
					ctx,
					`[plan-mode-rpc] 用户选择「执行计划」，请按下面这份计划逐步落地，每完成一步说明改了什么。\n\n${steps.join("\n")}`,
				);
				return;
			}

			if (choice === "继续完善计划") {
				const hint = await ctx.ui.input("补充什么？可以直接回车跳过", "例如：还要考虑迁移脚本");
				sendToSession(
					ctx,
					hint?.trim()
						? `[plan-mode-rpc] 用户选择「继续完善计划」，补充要求：${hint.trim()}\n\n请更新计划：\n${steps.join("\n")}`
						: `[plan-mode-rpc] 用户选择「继续完善计划」。请把计划写得更具体（文件路径、改动点、验证方式）：\n${steps.join("\n")}`,
				);
				return;
			}

			if (choice === "修改计划") {
				const feedback = await ctx.ui.input("要改哪里？", "例如：第 2 步换成先写测试");
				sendToSession(
					ctx,
					feedback?.trim()
						? `[plan-mode-rpc] 用户选择「修改计划」，修改意见：${feedback.trim()}\n\n当前计划：\n${steps.join("\n")}`
						: `[plan-mode-rpc] 用户选择「修改计划」，但没写具体意见。请先问清楚要改哪一部分，再更新计划。\n\n当前计划：\n${steps.join("\n")}`,
				);
			}
		} catch (error) {
			// 计划模式只是辅助，弹窗出问题也不能影响正常会话
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`计划模式收尾失败：${message}`, "error");
		}
	});

	// ---------------------------------------------------------------------------
	// 命令与状态
	// ---------------------------------------------------------------------------
	pi.registerCommand("plan", {
		description: "打开或关闭只读计划模式",
		handler: async (_args, ctx) => {
			setEnabled(ctx, !state.enabled, "手动切换");
		},
	});

	pi.registerCommand("plan-status", {
		description: "查看计划模式当前状态",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				`计划模式：${state.enabled ? "开启（只读）" : "关闭"}；执行中：${state.executing ? "是" : "否"}`,
				"info",
			);
		},
	});

	/** 让模型能主动问一句「现在是什么模式」，Host 也能用它做加载自检 */
	pi.registerTool({
		name: "plan_mode_status",
		label: "计划模式状态",
		description: "查询当前是否处于只读计划模式，以及是否已进入计划执行阶段。",
		parameters: Type.Object({}),
		async execute() {
			const text = state.executing
				? "当前处于计划执行阶段：写权限已恢复，正在按计划落地。"
				: state.enabled
					? "当前处于只读计划模式：edit/write 与破坏性 bash 会被拦截，只允许读取和调研。"
					: "当前不在计划模式，工具权限完整。";
			return {
				content: [{ type: "text" as const, text }],
				details: { enabled: state.enabled, executing: state.executing, wantsPlan: state.wantsPlan },
			};
		},
	});

	// ---------------------------------------------------------------------------
	// 会话生命周期：恢复或落地初始状态
	// ---------------------------------------------------------------------------
	pi.on("session_start", async (event, ctx) => {
		state.askedThisTurn = false;
		state.executing = false;
		state.wantsPlan = false;

		// 顺序很重要：先看启动参数，再用会话里记录的状态覆盖。
		// 这样「恢复会话」不会被 --plan 重新打开一个用户已经手动关掉的计划模式。
		const flagValue = pi.getFlag("plan");
		state.enabled = flagValue === true || envSaysPlanMode();

		let restored = false;
		try {
			const entries = ctx.sessionManager.getEntries();
			for (let i = entries.length - 1; i >= 0; i -= 1) {
				const entry = entries[i] as { type?: string; customType?: string; data?: unknown };
				if (entry.type === "custom" && entry.customType === "plan-mode-rpc-state" && entry.data) {
					const data = entry.data as { enabled?: boolean };
					state.enabled = data.enabled === true;
					restored = true;
					break;
				}
			}
		} catch {
			// 读不到历史就按启动参数来，不影响主流程
		}

		applyStatus(ctx);

		// 只在真开启了、且不是靠历史恢复的时候提示一次，避免每次恢复会话都刷通知
		if (state.enabled && !restored) {
			ctx.ui.notify("计划模式已生效（来自启动参数）。edit/write 与破坏性 bash 会被拦截。", "info");
		}
	});
}
