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
  assert.equal(rewritten.dependencies["@codingns/relay-tunnel-wire"], "0.1.0");
  assert.equal(rewritten.dependencies.werift, "^0.24.4");
  assert.deepEqual(rewritten.bundleDependencies, [
    "@codingns/session-sync-core",
    "@codingns/relay-tunnel-wire"
  ]);
  assert.deepEqual(rewritten.optionalDependencies, {
    "@lydell/node-pty": "^1.1.0",
    libsql: "^0.5.29"
  });
  assert.equal(rewritten.codingnsRuntimeDependencies, undefined);
  assert.equal(rewritten.codingnsWindowsRuntimePackages, undefined);
});

test("发布包的 files 必须列出两个打进目录，否则 npm 不会把它们收进 tarball", () => {
  // 这条守的是一个已经踩过的坑：spec001.9 加了 @codingns/relay-tunnel-wire，
  // 它在 create-server.ts 里是启动时静态 import——漏了这个包，装完 Host 直接
  // ERR_MODULE_NOT_FOUND 起不来。
  //
  // 只改 bundleDependencies 不够：bundleDependencies 决定「不打 registry、用包进去的实体」，
  // files 决定「哪些路径会进 tarball」，两处都要有。
  // 发布自检脚本（verify-publish-tarball.mjs）也能拦，但那要到发布时才跑；
  // 这里放一条单测，让问题在 pnpm test 阶段就暴露。
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(workspaceRoot, "codingns", "package.json"), "utf8")
  );

  const bundledPaths = [
    "node_modules/@codingns/session-sync-core",
    "node_modules/@codingns/relay-tunnel-wire"
  ];

  for (const bundledPath of bundledPaths) {
    assert.ok(
      Array.isArray(packageJson.files) && packageJson.files.includes(bundledPath),
      `package.json 的 files 里缺少 ${bundledPath}`
    );
    assert.ok(
      packageJson.dependencies?.[bundledPath.replace("node_modules/", "")]?.startsWith("workspace:"),
      `dependencies 里缺少 ${bundledPath.replace("node_modules/", "")} 的 workspace 声明`
    );
  }
});

test("发布暂存目录必须复制两个 workspace 运行时依赖", () => {
  const source = fs.readFileSync(
    path.join(workspaceRoot, "codingns", "scripts", "create-publish-staging.mjs"),
    "utf8"
  );

  assert.match(source, /copyBundledSessionSyncCore\(\);/);
  assert.match(source, /copyBundledRelayTunnelWire\(\);/);
  assert.match(source, /path\.join\(workspaceRoot, "packages", "relay-tunnel-wire"\)/);
  assert.match(source, /path\.join\(stagingRoot,[\s\S]*?"relay-tunnel-wire"/);
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

test("Windows 安装回放使用 npm tarball 并避开 Bash 4 专属语法", () => {
  const repositoryRoot = path.resolve(workspaceRoot, "..");
  const prepareSource = fs.readFileSync(
    path.join(repositoryRoot, "scripts", "prepare-windows-install-replay.sh"),
    "utf8"
  );
  const runSource = fs.readFileSync(
    path.join(repositoryRoot, "scripts", "run-windows-install-replay.sh"),
    "utf8"
  );
  const installSource = fs.readFileSync(path.join(repositoryRoot, "install.sh"), "utf8");
  const workflowSource = fs.readFileSync(
    path.join(repositoryRoot, ".github", "workflows", "windows-install-replay.yml"),
    "utf8"
  );

  assert.match(prepareSource, /npm pack/);
  assert.match(prepareSource, /codingns-package\.tgz/);
  assert.doesNotMatch(prepareSource, /mapfile/);
  assert.match(runSource, /CODINGNS_PACKAGE_SPEC="\$PACKAGE_SPEC"/);
  assert.match(workflowSource, /codingns-package\.tgz/);
  assert.match(
    workflowSource,
    /codingns-replay-data\/runtime\/logs/,
    "失败产物必须包含服务日志，不能只上传安装日志"
  );
  assert.match(
    installSource,
    /if ! run_host_installer_setup; then[\s\S]*?fi\s+#[^\n]*托管方式确定后再写[\s\S]*?write_private_runtime_state/,
    "PM2 回退完成后才能写运行状态"
  );
});

test("Android 发布 workflow 不再请求已废弃的 tools SDK 包", () => {
  const repositoryRoot = path.resolve(workspaceRoot, "..");
  const workflowSource = fs.readFileSync(
    path.join(repositoryRoot, ".github", "workflows", "desktop-release.yml"),
    "utf8"
  );

  assert.match(workflowSource, /uses: android-actions\/setup-android@v3[\s\S]*packages: "platform-tools"/);
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
