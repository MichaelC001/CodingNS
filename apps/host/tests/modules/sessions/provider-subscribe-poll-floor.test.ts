import { ClaudeCodeAdapter, GeminiAdapter, KimiAdapter } from "@codingns/session-sync-core";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 活跃订阅的 provider 内部轮询下限。
 *
 * Host generic 分支已经把事件源交给 provider 自己的 subscribeSession，
 * 所以必须锁住 provider 侧不会重新长出 300ms / 700ms 级别的机械轮询。
 * 这里只做确认，不改变 provider 行为。
 */
const MIN_ACTIVE_SUBSCRIPTION_POLL_INTERVAL_MS = 1_000;

describe("provider subscribeSession 轮询下限", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    [
      "claude-code",
      () => new ClaudeCodeAdapter({ homeDir: "/tmp/codingns-poll-floor/claude" })
    ],
    [
      "gemini",
      () => new GeminiAdapter({ homeDir: "/tmp/codingns-poll-floor/gemini" })
    ],
    [
      "kimi",
      () => new KimiAdapter({
        homeDir: "/tmp/codingns-poll-floor/kimi",
        defaultModel: "kimi-k2"
      })
    ]
  ])("%s 订阅不会安排低于 1 秒的轮询 timer", (_providerId, createAdapter) => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const adapter = createAdapter();
    const subscription = adapter.subscribeSession(
      "provider-session-poll-floor",
      "/tmp/codingns-poll-floor/missing-session.jsonl",
      null,
      20,
      () => undefined
    );

    const scheduledDelays = [
      ...setTimeoutSpy.mock.calls.map((call) => call[1]),
      ...setIntervalSpy.mock.calls.map((call) => call[1])
    ].filter((delay): delay is number => typeof delay === "number");

    expect(scheduledDelays.length).toBeGreaterThan(0);
    expect(Math.min(...scheduledDelays)).toBeGreaterThanOrEqual(
      MIN_ACTIVE_SUBSCRIPTION_POLL_INTERVAL_MS
    );

    subscription.close();
  });

  it("Gemini 遇到重复签名后仍按空闲退避继续轮询", async () => {
    vi.useFakeTimers();
    const adapter = new GeminiAdapter({ homeDir: "/tmp/codingns-poll-floor/gemini" });
    const read = vi.spyOn(adapter as never, "readSessionHistorySync" as never)
      .mockReturnValue({
        messages: [{ messageId: "same-message" }],
        cursor: "same-cursor",
        nextCursor: null,
        total: 1
      } as never);
    const subscription = adapter.subscribeSession("session", "session", null, 20, () => undefined);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(3);
    subscription.close();
  });

  it("Kimi 单次读取异常后不会丢失后续轮询", async () => {
    vi.useFakeTimers();
    const adapter = new KimiAdapter({
      homeDir: "/tmp/codingns-poll-floor/kimi",
      defaultModel: "kimi-k2"
    });
    const revision = vi.spyOn(adapter as never, "readSessionRevision" as never)
      .mockReturnValueOnce(1 as never)
      .mockImplementationOnce(() => {
        throw new Error("temporary read failure");
      })
      .mockReturnValue(1 as never);
    const subscription = adapter.subscribeSession("session", "session", null, 20, () => undefined);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(revision).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(revision).toHaveBeenCalledTimes(3);
    subscription.close();
  });
});
