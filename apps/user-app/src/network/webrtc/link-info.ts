/**
 * 链路类型（spec001.9 W2.3）
 *
 * 只回答一个用户关心的问题：现在业务数据是「直连」还是「经中继」。
 *
 * 判断依据是 WebRTC 选中的那对 ICE 候选：
 * 只要本地或远端的候选类型是 `relay`，数据就是经 TURN 转发的，算「经中继」。
 *
 * 注意：`host` / `srflx` / `relay` / ICE 这些词只在代码和日志里出现，
 * 界面上给用户看的说法是「直连」和「经中继」，见 i18n 字典。
 */

export type TunnelLinkTransportKind = "p2p" | "relay";

export interface TunnelLinkIceCandidateSummary {
  type: string;
  protocol: string | null;
  address: string | null;
}

export interface TunnelLinkInfo {
  transportKind: TunnelLinkTransportKind;
  localCandidate: TunnelLinkIceCandidateSummary | null;
  remoteCandidate: TunnelLinkIceCandidateSummary | null;
  updatedAt: string;
}

/** `getStats()` 摊平后我们真正会读的字段。 */
export interface RawStatsEntry {
  type?: string;
  id?: string;
  state?: string;
  nominated?: boolean;
  candidateType?: string;
  protocol?: string;
  address?: string;
  selectedCandidatePairId?: string;
  localCandidateId?: string;
  remoteCandidateId?: string;
}

/**
 * 把 `getStats()` 的返回值摊平成对象数组。
 *
 * 这里要同时伺候三种实现，浏览器和 Node 侧给的东西并不一样：
 *
 * - 浏览器给的是 `RTCStatsReport`。它是 maplike，`instanceof Map` 和 `Array.isArray`
 *   都是 false，只能靠 `forEach` 遍历。早先只认 Map / 数组，结果浏览器里摊平出来是空数组，
 *   「直连还是经中继」永远显示不出来。
 * - werift 给的是 `Map`。
 * - 测试里的假实现给的是数组。
 *
 * 摊平时把 map 的 key 补回成 `id`（有些统计对象本身不带 id），
 * 否则按 id 找候选对会对不上。
 */
export function toStatsArray(rawStats: unknown): RawStatsEntry[] {
  const entries: Array<readonly [string, unknown]> = [];

  if (rawStats instanceof Map) {
    entries.push(...(rawStats.entries() as IterableIterator<[string, unknown]>));
  } else if (Array.isArray(rawStats)) {
    rawStats.forEach((value, index) => {
      entries.push([String(index), value] as const);
    });
  } else if (rawStats && typeof (rawStats as { forEach?: unknown }).forEach === "function") {
    // maplike：RTCStatsReport 走这条。回调参数是 (value, key, parent)。
    (rawStats as { forEach: (callback: (value: unknown, key: string) => void) => void }).forEach(
      (value, key) => {
        entries.push([String(key), value] as const);
      }
    );
  }

  return entries.map(([key, value]) => {
    const record = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;

    return {
      ...record,
      id: typeof record.id === "string" ? record.id : String(key)
    } as RawStatsEntry;
  });
}

/** 判断一组候选对算不算「经中继」。 */
export function resolveTunnelLinkTransportKind(
  localCandidateType: string | null | undefined,
  remoteCandidateType: string | null | undefined
): TunnelLinkTransportKind {
  if (localCandidateType === "relay" || remoteCandidateType === "relay") {
    return "relay";
  }

  return "p2p";
}

/** 从 RTCPeerConnection 的 getStats 结果里找出选中的候选对。 */
export function resolveSelectedCandidatePair(
  stats: Iterable<{ type?: string; state?: string; nominated?: boolean; id?: string }>
): { localCandidateId: string | null; remoteCandidateId: string | null } | null {
  const entries = Array.from(stats);
  const pairs = entries.filter((entry) => entry.type === "candidate-pair");
  const transport = entries.find((entry) => entry.type === "transport");
  const transportSelectedPairId = (transport as { selectedCandidatePairId?: string } | undefined)
    ?.selectedCandidatePairId;

  // 优先信 transport 的 selectedCandidatePairId，其次找 succeeded + nominated 的那对。
  const selected =
    (transportSelectedPairId
      ? pairs.find((pair) => pair.id === transportSelectedPairId)
      : undefined)
    ?? pairs.find((pair) => pair.state === "succeeded" && pair.nominated)
    ?? pairs.find((pair) => pair.state === "succeeded")
    ?? pairs.find((pair) => pair.state === "in-progress")
    ?? null;

  if (!selected) {
    return null;
  }

  const record = selected as { localCandidateId?: string; remoteCandidateId?: string };

  return {
    localCandidateId: record.localCandidateId ?? null,
    remoteCandidateId: record.remoteCandidateId ?? null
  };
}

/** 从 getStats 结果里读一条候选的信息。 */
export function readCandidateSummary(
  stats: Iterable<{ type?: string; id?: string; candidateType?: string; protocol?: string; address?: string }>,
  candidateId: string | null
): TunnelLinkIceCandidateSummary | null {
  if (!candidateId) {
    return null;
  }

  for (const entry of stats) {
    if (entry.id === candidateId) {
      return {
        type: entry.candidateType ?? "unknown",
        protocol: entry.protocol ?? null,
        address: entry.address ?? null
      };
    }
  }

  return null;
}
