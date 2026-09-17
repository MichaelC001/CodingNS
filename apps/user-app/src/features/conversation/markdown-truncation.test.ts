import { describe, expect, it } from "vitest";

import {
  MAX_RENDERED_MARKDOWN_CHARS,
  resolveRenderedMarkdownContent
} from "./markdown-truncation";

describe("超长正文渲染保护", () => {
  it("普通长度正文原样返回且不出现折叠入口", () => {
    const content = "普通消息正文";

    expect(resolveRenderedMarkdownContent(content)).toEqual({
      content,
      isLong: false,
      isCollapsed: false
    });
  });

  it("超过阈值时只保留开头并进入折叠状态", () => {
    const content = "字".repeat(MAX_RENDERED_MARKDOWN_CHARS + 100);
    const result = resolveRenderedMarkdownContent(content);

    expect(result.isLong).toBe(true);
    expect(result.isCollapsed).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(MAX_RENDERED_MARKDOWN_CHARS);
    expect(content.startsWith(result.content)).toBe(true);
  });

  it("展开后返回完整正文，但仍然保留收起入口", () => {
    const content = "字".repeat(MAX_RENDERED_MARKDOWN_CHARS + 100);

    expect(resolveRenderedMarkdownContent(content, { expanded: true })).toEqual({
      content,
      isLong: true,
      isCollapsed: false
    });
  });

  it("导出场景返回完整正文且不给折叠入口", () => {
    const content = "字".repeat(MAX_RENDERED_MARKDOWN_CHARS + 100);

    expect(resolveRenderedMarkdownContent(content, { disabled: true })).toEqual({
      content,
      isLong: false,
      isCollapsed: false
    });
  });

  it("优先在换行处断开，避免拦腰切断 Markdown 结构", () => {
    const line = "重复的一行内容\n";
    const content = line.repeat(
      Math.ceil((MAX_RENDERED_MARKDOWN_CHARS + 500) / line.length)
    );
    const result = resolveRenderedMarkdownContent(content);

    expect(result.isCollapsed).toBe(true);
    expect(result.content.endsWith("重复的一行内容")).toBe(true);
  });

  it("不会把 UTF-16 代理对切成两半", () => {
    // 让截断点正好落在 emoji 代理对的中间。
    const prefix = "a".repeat(MAX_RENDERED_MARKDOWN_CHARS - 1);
    const content = `${prefix}😀${"b".repeat(10)}`;
    const result = resolveRenderedMarkdownContent(content);

    expect(result.isCollapsed).toBe(true);
    expect(result.content.length).toBe(MAX_RENDERED_MARKDOWN_CHARS - 1);
    expect(hasLoneSurrogate(result.content)).toBe(false);
  });
});

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);

      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }

      index += 1;
      continue;
    }

    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }

  return false;
}
