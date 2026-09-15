import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 读取用户 Pi 的模型库（models-store.json）。
 *
 * 只用来查静态元数据：上下文窗口、是否声明支持图片输入。
 * 单独放一个模块，是因为运行时适配器（判断图片能不能发）和会话适配器（算上下文水位）
 * 都要用它，而这两个模块不能互相 import。
 */

export interface PiModelStoreEntry {
  contextWindow: number | null;
  supportsImages: boolean;
}

/** 按 `provider/modelId` 建索引；读不到就返回空表，由调用方决定降级。 */
export function readPiModelStore(agentDir: string): Map<string, PiModelStoreEntry> {
  const catalog = new Map<string, PiModelStoreEntry>();
  const storePath = join(agentDir, "models-store.json");

  if (!existsSync(storePath)) return catalog;

  try {
    const parsed = asRecord(JSON.parse(readFileSync(storePath, "utf8")));

    for (const providerEntry of Object.values(parsed)) {
      const models = asRecord(providerEntry).models;
      if (!Array.isArray(models)) continue;

      for (const model of models) {
        const record = asRecord(model);
        const provider = readText(record.provider);
        const id = readText(record.id);
        if (!id) continue;

        const input = Array.isArray(record.input) ? record.input : [];
        catalog.set(`${provider}/${id}`, {
          contextWindow: readNumber(record.contextWindow),
          supportsImages: input.some((entry) => readText(entry) === "image")
        });
      }
    }
  } catch {
    return catalog;
  }

  return catalog;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
