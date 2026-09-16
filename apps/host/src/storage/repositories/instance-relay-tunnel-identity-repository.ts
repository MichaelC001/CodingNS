import type { SqliteDatabase, SqliteStatement } from "@codingns/host-sqlite-runtime";

import type { InstanceRelayTunnelIdentity } from "../../types/domain.js";

export class InstanceRelayTunnelIdentityRepository {
  constructor(private readonly db: SqliteDatabase) {}

  findIdentity(): InstanceRelayTunnelIdentity | null {
    const row = this.db
      .prepare(
        `SELECT
           key_algorithm,
           private_key_pem,
           public_key_pem,
           key_fingerprint,
           created_at,
           updated_at
         FROM instance_relay_tunnel_identity
         WHERE id = 'default'`
      )
      .get() as InstanceRelayTunnelIdentityRow | undefined;

    return row ? mapIdentityRow(row) : null;
  }

  upsertIdentity(identity: InstanceRelayTunnelIdentity): InstanceRelayTunnelIdentity {
    this.db
      .prepare(
        `INSERT INTO instance_relay_tunnel_identity (
          id,
          key_algorithm,
          private_key_pem,
          public_key_pem,
          key_fingerprint,
          created_at,
          updated_at
        ) VALUES ('default', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          key_algorithm = excluded.key_algorithm,
          private_key_pem = excluded.private_key_pem,
          public_key_pem = excluded.public_key_pem,
          key_fingerprint = excluded.key_fingerprint,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at`
      )
      .run(
        identity.keyAlgorithm,
        identity.privateKeyPem,
        identity.publicKeyPem,
        identity.keyFingerprint,
        identity.createdAt,
        identity.updatedAt
      );

    return identity;
  }

  /**
   * 读 WebRTC 承载层要用的 DTLS 证书。
   *
   * 和 x25519 身份共用同一行；DTLS 那几列全空时返回 null（说明还没生成过）。
   */
  findDtlsIdentity(): RelayTunnelDtlsIdentity | null {
    const row = this.db
      .prepare(
        `SELECT
           dtls_private_key_pem,
           dtls_cert_pem,
           dtls_signature_hash,
           dtls_fingerprint,
           dtls_created_at,
           dtls_updated_at
         FROM instance_relay_tunnel_identity
         WHERE id = 'default'`
      )
      .get() as InstanceRelayTunnelDtlsIdentityRow | undefined;

    if (
      !row
      || !row.dtls_private_key_pem
      || !row.dtls_cert_pem
      || !row.dtls_signature_hash
      || !row.dtls_fingerprint
    ) {
      return null;
    }

    const fallbackTimestamp = new Date(0).toISOString();

    return {
      certificate: {
        privateKeyPem: row.dtls_private_key_pem,
        certPem: row.dtls_cert_pem,
        signatureHash: parseSignatureHash(row.dtls_signature_hash)
      },
      fingerprint: row.dtls_fingerprint,
      createdAt: row.dtls_created_at ?? row.dtls_updated_at ?? fallbackTimestamp,
      updatedAt: row.dtls_updated_at ?? fallbackTimestamp
    };
  }

  /**
   * 写入 DTLS 证书。
   *
   * 前置条件：同一行的 x25519 基础身份必须已经存在（那几列是 NOT NULL）。
   * 调用方先走 `RelayTunnelIdentityService.ensureIdentity()`。
   */
  upsertDtlsIdentity(identity: RelayTunnelDtlsIdentity): RelayTunnelDtlsIdentity {
    this.db
      .prepare(
        `UPDATE instance_relay_tunnel_identity SET
           dtls_private_key_pem = ?,
           dtls_cert_pem = ?,
           dtls_signature_hash = ?,
           dtls_fingerprint = ?,
           dtls_created_at = ?,
           dtls_updated_at = ?
         WHERE id = 'default'`
      )
      .run(
        identity.certificate.privateKeyPem,
        identity.certificate.certPem,
        JSON.stringify(identity.certificate.signatureHash),
        identity.fingerprint,
        identity.createdAt,
        identity.updatedAt
      );

    return identity;
  }
}

/** DTLS 材料在身份表里的形状。 */
export interface RelayTunnelDtlsIdentity {
  certificate: {
    privateKeyPem: string;
    certPem: string;
    signatureHash: { signature: number; hash: number };
  };
  /** `sha-256 XX:XX:...` */
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
}

interface InstanceRelayTunnelDtlsIdentityRow {
  dtls_private_key_pem: string | null;
  dtls_cert_pem: string | null;
  dtls_signature_hash: string | null;
  dtls_fingerprint: string | null;
  dtls_created_at: string | null;
  dtls_updated_at: string | null;
}

function parseSignatureHash(value: string): { signature: number; hash: number } {
  try {
    const parsed = JSON.parse(value) as { signature?: unknown; hash?: unknown };

    if (typeof parsed.signature === "number" && typeof parsed.hash === "number") {
      return { signature: parsed.signature, hash: parsed.hash };
    }
  } catch {
    // 落到下面的兜底值。
  }

  // werift 生成自签证书时固定用 ecdsa(3) + sha256(4)；
  // 解析不出来就按这个还原，不要因为一格坏数据把整条隧道打死。
  return { signature: 3, hash: 4 };
}

interface InstanceRelayTunnelIdentityRow {
  key_algorithm: InstanceRelayTunnelIdentity["keyAlgorithm"];
  private_key_pem: string;
  public_key_pem: string;
  key_fingerprint: string;
  created_at: string;
  updated_at: string;
}

function mapIdentityRow(row: InstanceRelayTunnelIdentityRow): InstanceRelayTunnelIdentity {
  return {
    keyAlgorithm: row.key_algorithm,
    privateKeyPem: row.private_key_pem,
    publicKeyPem: row.public_key_pem,
    keyFingerprint: row.key_fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
