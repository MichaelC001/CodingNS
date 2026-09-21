import { describe, expect, it, vi } from "vitest";

import {
  normalizeProviderMessageContent,
  SessionMessageAttachmentService
} from "../../src/modules/sessions/session-message-attachment-service.js";

describe("SessionMessageAttachmentService 内容清洗", () => {
  it("会清理 Codex 消息里的内部附件提示块", () => {
    const content = [
      "请先处理这个问题",
      "[[CODINGNS_IMAGE_ATTACHMENTS]]",
      "下面这些图片是用户随消息附带的本地附件。请先读取并理解它们，再继续处理这条请求。",
      "/tmp/session-attachments/example.png",
      "[[/CODINGNS_IMAGE_ATTACHMENTS]]"
    ].join("\n\n");

    expect(normalizeProviderMessageContent("codex", content)).toBe("请先处理这个问题");
  });

  it("缺少结束标记时不会误删消息正文", () => {
    const content = [
      "请先处理这个问题",
      "[[CODINGNS_IMAGE_ATTACHMENTS]]",
      "这是一段不完整的内部提示"
    ].join("\n\n");

    expect(normalizeProviderMessageContent("codex", content)).toBe(content);
  });

  it("会为 Command Code 生成附件路径提示并清理内部提示块", () => {
    const service = new SessionMessageAttachmentService(
      {} as never,
      { databasePath: "/tmp/codingns-test.sqlite" } as never
    );
    const prompt = service.buildProviderPrompt("command-code", "请分析这张图", [
      {
        id: "attachment-1",
        kind: "image",
        fileName: "截图.png",
        mimeType: "image/png",
        fileSize: 128,
        filePath: "/tmp/session-attachments/screenshot.png"
      }
    ]);

    expect(prompt).toContain("/tmp/session-attachments/screenshot.png");
    expect(normalizeProviderMessageContent("command-code", prompt!)).toBe("请分析这张图");
  });

  it("没有待绑定附件时不执行无效 UPDATE", () => {
    const repository = {
      listUnboundBySessionAndClientRequest: vi.fn().mockReturnValue([]),
      bindMessage: vi.fn(),
      listBySessionAndClientRequest: vi.fn().mockReturnValue([])
    };
    const service = new SessionMessageAttachmentService(
      repository as never,
      { databasePath: "/tmp/codingns-test.sqlite" } as never
    );

    expect(service.bindClientRequestToMessage("session-1", "request-1", "message-1")).toEqual([]);
    expect(repository.bindMessage).not.toHaveBeenCalled();
    expect(repository.listUnboundBySessionAndClientRequest).toHaveBeenCalledWith("session-1", "request-1");
  });
});
