import { afterEach, describe, expect, it, vi } from "vitest";

import { zhCN } from "../i18n/zh-CN";
import { enUS } from "../i18n/en-US";
import {
  describeControlError,
  loadHostLoginAccounts,
  listControlErrorCodes,
  listControlErrorMessageKeys,
  resolveControlErrorMessageKey
} from "./control-client-actions";
import { WebRtcTunnelError } from "../network/webrtc/errors";
import { resetHostTransportRegistryForTesting, setHostTransportResolverForTesting } from "../network/host-transport-registry";

afterEach(() => {
  resetHostTransportRegistryForTesting();
});

/**
 * 这一组不 mock 模块，专门验「错误码 → i18n 键」这层映射。
 *
 * 目的：中间层不许写死显示文案；每个错误码都必须在中英文字典里有对应翻译，
 * 以后新增错误码忘了补翻译时，这里会直接红。
 */
function readDictionaryValue(dictionary: Record<string, unknown>, key: string): string | null {
  let current: unknown = dictionary;

  for (const segment of key.split(".")) {
    if (!current || typeof current !== "object") {
      return null;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return typeof current === "string" ? current : null;
}

describe("control-client-actions 错误码映射", () => {
  it("通过 WebRTC transport 解析 Host 账号，并过滤不完整记录", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      accounts: [
        { userId: "u1", username: "admin", role: "admin", passwordHash: "must-not-leak" },
        { userId: "u2", username: "disabled", role: "user" },
        { userId: "u3", username: "", role: "admin" }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } }));

    setHostTransportResolverForTesting(() => ({
      fetch: fetchMock,
      createWebSocket: () => { throw new Error("not used"); }
    }));

    await expect(loadHostLoginAccounts({
      controlBaseUrl: "https://channel.codingns.com:1443",
      tunnelDomain: "demo.channel.codingns.com"
    })).resolves.toEqual([{ userId: "u1", username: "admin", role: "admin" }]);
    expect(fetchMock).toHaveBeenCalledWith(expect.objectContaining({
      path: "/api/public/host-login-accounts",
      baseUrl: "https://demo.channel.codingns.com:1443"
    }));
  });

  it("每个错误码都能解析出一个已翻译、且不等于 key 本身的文案", () => {
    const codes = listControlErrorCodes();
    expect(codes.length).toBeGreaterThan(0);

    for (const code of codes) {
      const key = resolveControlErrorMessageKey(code);
      expect(key, `${code} 没有对应 i18n 键`).toBeTruthy();

      const zh = readDictionaryValue(zhCN, key);
      const en = readDictionaryValue(enUS, key);
      expect(zh, `zh-CN 缺少 ${key}`).toBeTruthy();
      expect(en, `en-US 缺少 ${key}`).toBeTruthy();
      // 翻译不能等于 key 本身，那说明字典里漏加了。
      expect(zh).not.toBe(key);
      expect(en).not.toBe(key);
    }

    // 键和错误码一一对应，没有重复也没有孤儿。
    expect(new Set(listControlErrorMessageKeys()).size).toBe(codes.length);
  });

  it("没登记过的错误码退回「未知错误」，不把错误码丢给用户", () => {
    const fallback = resolveControlErrorMessageKey("SOME_FUTURE_CODE");

    expect(fallback).toBe("settings.remoteAccessErrorUnknown");
    expect(readDictionaryValue(zhCN, fallback)).toBeTruthy();
    expect(readDictionaryValue(enUS, fallback)).toBeTruthy();
  });

  it("describeControlError 只返回 i18n 键和技术细节，不返回写死的显示句子", () => {
    const view = describeControlError(
      new WebRtcTunnelError("指纹对不上", "HOST_DTLS_FINGERPRINT_MISMATCH", "expected ab, got cd")
    );

    expect(view.messageKey).toBe("settings.remoteAccessErrorFingerprintMismatch");
    expect(view.detail).toBe("expected ab, got cd");

    const unknownView = describeControlError(new Error("socket hang up"));
    expect(unknownView.messageKey).toBe("settings.remoteAccessErrorUnknown");
    expect(unknownView.detail).toBe("socket hang up");
  });
});
