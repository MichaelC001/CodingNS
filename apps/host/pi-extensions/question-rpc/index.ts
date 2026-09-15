/**
 * CodingNS 受控扩展：question（RPC 版）
 *
 * 作用：给模型一个「向用户提问」的工具，用户从选项里挑一个，或者手动输入自由文本。
 *
 * 为什么不用官方示例 examples/extensions/question.ts：
 * 官方版本整屏自己画（ctx.ui.custom + @earendil-works/pi-tui）。在 RPC 模式下
 * ctx.ui.custom() 直接返回 undefined（见 pi dist/modes/rpc/rpc-mode.js），
 * 画出来的组件也没有地方渲染。所以这里只用 RPC 真正支持的两种对话框：
 * ctx.ui.select() 和 ctx.ui.input()，它们会被 Host 转成 extension_ui_request
 * 发到 stdout，等 Host 回 extension_ui_response。
 *
 * 约束：
 * - 只依赖 typebox 和 @earendil-works/pi-coding-agent 的类型，不引第三方依赖、不引仓库内相对路径。
 * - 任何失败（没 UI、用户取消、Host 回包异常）都转成正常返回值，不抛异常，避免整个 turn 挂掉。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** 选项结构，和官方示例保持一致：label 必填，description 可选 */
interface QuestionOption {
	label: string;
	description?: string;
}

/** 回到模型上下文之外的附加信息，Host 也靠它渲染这一问一答 */
interface QuestionDetails {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom: boolean;
}

/** 用户选择「手动输入」时追加的选项文案，常量单独放，方便 Host 侧做匹配 */
const FREEFORM_LABEL = "其他（手动输入）";

const QuestionParams = Type.Object({
	question: Type.String({ description: "要问用户的问题" }),
	options: Type.Array(
		Type.Object({
			label: Type.String({ description: "选项文字，用户看到的就是它" }),
			description: Type.Optional(Type.String({ description: "可选的补充说明，会拼进问题标题里" })),
		}),
		{ description: "给用户挑选的选项，1 到 8 个" },
	),
	allowFreeform: Type.Optional(
		Type.Boolean({ description: "是否允许用户手动输入自由文本，默认 true", default: true }),
	),
});

/** 统一的返回构造，保证 details 结构一致 */
function buildResult(details: QuestionDetails, text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

export default function questionRpcExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "question",
		label: "提问（RPC）",
		description:
			"向用户提一个问题，让用户从给定选项中选择，或者手动输入自由文本。当需要用户拍板、确认方向、补充信息时使用。",
		// 让系统提示里出现一行说明，模型才知道有这么一个工具
		promptSnippet: "向用户提问并收集选择或自由输入",
		// 问题里有选项，天然要按顺序来，避免并行调用弹出多个互相打断的对话框
		executionMode: "sequential",
		parameters: QuestionParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// 兜底：把入参先规整一遍，模型偶尔会传空数组或者超量的选项
			const rawOptions: QuestionOption[] = Array.isArray(params.options) ? params.options : [];
			const cleanOptions = rawOptions
				.filter((option) => typeof option?.label === "string" && option.label.trim().length > 0)
				.slice(0, 8)
				.map((option) => ({
					label: option.label.trim(),
					...(typeof option.description === "string" && option.description.trim()
						? { description: option.description.trim() }
						: {}),
				}));
			const labels = cleanOptions.map((option) => option.label);
			const allowFreeform = params.allowFreeform !== false;
			const baseDetails: QuestionDetails = {
				question: params.question,
				options: labels,
				answer: null,
				wasCustom: false,
			};

			if (labels.length === 0) {
				return buildResult(baseDetails, "提问失败：没有可用的选项。请重新调用 question 并至少给出 1 个选项。");
			}

			// print / json 模式下没有对话框能力，直接告诉模型，别让它干等
			if (!ctx.hasUI) {
				return buildResult(baseDetails, "提问失败：当前运行模式不支持向用户提问。请直接基于已有信息继续，或说明需要用户补充什么。");
			}

			try {
				// select 只能收纯文本，选项的 description 就拼到标题后面，保证信息不丢
				const describedOptions = cleanOptions.filter((option) => option.description);
				const title =
					describedOptions.length > 0
						? `${params.question}\n\n${describedOptions
								.map((option) => `· ${option.label}：${option.description}`)
								.join("\n")}`
						: params.question;

				const selectOptions = allowFreeform ? [...labels, FREEFORM_LABEL] : labels;
				const picked = await ctx.ui.select(title, selectOptions);

				// 用户按 Esc 取消：返回一句可读的话，而不是抛错
				if (picked === undefined) {
					return buildResult(baseDetails, `用户取消了提问，没有作答。问题：${params.question}`);
				}

				if (allowFreeform && picked === FREEFORM_LABEL) {
					const typed = await ctx.ui.input(params.question, "请输入你的回答");
					if (typed === undefined) {
						return buildResult(baseDetails, `用户取消了提问，没有作答。问题：${params.question}`);
					}
					const answer = typed.trim();
					if (answer.length === 0) {
						// 空输入不当作答案，明确让模型知道要换个问法
						return buildResult(baseDetails, `用户提交了空回答。问题：${params.question}`);
					}
					return buildResult({ ...baseDetails, answer, wasCustom: true }, `用户输入了自由回答：${answer}`);
				}

				// 选中了固定选项：带上序号，模型更容易引用
				const index = labels.indexOf(picked);
				const answer = index >= 0 ? labels[index] : picked;
				return buildResult(
					{ ...baseDetails, answer, wasCustom: false },
					index >= 0 ? `用户选择了第 ${index + 1} 项：${answer}` : `用户选择：${answer}`,
				);
			} catch (error) {
				// 兜底：Host 侧回包异常、对话框被中断等等，都不能让 turn 失败
				const message = error instanceof Error ? error.message : String(error);
				return buildResult(baseDetails, `提问失败：${message}。请改用其他方式继续，或稍后重试。`);
			}
		},
	});
}
