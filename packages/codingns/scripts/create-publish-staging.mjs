import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectWorkspacePackageVersions,
  readJson,
  rewritePackageJsonForPublish,
  stripPackLifecycleScripts,
  writeJson
} from "./publish-package-utils.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const workspaceRoot = path.resolve(packageRoot, "..", "..");
const stagingRoot = process.argv[2];

if (!stagingRoot) {
  throw new Error("缺少发布暂存目录参数");
}

const packageJsonPath = path.join(packageRoot, "package.json");
const stagingPackageJsonPath = path.join(stagingRoot, "package.json");

fs.rmSync(stagingRoot, { recursive: true, force: true });
fs.mkdirSync(stagingRoot, { recursive: true });
fs.cpSync(packageRoot, stagingRoot, {
  recursive: true,
  filter: (sourcePath) => {
    const relativePath = path.relative(packageRoot, sourcePath);
    const baseName = path.basename(sourcePath);
    const firstPathSegment = relativePath.split(path.sep)[0];

    // pnpm 的 node_modules 含有大量指向工作区外部的符号链接，不能原样带入发布暂存区。
    return (
      baseName !== ".DS_Store" &&
      !baseName.endsWith(".tgz") &&
      firstPathSegment !== "node_modules"
    );
  }
});

copyBundledSessionSyncCore();

const packageJson = rewritePackageJsonForPublish(
  readJson(packageJsonPath),
  collectWorkspacePackageVersions(workspaceRoot)
);
stripPackLifecycleScripts(packageJson);
writeJson(stagingPackageJsonPath, packageJson);

console.info(`[codingns] 已生成发布暂存目录：${stagingRoot}`);

function copyBundledSessionSyncCore() {
  const sourceRoot = path.join(workspaceRoot, "packages", "session-sync-core");
  const sourceDistRoot = path.join(sourceRoot, "dist");
  const targetRoot = path.join(
    stagingRoot,
    "node_modules",
    "@codingns",
    "session-sync-core"
  );

  if (!fs.existsSync(sourceDistRoot)) {
    throw new Error(`缺少 session-sync-core 构建产物：${sourceDistRoot}`);
  }

  fs.mkdirSync(targetRoot, { recursive: true });
  fs.cpSync(sourceDistRoot, path.join(targetRoot, "dist"), { recursive: true });
  const sourcePackageJson = readJson(path.join(sourceRoot, "package.json"));

  // libsql 由外层 CodingNS 包统一安装；重复放在 bundled 私有包的 dependencies 中，
  // npm 全局安装时会留下空目录，导致 postinstall 无法加载真正的运行时。
  if (sourcePackageJson.dependencies?.libsql) {
    delete sourcePackageJson.dependencies.libsql;
  }

  writeJson(path.join(targetRoot, "package.json"), sourcePackageJson);
}
