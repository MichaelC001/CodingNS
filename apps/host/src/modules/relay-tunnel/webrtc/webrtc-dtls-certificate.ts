/**
 * Host 侧 DTLS 证书（spec001.9 W4.1 前半）
 *
 * 为什么要自己生成并持久化：
 *
 * WebRTC 的端到端加密由 DTLS 承担，客户端靠「比对 SDP 里的 a=fingerprint 与控制面下发的指纹」
 * 来确认对面真的是这台 Host。如果每次启动都现生成一张证书，指纹就会变，
 * 客户端那边永远对不上——所以证书必须在 Host 首次启用时生成一次，然后长期保存。
 *
 * 存哪：复用 `instance_relay_tunnel_identity` 那条记录，不新开表。
 * 老的 x25519 身份材料先留着（老 WSS 路径还在跑，W6.1 才删），DTLS 材料是同一行的新列。
 *
 * 指纹格式：`sha-256 XX:XX:...`（大写十六进制，冒号分隔），和控制面、客户端约定一致。
 */
import { RTCDtlsTransport, type RTCCertificate } from "werift";

import { nowIso } from "../../../shared/utils/time.js";
import type { InstanceRelayTunnelIdentityRepository } from "../../../storage/repositories/instance-relay-tunnel-identity-repository.js";
import { RelayTunnelIdentityService } from "../crypto/relay-tunnel-identity-service.js";
import type { WebrtcPeerDtlsCertificate } from "./webrtc-peer-ipc.js";

/** 存库 + 对外使用的完整 DTLS 身份。 */
export interface RelayTunnelDtlsIdentity {
  certificate: WebrtcPeerDtlsCertificate;
  /** `sha-256 XX:XX:...` */
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 读取或生成 DTLS 证书。
 *
 * - 库里已经有：直接返回，保证指纹稳定
 * - 库里没有：生成一张自签 ECDSA P-256 证书（werift 自带能力，不额外引依赖），落库后返回
 */
export async function ensureRelayTunnelDtlsIdentity(
  repository: InstanceRelayTunnelIdentityRepository
): Promise<RelayTunnelDtlsIdentity> {
  const existing = repository.findDtlsIdentity();

  if (existing) {
    return existing;
  }

  // DTLS 材料和老 x25519 身份共用一行，那几列是 NOT NULL，
  // 所以落 DTLS 之前必须先保证基础身份存在。
  new RelayTunnelIdentityService(repository).ensureIdentity();

  const generated = await generateRelayTunnelDtlsIdentity();
  repository.upsertDtlsIdentity(generated);
  return generated;
}

/** 只读：库里没有就返回 null，不触发生成。 */
export function readRelayTunnelDtlsIdentity(
  repository: InstanceRelayTunnelIdentityRepository
): RelayTunnelDtlsIdentity | null {
  return repository.findDtlsIdentity();
}

/** 现生成一张自签 DTLS 证书（不落库，落库由 `ensureRelayTunnelDtlsIdentity` 负责）。 */
export async function generateRelayTunnelDtlsIdentity(): Promise<RelayTunnelDtlsIdentity> {
  const certificate = await createSelfSignedCertificate();
  const timestamp = nowIso();

  return {
    certificate: {
      privateKeyPem: certificate.privateKey,
      certPem: certificate.certPem,
      signatureHash: certificate.signatureHash as unknown as { signature: number; hash: number }
    },
    fingerprint: formatDtlsFingerprint(certificate),
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

/**
 * 从 werift 的 `RTCCertificate.getFingerprints()` 取指纹。
 *
 * werift 返回的是 `[{ algorithm: "sha-256", value: "AB:CD:..." }]`，
 * 统一格式化成 `sha-256 AB:CD:...`。
 */
export function formatDtlsFingerprint(certificate: RTCCertificate): string {
  const fingerprints = certificate.getFingerprints();
  const preferred = fingerprints.find((item) => item.algorithm.toLowerCase() === "sha-256")
    ?? fingerprints[0];

  if (!preferred) {
    throw new Error("这张 DTLS 证书取不到指纹");
  }

  const normalizedValue = preferred.value
    .split(":")
    .map((part) => part.trim().toUpperCase().padStart(2, "0"))
    .join(":");

  return `${preferred.algorithm.toLowerCase()} ${normalizedValue}`;
}

/**
 * 生成一张自签证书。
 *
 * 走 werift 自己的 `RTCDtlsTransport.SetupCertificate()`：
 * 它内部用纯 JS 生成 ECDSA P-256 自签证书，和 DTLS 握手时用的签名算法一致。
 * 自己拿 `node:crypto` 拼 X.509 也行，但没必要多写一遍。
 */
async function createSelfSignedCertificate(): Promise<RTCCertificate> {
  return await RTCDtlsTransport.SetupCertificate();
}
