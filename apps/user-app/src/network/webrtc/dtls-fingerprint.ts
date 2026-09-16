/**
 * DTLS 指纹校验（spec001.9 W2.2）
 *
 * 为什么需要这一步：
 * 端到端加密由 WebRTC 自带的 DTLS 负责，信令服务器和 TURN 都拿不到明文。
 * 但信令服务器经手 SDP，如果它被控制，攻击者可以把自己的证书指纹塞进 SDP 里，
 * 冒充 Host 跟客户端建立连接。
 *
 * 所以客户端必须拿「从控制面换票据时一起取到的 Host 指纹」去比对 SDP 里的指纹。
 * 指纹来自控制面的绑定记录（见 control-api 的 `/api/v1/relay/signaling/ticket`），
 * 攻击者要同时改掉信令和控制面才能骗过去。
 *
 * 两边写出来的指纹格式不一定一样：
 * - 控制面存的是 `sha-256 AB:CD:...` 这种带算法前缀的写法，大小写也可能不同
 * - SDP 里的 `a=fingerprint` 行算法名大小写由实现决定，分隔符可能是 `:` 或 `-`
 *
 * 所以比对前先归一化：只保留算法名和十六进制字符，其余一律忽略。
 */

import { WebRtcTunnelError } from "./errors";

/** 指纹对不上时抛这个错误码，UI 侧据此给出人话提示。 */
export const DTLS_FINGERPRINT_MISMATCH_MESSAGE_KEY = "settings.remoteAccessErrorFingerprintMismatch";

/** 从 SDP 里解析出来的指纹。 */
export interface DtlsFingerprint {
  /** 归一化后的算法名，例如 `sha-256`。 */
  algorithm: string;
  /** 归一化后的大写十六进制，不带分隔符。 */
  value: string;
}

/** 匹配 SDP 里的一行 `a=fingerprint:<算法> <值>`。 */
const FINGERPRINT_LINE_PATTERN = /a=fingerprint\s*:\s*([A-Za-z0-9-]+)[ \t]+([0-9A-Fa-f:\-]+)/g;

/**
 * 归一化后允许的最小指纹长度（十六进制字符数）。
 *
 * 十六进制字符集很宽，像 `a=setup:active` 这样跟在指纹后面的 SDP 行也能被误吞进来，
 * 所以这里做个下限兜底：太短的一律当解析失败，宁可断开也不要拿半截指纹去比。
 */
const MIN_FINGERPRINT_HEX_LENGTH = 32;

/**
 * 从 SDP 里取出第一段 `a=fingerprint`。
 *
 * 找不到时返回 null，由调用方决定怎么报错（这里不抛，方便单测直接断言解析结果）。
 */
export function parseDtlsFingerprintFromSdp(sdp: string): DtlsFingerprint | null {
  if (typeof sdp !== "string" || sdp.trim().length === 0) {
    return null;
  }

  // 全局正则带 lastIndex，复用前先归零，避免第二次调用从中间开始扫。
  FINGERPRINT_LINE_PATTERN.lastIndex = 0;

  const match = FINGERPRINT_LINE_PATTERN.exec(sdp);
  FINGERPRINT_LINE_PATTERN.lastIndex = 0;

  if (!match) {
    return null;
  }

  return normalizeFingerprint(match[1], match[2]);
}

/**
 * 归一化指纹文本。
 *
 * 接受 `sha-256 AB:CD:EF`、`SHA-256 ab-cd-ef`、`ab:cd:ef` 这些写法。
 * 算法名统一成小写；十六进制统一成大写、去掉全部分隔符。
 */
export function normalizeFingerprintText(fingerprint: string): DtlsFingerprint | null {
  if (typeof fingerprint !== "string") {
    return null;
  }

  const trimmed = fingerprint.trim();

  if (trimmed.length === 0) {
    return null;
  }

  const separatorIndex = trimmed.search(/\s/);

  if (separatorIndex < 0) {
    // 只有一段十六进制，没有算法前缀。
    return normalizeFingerprint(null, trimmed);
  }

  return normalizeFingerprint(trimmed.slice(0, separatorIndex), trimmed.slice(separatorIndex + 1));
}

/**
 * 比对两个指纹是否一致（归一化之后）。
 *
 * 两边都解析不出内容时返回 false：宁可直接断开，也不要「都没解析出来所以放行」。
 */
export function isDtlsFingerprintMatch(
  expected: string,
  actual: string | DtlsFingerprint | null | undefined
): boolean {
  const expectedFingerprint = normalizeFingerprintText(expected);
  const actualFingerprint =
    typeof actual === "string"
      ? normalizeFingerprintText(actual)
      : actual ?? null;

  if (!expectedFingerprint || !actualFingerprint) {
    return false;
  }

  return (
    expectedFingerprint.algorithm === actualFingerprint.algorithm
    && expectedFingerprint.value === actualFingerprint.value
  );
}

function normalizeFingerprint(
  algorithm: string | null | undefined,
  value: string
): DtlsFingerprint | null {
  const normalizedAlgorithm = typeof algorithm === "string"
    ? algorithm.trim().toLowerCase()
    : "";
  const hex = value.replace(/[^0-9A-Fa-f]/g, "").toUpperCase();

  if (hex.length < MIN_FINGERPRINT_HEX_LENGTH) {
    return null;
  }

  return {
    // 解析不出算法名时统一记成空串，这样「带算法名」和「不带算法名」不会被误判成相等。
    algorithm: normalizedAlgorithm,
    value: hex
  };
}

/**
 * 校验 Host 回的 SDP。
 *
 * 不返回布尔值，而是「通过就正常返回、不通过就抛错」：
 * 调用点在建连流程里，抛错才会真的把连接停掉，写成返回值容易被漏判。
 */
export function verifyHostDtlsFingerprint(input: {
  /** 控制面换票据时下发的 Host 指纹，这是唯一可信来源。 */
  expectedFingerprint: string;
  /** Host 回的 answer SDP。 */
  answerSdp: string;
}): DtlsFingerprint {
  const expected = normalizeFingerprintText(input.expectedFingerprint);

  if (!expected) {
    throw new WebRtcTunnelError(
      "控制面没有下发可用的 Host 指纹，无法确认对面是不是你的 Host，已停止连接",
      "HOST_DTLS_FINGERPRINT_MISMATCH",
      "hostDtlsFingerprint 为空或格式无法识别"
    );
  }

  const actual = parseDtlsFingerprintFromSdp(input.answerSdp);

  if (!actual) {
    throw new WebRtcTunnelError(
      "对方回的连接信息里没有可校验的身份指纹，无法确认对面是不是你的 Host，已停止连接",
      "HOST_DTLS_FINGERPRINT_MISMATCH",
      "answer SDP 里没有 a=fingerprint 行"
    );
  }

  if (!isDtlsFingerprintMatch(input.expectedFingerprint, actual)) {
    throw new WebRtcTunnelError(
      "对方的身份指纹和你的 Host 记录不一致，连接已断开。这通常意味着连接被第三方劫持了。",
      "HOST_DTLS_FINGERPRINT_MISMATCH",
      `控制面记录 ${expected.algorithm || "未知算法"} ${expected.value}，SDP 里是 ${
        actual.algorithm || "未知算法"
      } ${actual.value}`
    );
  }

  return actual;
}
