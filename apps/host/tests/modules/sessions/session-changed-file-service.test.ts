import { describe, expect, it } from "vitest";

import type { NormalizedMessage } from "@codingns/session-sync-core";

import { SessionChangedFileService } from "../../../src/modules/sessions/session-changed-file-service.js";
import type { SessionChangedFileRepository } from "../../../src/storage/repositories/session-changed-file-repository.js";
import type { SessionChangedFileRecord } from "../../../src/types/domain.js";

const WORKSPACE_PATH = "/workspace/demo";
const SESSION_ID = "session-1";
const WORKSPACE_ID = "workspace-1";

function createService() {
  const records: SessionChangedFileRecord[] = [];
  const repository = {
    upsertMany: (items: SessionChangedFileRecord[]) => {
      records.push(...items);
    }
  } as unknown as SessionChangedFileRepository;

  return { service: new SessionChangedFileService(repository), records };
}

function createMessage({
  role,
  kind,
  toolName,
  toolInput
}: {
  role: NormalizedMessage["role"];
  kind: NormalizedMessage["kind"];
  toolName: string;
  toolInput: string;
}): NormalizedMessage {
  return {
    messageId: `${role}-${kind}-${toolName}`,
    provider: "command-code",
    providerSessionId: "provider-session-1",
    role,
    kind,
    content: "",
    toolCall: {
      callId: "call-1",
      name: toolName,
      input: toolInput,
      output: null,
      error: null,
      status: "completed"
    },
    timestamp: "2026-09-16T00:00:00.000Z",
    sequence: 1,
    rawRef: "raw://1"
  };
}

describe("SessionChangedFileService", () => {
  it("Command Code 的 assistant + tool_call 消息也能记录变更文件", () => {
    const { service, records } = createService();

    service.recordMessages(SESSION_ID, WORKSPACE_ID, WORKSPACE_PATH, [
      createMessage({
        role: "assistant",
        kind: "tool_call",
        toolName: "write_file",
        toolInput: JSON.stringify({ file_path: "src/app.ts", content: "x" })
      })
    ]);

    expect(records.map((record) => record.path)).toEqual(["src/app.ts"]);
    expect(records[0]?.lastToolName).toBe("write_file");
  });

  it("Claude/Codex 的 tool + tool_call 消息保持原有记录行为", () => {
    const { service, records } = createService();

    service.recordMessages(SESSION_ID, WORKSPACE_ID, WORKSPACE_PATH, [
      createMessage({
        role: "tool",
        kind: "tool_call",
        toolName: "edit",
        toolInput: JSON.stringify({ file_path: "src/main.ts" })
      })
    ]);

    expect(records.map((record) => record.path)).toEqual(["src/main.ts"]);
  });

  it("apply_patch 文本按工作区相对路径归一化，工作区外路径被忽略", () => {
    const { service, records } = createService();

    service.recordMessages(SESSION_ID, WORKSPACE_ID, WORKSPACE_PATH, [
      createMessage({
        role: "assistant",
        kind: "tool_call",
        toolName: "apply_patch",
        toolInput: [
          "*** Begin Patch",
          "*** Update File: ./src/inside.ts",
          "*** Add File: /tmp/outside.ts",
          "*** End Patch"
        ].join("\n")
      })
    ]);

    expect(records.map((record) => record.path)).toEqual(["src/inside.ts"]);
  });

  it("不带 toolCall 的消息不产生记录", () => {
    const { service, records } = createService();
    const message = createMessage({
      role: "assistant",
      kind: "text",
      toolName: "read_file",
      toolInput: JSON.stringify({ file_path: "src/app.ts" })
    });

    service.recordMessages(SESSION_ID, WORKSPACE_ID, WORKSPACE_PATH, [
      { ...message, toolCall: null }
    ]);

    expect(records).toEqual([]);
  });
});
