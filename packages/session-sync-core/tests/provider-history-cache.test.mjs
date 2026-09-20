import test from "node:test";
import assert from "node:assert/strict";

import {
  ProviderCacheBudget,
  WeightedLruCache,
  estimateProviderCacheBytes
} from "../dist/providers/provider-history-cache.js";

test("加权 LRU 按命中和条目数淘汰", () => {
  const cache = new WeightedLruCache({ maxEntries: 2, maxBytes: 1024, maxEntryBytes: 1024 });
  cache.set("a", "甲");
  cache.set("b", "乙");
  assert.equal(cache.get("a"), "甲");
  cache.set("c", "丙");
  assert.equal(cache.has("b"), false);
  assert.equal(cache.stats().evictions, 1);
  assert.equal(cache.stats().hits, 1);
});

test("真实 UTF-8 字节预算和超大条目旁路", () => {
  assert.equal(estimateProviderCacheBytes("中文"), 6);
  const cache = new WeightedLruCache({ maxEntries: 3, maxBytes: 10, maxEntryBytes: 5 });
  cache.set("large", "中文");
  assert.equal(cache.has("large"), false);
  assert.equal(cache.stats().rejections, 1);
});

test("多个 provider 共用总预算并可观测维度", () => {
  const budget = new ProviderCacheBudget(8);
  const first = new WeightedLruCache({ maxEntries: 4, maxBytes: 8, maxEntryBytes: 8, budget, dimensions: () => ({ provider: "one" }) });
  const second = new WeightedLruCache({ maxEntries: 4, maxBytes: 8, maxEntryBytes: 8, budget, dimensions: () => ({ provider: "two" }) });
  first.set("a", "12345678");
  second.set("b", "5678");
  assert.equal(budget.bytes, 4);
  assert.equal(first.has("a"), false);
  assert.equal(first.stats().evictions, 1);
  assert.equal(second.stats().byProvider.two.entries, 1);
});

test("失败值不进入缓存，并发式重复写保持最后值", async () => {
  const cache = new WeightedLruCache({ maxEntries: 3, maxBytes: 1024, maxEntryBytes: 1024 });
  cache.set("bad", { value: BigInt(1) });
  assert.equal(cache.has("bad"), false);
  await Promise.all(Array.from({ length: 20 }, (_, index) => Promise.resolve().then(() => cache.set("same", index))));
  assert.equal(cache.get("same"), 19);
  assert.equal(cache.size, 1);
});

test("高水位主动淘汰冷数据", () => {
  const cache = new WeightedLruCache({ maxEntries: 10, maxBytes: 20, maxEntryBytes: 20, highWatermarkBytes: 9 });
  cache.set("a", "12345");
  cache.set("b", "67890");
  assert.equal(cache.bytes <= 10, true);
  assert.equal(cache.stats().evictions >= 1, true);
});
