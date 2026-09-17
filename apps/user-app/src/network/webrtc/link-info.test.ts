/**
 * 链路类型解析单测（spec001.9 W2.3）
 *
 * 这里的重点是 `getStats()` 的三种返回形态。真实浏览器给的是 `RTCStatsReport`，
 * 它是 maplike 而不是 Map：`instanceof Map` 和 `Array.isArray` 都是 false。
 * 之前只认后两种，导致浏览器里摊平出来是空数组，
 * 「直连还是经中继」这个用户能看见的结论永远显示不出来。
 */
import { describe, expect, it } from "vitest";

import {
  readCandidateSummary,
  resolveSelectedCandidatePair,
  resolveTunnelLinkTransportKind,
  toStatsArray
} from "./link-info";

const CANDIDATE_PAIR = {
  id: "CP1",
  type: "candidate-pair",
  state: "succeeded",
  nominated: true,
  localCandidateId: "L1",
  remoteCandidateId: "R1"
};

const LOCAL_RELAY_CANDIDATE = {
  id: "L1",
  type: "local-candidate",
  candidateType: "relay",
  protocol: "udp",
  address: "42.193.118.236"
};

const REMOTE_CANDIDATE = {
  id: "R1",
  type: "remote-candidate",
  candidateType: "host",
  protocol: "udp",
  address: "10.0.0.8"
};

/** 造一个和浏览器 `RTCStatsReport` 一样的最小 maplike 对象。 */
function createMapLikeReport(entries: Array<[string, unknown]>): unknown {
  const store = new Map(entries);

  return {
    get size() {
      return store.size;
    },
    entries: () => store.entries(),
    values: () => store.values(),
    keys: () => store.keys(),
    forEach: (callback: (value: unknown, key: string) => void) => {
      store.forEach((value, key) => callback(value, key));
    },
    get: (key: string) => store.get(key)
  };
}

describe("toStatsArray", () => {
  it("认浏览器 RTCStatsReport（maplike，既不是 Map 也不是数组）", () => {
    const report = createMapLikeReport([
      ["CP1", CANDIDATE_PAIR],
      ["L1", LOCAL_RELAY_CANDIDATE]
    ]);

    const entries = toStatsArray(report);

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.id).sort()).toEqual(["CP1", "L1"]);
  });

  it("认 werift 给的 Map", () => {
    const entries = toStatsArray(new Map([
      ["CP1", CANDIDATE_PAIR],
      ["L1", LOCAL_RELAY_CANDIDATE]
    ]));

    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe("CP1");
  });

  it("认测试假实现给的数组，并按序号补 id", () => {
    const entries = toStatsArray([
      { type: "transport" },
      { id: "CP1", type: "candidate-pair" }
    ]);

    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe("0");
    expect(entries[1].id).toBe("CP1");
  });

  it("遇到认不出的输入返回空数组，不抛错", () => {
    expect(toStatsArray(null)).toEqual([]);
    expect(toStatsArray(undefined)).toEqual([]);
    expect(toStatsArray("nonsense")).toEqual([]);
    expect(toStatsArray(42)).toEqual([]);
  });

  it("统计对象自己带 id 时以它为准，不被 map key 覆盖", () => {
    const report = createMapLikeReport([["map-key", { id: "self-id", type: "candidate-pair" }]]);

    expect(toStatsArray(report)[0].id).toBe("self-id");
  });
});

describe("浏览器形态的 stats 能解析出链路类型", () => {
  it("maplike 报告里经中继的候选对判定为 relay", () => {
    const report = createMapLikeReport([
      ["CP1", CANDIDATE_PAIR],
      ["L1", LOCAL_RELAY_CANDIDATE],
      ["R1", REMOTE_CANDIDATE]
    ]);
    const stats = toStatsArray(report);

    const pair = resolveSelectedCandidatePair(stats);
    expect(pair).toEqual({ localCandidateId: "L1", remoteCandidateId: "R1" });

    const local = readCandidateSummary(stats, pair?.localCandidateId ?? null);
    const remote = readCandidateSummary(stats, pair?.remoteCandidateId ?? null);

    expect(resolveTunnelLinkTransportKind(local?.type, remote?.type)).toBe("relay");
  });

  it("两边都是 host 候选时判定为 p2p", () => {
    const report = createMapLikeReport([
      ["CP1", CANDIDATE_PAIR],
      ["L1", { ...LOCAL_RELAY_CANDIDATE, candidateType: "host" }],
      ["R1", REMOTE_CANDIDATE]
    ]);
    const stats = toStatsArray(report);

    const pair = resolveSelectedCandidatePair(stats);
    const local = readCandidateSummary(stats, pair?.localCandidateId ?? null);
    const remote = readCandidateSummary(stats, pair?.remoteCandidateId ?? null);

    expect(resolveTunnelLinkTransportKind(local?.type, remote?.type)).toBe("p2p");
  });
});
