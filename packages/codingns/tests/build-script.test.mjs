import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolvePnpmInvocation } from "../scripts/build.mjs";
import {
  collectWorkspacePackageVersions,
  rewritePackageJsonForPublish,
  stripPackLifecycleScripts
} from "../scripts/publish-package-utils.mjs";
import { resolveCodexVendorBinaryPath } from "../scripts/codex-runtime-layout.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("resolvePnpmInvocation 遇到 npm_execpath 指向 npm 时会回退到 pnpm 命令", () => {
  const command = resolvePnpmInvocation(["--dir", "/tmp/project", "build"], {
    env: {
      npm_execpath: "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js"
    },
    platform: "darwin",
    execPath: "/opt/homebrew/bin/node",
    fileExists: () => true
  });

  assert.deepEqual(command, {
    file: "pnpm",
    args: ["--dir", "/tmp/project", "build"]
  });
});

test("resolvePnpmInvocation 遇到 pnpm 的 npm_execpath 时会复用当前入口", () => {
  const command = resolvePnpmInvocation(["--dir", "/tmp/project", "build"], {
    env: {
      npm_execpath: "/opt/homebrew/lib/node_modules/pnpm/bin/pnpm.cjs"
    },
    platform: "darwin",
    execPath: "/opt/homebrew/bin/node",
    fileExists: () => true
  });

  assert.deepEqual(command, {
    file: "/opt/homebrew/bin/node",
    args: [
      "/opt/homebrew/lib/node_modules/pnpm/bin/pnpm.cjs",
      "--dir",
      "/tmp/project",
      "build"
    ]
  });
});

test("rewritePackageJsonForPublish 会改写 workspace 依赖并补齐 bundle 设置", () => {
  const originalPackageJson = JSON.parse(
    fs.readFileSync(path.join(workspaceRoot, "codingns", "package.json"), "utf8")
  );
  const rewritten = rewritePackageJsonForPublish(
    originalPackageJson,
    collectWorkspacePackageVersions(path.resolve(workspaceRoot, ".."))
  );

  assert.equal(rewritten.dependencies["@codingns/session-sync-core"], "0.1.0");
  assert.deepEqual(rewritten.bundleDependencies, ["@codingns/session-sync-core"]);
  assert.deepEqual(rewritten.optionalDependencies, {
    "@lydell/node-pty": "^1.1.0",
    libsql: "^0.5.29"
  });
  assert.equal(rewritten.codingnsRuntimeDependencies, undefined);
  assert.equal(rewritten.codingnsWindowsRuntimePackages, undefined);
});

test("stripPackLifecycleScripts 会移除 prepack 和 postpack，避免 staging 再跑一遍打包脚本", () => {
  const packageJson = {
    scripts: {
      prepack: "node prepack.mjs",
      postpack: "node postpack.mjs",
      postinstall: "node postinstall.mjs"
    }
  };

  stripPackLifecycleScripts(packageJson);

  assert.deepEqual(packageJson, {
    scripts: {
      postinstall: "node postinstall.mjs"
    }
  });
});

test("postinstall 的 npm 修复链路包含多个 registry 回退", () => {
  const source = fs.readFileSync(
    path.join(workspaceRoot, "codingns", "scripts", "postinstall.mjs"),
    "utf8"
  );

  assert.match(source, /https:\/\/registry\.npmjs\.org\//);
  assert.match(source, /https:\/\/registry\.npmmirror\.com\//);
  assert.match(source, /https:\/\/mirrors\.cloud\.tencent\.com\/npm\//);
  assert.match(source, /https:\/\/repo\.huaweicloud\.com\/repository\/npm\//);
});

test("postinstall 只校验当前预编译依赖", () => {
  const source = fs.readFileSync(
    path.join(workspaceRoot, "codingns", "scripts", "postinstall.mjs"),
    "utf8"
  );
  assert.match(source, /@lydell\/node-pty/);
  assert.match(source, /libsql/);
});

test("Codex 平台包优先使用 codex-package.json 声明的新版入口", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codingns-codex-layout-"));
  const targetTriple = "aarch64-apple-darwin";
  const targetRoot = path.join(root, targetTriple);
  const binaryPath = path.join(targetRoot, "bin", "codex");

  try {
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, "codex", "utf8");
    fs.writeFileSync(
      path.join(targetRoot, "codex-package.json"),
      JSON.stringify({ entrypoint: "bin/codex" }),
      "utf8"
    );

    assert.equal(
      resolveCodexVendorBinaryPath({
        vendorRoot: root,
        targetTriple,
        binaryName: "codex"
      }),
      binaryPath
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex 平台包仍兼容旧版 codex/codex 目录", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codingns-codex-layout-legacy-"));
  const targetTriple = "x86_64-unknown-linux-musl";
  const binaryPath = path.join(root, targetTriple, "codex", "codex");

  try {
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, "codex", "utf8");

    assert.equal(
      resolveCodexVendorBinaryPath({
        vendorRoot: root,
        targetTriple,
        binaryName: "codex"
      }),
      binaryPath
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex 平台包拒绝清单入口逃出目标目录", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codingns-codex-layout-safe-"));
  const targetTriple = "aarch64-apple-darwin";
  const targetRoot = path.join(root, targetTriple);
  const escapedBinaryPath = path.join(root, "outside-codex");

  try {
    fs.mkdirSync(targetRoot, { recursive: true });
    fs.writeFileSync(escapedBinaryPath, "codex", "utf8");
    fs.writeFileSync(
      path.join(targetRoot, "codex-package.json"),
      JSON.stringify({ entrypoint: "../outside-codex" }),
      "utf8"
    );

    assert.equal(
      resolveCodexVendorBinaryPath({
        vendorRoot: root,
        targetTriple,
        binaryName: "codex"
      }),
      null
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
