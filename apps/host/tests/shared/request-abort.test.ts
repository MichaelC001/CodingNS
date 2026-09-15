import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { createRequestAbortSignal } from "../../src/shared/http/request-abort.js";

function createRequestRawState(input: {
  aborted?: boolean;
  complete?: boolean;
  destroyed?: boolean;
}): EventEmitter & {
  aborted?: boolean;
  complete?: boolean;
  destroyed?: boolean;
} {
  const raw = new EventEmitter() as EventEmitter & {
    aborted?: boolean;
    complete?: boolean;
    destroyed?: boolean;
  };

  Object.assign(raw, input);
  return raw;
}

describe("createRequestAbortSignal", () => {
  it("不会把已完整读取但底层流已销毁的请求误判为取消", () => {
    const raw = createRequestRawState({ complete: true, destroyed: true });
    const signal = createRequestAbortSignal({ raw } as never);

    expect(signal.aborted).toBe(false);

    raw.emit("close");

    expect(signal.aborted).toBe(false);
  });

  it("会取消尚未完整读取就断开的请求", () => {
    const raw = createRequestRawState({ complete: false, destroyed: true });
    const signal = createRequestAbortSignal({ raw } as never);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(Error);
  });
});
