/**
 * 计划模式的纯策略：哪些命令算危险、用户是不是在要计划、助手输出里有没有计划步骤。
 *
 * 单独拆出来是为了能脱离 Pi 运行时直接跑单测——Windows 和 macOS 的命令形态差异很大，
 * 靠人工点一遍测不全。这个文件不依赖 Pi 的任何运行时对象，只有纯函数和常量。
 */

/**
 * 计划模式下必须挡掉的工具。
 * bash 不在这个集合里整条挡掉，而是按命令内容判断，因为读代码经常需要 rg / git log / cat。
 */
export const PLAN_MODE_WRITE_TOOLS = new Set(["edit", "write"]);

/**
 * 明显会改状态的命令片段，命中就不允许执行。
 *
 * 两条注意：
 * - Windows 上 Pi 走的是 powershell 工具，所以 PowerShell 的写动词（Remove-Item、Set-Content…）必须一起挡。
 * - 重定向只在“独立 token”位置才算重定向，否则 `rg "a->b"` 这种只读搜索会被误伤。
 */
export const PLAN_MODE_DESTRUCTIVE_PATTERNS: RegExp[] = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	// 覆盖写与追加写：`> file`、`2> file`、`>> file`；`->`、`=>`、`a>b` 不算。
	/(^|\s|\d)>(?!>|&)/,
	/(^|\s|\d)>>/,
	// Windows / PowerShell 的写动词
	/\b(remove-item|del|erase|rd|move-item|copy-item|new-item|set-content|add-content|clear-content|out-file|rename-item|set-itemproperty|start-process|invoke-expression|iex)\b/i,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish|dlx)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|stash|cherry-pick|revert|tag|init|clean)/i,
	/\bsudo\b/i,
	/\bkill(all)?\b/i,
	/\bpkill\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i
];

/** 计划模式提示词里明确写出来的动作选项；Host 按这些文案识别计划审批。 */
export const PLAN_MODE_NEXT_STEP_OPTIONS = ["执行计划", "继续完善计划", "修改计划", "取消"];

/** 判断一条命令在计划模式下是否危险：命中黑名单就挡，其余（读取、搜索、查询）放行。 */
export function isBlockedPlanModeCommand(command: string): boolean {
	return PLAN_MODE_DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
}

/** 用户是不是在明确要求「做计划 / 先别改」。判不出来就不弹窗，避免打扰。 */
export function looksLikePlanRequest(text: string): boolean {
	const normalized = text.toLowerCase();
	return (
		normalized.includes("计划") ||
		normalized.includes("方案") ||
		normalized.includes("plan") ||
		normalized.includes("先别改") ||
		normalized.includes("不要修改") ||
		normalized.includes("只读")
	);
}

/** 从最后一段助手输出里抠出计划步骤，用来判断「计划是否已经生成」。 */
export function extractPlanSteps(text: string): string[] {
	if (!text.trim()) return [];
	const headerMatch = text.match(/\*{0,2}(Plan|计划)\*{0,2}\s*[:：]/i);
	if (!headerMatch || headerMatch.index === undefined) return [];
	const section = text.slice(headerMatch.index + headerMatch[0].length);
	const steps: string[] = [];
	for (const line of section.split("\n")) {
		// 中文编号常见的收尾符号有「）」「、」「．」，都要认。
		const item = line.match(/^\s*(\d+)[.)）、．]\s*(.+?)\s*$/);
		if (item) {
			const stepText = item[2].replace(/\*{1,2}/g, "").trim();
			if (stepText.length > 0) steps.push(`${steps.length + 1}. ${stepText}`);
		}
	}
	return steps;
}
