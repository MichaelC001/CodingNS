import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const NODE_PTY_PACKAGE = "@lydell/node-pty";

export type NodePtyModule = typeof import("@lydell/node-pty");
export type { IPty } from "@lydell/node-pty";

let cachedNodePtyModule: NodePtyModule | null = null;
let cachedNodePtyPackageName: string | null = null;
let cachedNodePtyPackageRoot: string | null = null;

export function loadNodePty(): NodePtyModule {
  if (cachedNodePtyModule) {
    return cachedNodePtyModule;
  }

  const defaultPackage = tryLoadNodePtyPackage(NODE_PTY_PACKAGE);

  if (defaultPackage) {
    cacheLoadedNodePty(defaultPackage);
    return defaultPackage.module;
  }

  throw new Error(`未找到可用的 PTY 运行时依赖：${NODE_PTY_PACKAGE}`);
}

export function resolveLoadedNodePtyPackageRoot(): string | null {
  loadNodePty();
  return cachedNodePtyPackageRoot;
}

export function resolveLoadedNodePtyPackageName(): string {
  loadNodePty();
  return cachedNodePtyPackageName ?? NODE_PTY_PACKAGE;
}

function tryLoadNodePtyPackage(
  packageName: string
): { module: NodePtyModule; packageName: string; packageRoot: string } | null {
  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`);
    const module = require(packageName) as NodePtyModule;
    return {
      module,
      packageName,
      packageRoot: path.dirname(packageJsonPath)
    };
  } catch {
    return null;
  }
}

function cacheLoadedNodePty(input: {
  module: NodePtyModule;
  packageName: string;
  packageRoot: string;
}): void {
  cachedNodePtyModule = input.module;
  cachedNodePtyPackageName = input.packageName;
  cachedNodePtyPackageRoot = input.packageRoot;
}
