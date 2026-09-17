/**
 * 超长正文的渲染保护。
 *
 * 模型偶尔会退化复读，在单条消息里输出上百万字符的重复正文。前端同步解析
 * 这种 Markdown 时会长时间占住主线程，表现就是打开会话后页面直接卡死。
 * 所以超过阈值的正文只渲染开头一段，剩下的交给用户显式展开。
 */

/** 与富内容解析的缓存阈值保持一致：超过 64KB 的正文按超长内容处理。 */
export const MAX_RENDERED_MARKDOWN_CHARS = 64 * 1024;

/** 为了在换行处断开最多允许砍掉的比例，避免内容被削掉一大截。 */
const MIN_TRUNCATION_RATIO = 0.8;

export interface RenderedMarkdownContent {
  /** 实际交给 Markdown 渲染的正文。 */
  content: string;
  /** 正文是否超过阈值；超过就要给用户展开/收起的入口。 */
  isLong: boolean;
  /** 当前是否只渲染了开头部分。 */
  isCollapsed: boolean;
}

export interface ResolveRenderedMarkdownContentOptions {
  /** 用户是否已经点了展开全文。 */
  expanded?: boolean;
  /** 跳过折叠，例如导出会话时需要完整正文。 */
  disabled?: boolean;
}

export function resolveRenderedMarkdownContent(
  content: string,
  options: ResolveRenderedMarkdownContentOptions = {}
): RenderedMarkdownContent {
  // 导出这类场景要完整正文，也不该出现折叠入口。
  if (options.disabled || content.length <= MAX_RENDERED_MARKDOWN_CHARS) {
    return { content, isLong: false, isCollapsed: false };
  }

  if (options.expanded) {
    return { content, isLong: true, isCollapsed: false };
  }

  return {
    content: truncateMarkdownContent(content),
    isLong: true,
    isCollapsed: true
  };
}

function truncateMarkdownContent(content: string): string {
  let cut = content.slice(0, MAX_RENDERED_MARKDOWN_CHARS);

  // 不要把 UTF-16 代理对切成两半，否则末尾会留下半个字符。
  if (/[\uD800-\uDBFF]$/.test(cut)) {
    cut = cut.slice(0, -1);
  }

  // 尽量在换行处断开，避免把正在写的 Markdown 结构拦腰截断。
  const lastLineBreak = cut.lastIndexOf("\n");

  if (lastLineBreak >= MAX_RENDERED_MARKDOWN_CHARS * MIN_TRUNCATION_RATIO) {
    return cut.slice(0, lastLineBreak);
  }

  return cut;
}
