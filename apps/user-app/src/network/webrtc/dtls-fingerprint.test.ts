import { describe, expect, it } from "vitest";

import {
  isDtlsFingerprintMatch,
  normalizeFingerprintText,
  parseDtlsFingerprintFromSdp,
  verifyHostDtlsFingerprint
} from "./dtls-fingerprint";
import { WebRtcTunnelError } from "./errors";

const SDP_FINGERPRINT = "8F:2A:11:0B:9C:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD";

function buildAnswerSdp(fingerprintLine: string | null, algorithm = "sha-256"): string {
  const lines = [
    "v=0",
    "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    "a=ice-ufrag:codingns",
    "a=ice-pwd:codingns-codingns-codingns"
  ];

  if (fingerprintLine !== null) {
    lines.push(`a=fingerprint:${algorithm} ${fingerprintLine}`);
  }

  lines.push("a=setup:active", "a=mid:0", "a=sctp-port:5000");

  return `${lines.join("\r\n")}\r\n`;
}

describe("dtls-fingerprint", () => {
  it("从 answer SDP 里解析出指纹", () => {
    const parsed = parseDtlsFingerprintFromSdp(buildAnswerSdp(SDP_FINGERPRINT));

    expect(parsed).toEqual({
      algorithm: "sha-256",
      value: SDP_FINGERPRINT.replace(/:/g, "")
    });
  });

  it("SDP 里没有 fingerprint 行时返回 null", () => {
    expect(parseDtlsFingerprintFromSdp(buildAnswerSdp(null))).toBeNull();
    expect(parseDtlsFingerprintFromSdp("")).toBeNull();
    expect(parseDtlsFingerprintFromSdp("v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n")).toBeNull();
  });

  it("归一化时忽略大小写和分隔符差异", () => {
    expect(normalizeFingerprintText("SHA-256 " + SDP_FINGERPRINT.replace(/:/g, "-").toLowerCase())).toEqual({
      algorithm: "sha-256",
      value: SDP_FINGERPRINT.replace(/:/g, "")
    });
    expect(normalizeFingerprintText(SDP_FINGERPRINT)).toEqual({
      algorithm: "",
      value: SDP_FINGERPRINT.replace(/:/g, "")
    });
  });

  it("指纹完全一致时判断为匹配", () => {
    expect(
      isDtlsFingerprintMatch(`sha-256 ${SDP_FINGERPRINT}`, `SHA-256 ${SDP_FINGERPRINT}`)
    ).toBe(true);
  });

  it("大小写不同也算匹配", () => {
    expect(
      isDtlsFingerprintMatch(
        `SHA-256 ${SDP_FINGERPRINT}`,
        `sha-256 ${SDP_FINGERPRINT.toLowerCase()}`
      )
    ).toBe(true);
  });

  it("分隔符不同也算匹配", () => {
    expect(
      isDtlsFingerprintMatch(
        `sha-256 ${SDP_FINGERPRINT}`,
        `sha-256 ${SDP_FINGERPRINT.replace(/:/g, "-")}`
      )
    ).toBe(true);
    expect(
      isDtlsFingerprintMatch(
        `sha-256 ${SDP_FINGERPRINT}`,
        `sha-256 ${SDP_FINGERPRINT.replace(/:/g, "")}`
      )
    ).toBe(true);
  });

  it("SDP 里指纹后面紧跟别的行时不会把后面的行吞进来", () => {
    const parsed = parseDtlsFingerprintFromSdp(buildAnswerSdp(SDP_FINGERPRINT));

    expect(parsed?.value).toBe("8F2A110B9C33445566778899AABBCCDDEEFF00112233445566778899AABBCCDD");
    expect(parsed?.value.length).toBe(64);
  });

  it("太短的十六进制串不当作有效指纹", () => {
    expect(normalizeFingerprintText("sha-256 AB:CD")).toBeNull();
  });

  it("指纹真的不一致时判断为不匹配", () => {
    const other = SDP_FINGERPRINT.replace("8F", "7E");

    expect(isDtlsFingerprintMatch(`sha-256 ${SDP_FINGERPRINT}`, `sha-256 ${other}`)).toBe(false);
  });

  it("算法名不同时判断为不匹配", () => {
    expect(
      isDtlsFingerprintMatch(`sha-256 ${SDP_FINGERPRINT}`, `sha-1 ${SDP_FINGERPRINT}`)
    ).toBe(false);
  });

  it("两边都解析不出内容时判断为不匹配", () => {
    expect(isDtlsFingerprintMatch("", "")).toBe(false);
    expect(isDtlsFingerprintMatch("sha-256 ", "sha-256 ")).toBe(false);
  });

  it("verifyHostDtlsFingerprint 在一致时返回解析结果", () => {
    const result = verifyHostDtlsFingerprint({
      expectedFingerprint: `SHA-256 ${SDP_FINGERPRINT}`,
      answerSdp: buildAnswerSdp(SDP_FINGERPRINT)
    });

    expect(result.value).toBe(SDP_FINGERPRINT.replace(/:/g, ""));
  });

  it("verifyHostDtlsFingerprint 在不一致时抛出 HOST_DTLS_FINGERPRINT_MISMATCH", () => {
    const other = SDP_FINGERPRINT.replace("8F", "7E");

    try {
      verifyHostDtlsFingerprint({
        expectedFingerprint: `sha-256 ${SDP_FINGERPRINT}`,
        answerSdp: buildAnswerSdp(other)
      });
      throw new Error("本该抛错但没有抛");
    } catch (error) {
      expect(error).toBeInstanceOf(WebRtcTunnelError);
      expect((error as WebRtcTunnelError).code).toBe("HOST_DTLS_FINGERPRINT_MISMATCH");
    }
  });

  it("verifyHostDtlsFingerprint 在 SDP 缺少 fingerprint 时抛出 HOST_DTLS_FINGERPRINT_MISMATCH", () => {
    try {
      verifyHostDtlsFingerprint({
        expectedFingerprint: `sha-256 ${SDP_FINGERPRINT}`,
        answerSdp: buildAnswerSdp(null)
      });
      throw new Error("本该抛错但没有抛");
    } catch (error) {
      expect(error).toBeInstanceOf(WebRtcTunnelError);
      expect((error as WebRtcTunnelError).code).toBe("HOST_DTLS_FINGERPRINT_MISMATCH");
      expect((error as WebRtcTunnelError).detail).toContain("没有 a=fingerprint");
    }
  });

  it("verifyHostDtlsFingerprint 在控制面没给指纹时抛出 HOST_DTLS_FINGERPRINT_MISMATCH", () => {
    try {
      verifyHostDtlsFingerprint({
        expectedFingerprint: "   ",
        answerSdp: buildAnswerSdp(SDP_FINGERPRINT)
      });
      throw new Error("本该抛错但没有抛");
    } catch (error) {
      expect(error).toBeInstanceOf(WebRtcTunnelError);
      expect((error as WebRtcTunnelError).code).toBe("HOST_DTLS_FINGERPRINT_MISMATCH");
    }
  });
});
