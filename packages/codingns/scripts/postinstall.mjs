import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveCodexVendorBinaryPath } from "./codex-runtime-layout.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const moduleRequire = createRequire(import.meta.url);
const packageJsonPath = path.join(packageRoot, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const cliVersionRange = packageJson.dependencies?.["@openai/codex"];
const sdkVersionRange = packageJson.dependencies?.["@openai/codex-sdk"];
const sessionSyncCoreRange = packageJson.dependencies?.["@codingns/session-sync-core"];

if (!sdkVersionRange) {
  logInfo("[codingns] 未声明 @openai/codex-sdk，跳过 Codex 安装校验");
  process.exit(0);
}

if (isWorkspaceSourceInstall()) {
  logInfo("[codingns] 检测到工作区源码安装，跳过发布包运行时修复");
  process.exit(0);
}

if (process.env.CODINGNS_SKIP_CODEX_POSTINSTALL === "1") {
  logInfo("[codingns] 已跳过 Codex 安装校验");
  process.exit(0);
}

logInfo(`[codingns] 正在校验运行时依赖（${process.platform}/${process.arch}）...`);

if (!verifyNativeRuntimeDependency("@lydell/node-pty")) {
  process.exit(1);
}

if (!verifyNativeRuntimeDependency("libsql")) {
  process.exit(1);
}

if (await verifyCodexRuntime()) {
  logInfo("[codingns] Codex 运行时依赖已就绪");
  process.exit(0);
}

if (process.env.CODINGNS_SKIP_POSTINSTALL_REENTRY === "1") {
  console.error("[codingns] Codex 运行时依赖校验失败，且已处于修复重入阶段");
  process.exit(1);
}

logInfo("[codingns] 正在修复 Codex SDK 与当前平台二进制，请稍候...");
cleanupBrokenCodexPackages();

const repairResult = repairCodexRuntime();

if (repairResult.status !== 0) {
  process.exit(repairResult.status ?? 1);
}

if (!(await verifyCodexRuntime())) {
  console.error("[codingns] Codex 运行时依赖修复后仍然不可用");
  process.exit(1);
}

logInfo("[codingns] Codex 运行时依赖修复完成");

function verifyNativeRuntimeDependency(packageName) {
  try {
    const packageJsonPath = resolveModuleExportFile(packageName, "package.json");
    if (!packageJsonPath) {
      console.error(`[codingns] 未找到运行时依赖：${packageName}`);
      return false;
    }
    moduleRequire(packageName);
    const version = readPackageVersion(packageJsonPath);
    logInfo(`[codingns] 运行时依赖已就绪：${packageName}${version ? `@${version}` : ""}`);
    return true;
  } catch (error) {
    console.error(`[codingns] 运行时依赖不可加载：${packageName}：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function verifyCodexRuntime() {
  try {
    const sdkEntryPath =
      resolveModuleExportFile("@openai/codex-sdk", "dist/index.js") ??
      findNodeModulesFile(packageRoot, ["@openai", "codex-sdk", "dist", "index.js"]);

    if (!sdkEntryPath) {
      console.error(`[codingns] 未找到 Codex SDK 入口：${sdkEntryPath}`);
      return false;
    }

    const sdkModule = await import(pathToFileURL(sdkEntryPath).href);

    if (typeof sdkModule.Codex !== "function") {
      console.error("[codingns] @openai/codex-sdk 已安装，但未导出 Codex 客户端");
      return false;
    }

    const codexBinPath = resolveCodexCliPath(sdkEntryPath);

    if (!codexBinPath) {
      console.error("[codingns] 未找到 Codex CLI 入口");
      return false;
    }

    const nativeCodexBinaryPath = resolveCodexNativeBinaryPath(codexBinPath);

    if (!nativeCodexBinaryPath) {
      console.error("[codingns] 未找到 Codex CLI 平台二进制");
      return false;
    }

    if (!isExecutableFile(nativeCodexBinaryPath)) {
      console.error(`[codingns] Codex CLI 平台二进制不可执行：${nativeCodexBinaryPath}`);
      return false;
    }

    logInfo(`[codingns] Codex CLI 入口已就绪：${codexBinPath}`);
    logInfo(`[codingns] Codex CLI 平台运行文件已就绪：${nativeCodexBinaryPath}`);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[codingns] Codex 运行时校验失败：${detail}`);
    return false;
  }
}



function repairCodexRuntime() {
  const installRoot = fs.mkdtempSync(path.join(packageRoot, ".codingns-codex-repair-"));

  try {
    const result = runNpmInstall([
      "install",
      "--no-save",
      "--omit=optional",
      "--package-lock=false",
      ...resolveCodexRepairInstallSpecs()
    ], {
      prefix: installRoot,
      cwd: installRoot
    });

    if (result.status !== 0) {
      return result;
    }

    copyRepairedCodexPackages(installRoot);
    return result;
  } finally {
    fs.rmSync(installRoot, { recursive: true, force: true });
  }
}

function copyRepairedCodexPackages(installRoot) {
  const sourceOpenAiRoot = path.join(installRoot, "node_modules", "@openai");
  const targetNodeModulesRoot = path.join(packageRoot, "node_modules");
  const targetOpenAiRoot = path.join(targetNodeModulesRoot, "@openai");
  const targetBinRoot = path.join(targetNodeModulesRoot, ".bin");

  if (!fs.existsSync(sourceOpenAiRoot)) {
    throw new Error(`[codingns] Codex 修复结果缺少 @openai 包目录：${sourceOpenAiRoot}`);
  }

  fs.rmSync(targetOpenAiRoot, { recursive: true, force: true });
  fs.mkdirSync(targetNodeModulesRoot, { recursive: true });
  fs.cpSync(sourceOpenAiRoot, targetOpenAiRoot, { recursive: true });

  copyRepairedCodexBin(installRoot, targetBinRoot);
  logInfo(`[codingns] Codex 运行时依赖已复制到：${targetOpenAiRoot}`);
}

function copyRepairedCodexBin(installRoot, targetBinRoot) {
  const sourceBinRoot = path.join(installRoot, "node_modules", ".bin");

  fs.mkdirSync(targetBinRoot, { recursive: true });
  for (const fileName of ["codex", "codex.cmd", "codex.ps1"]) {
    const sourcePath = path.join(sourceBinRoot, fileName);
    const targetPath = path.join(targetBinRoot, fileName);

    fs.rmSync(targetPath, { force: true });
    if (fs.existsSync(sourcePath)) {
      fs.cpSync(sourcePath, targetPath);
    }
  }
}

function resolveCodexRepairInstallSpecs() {
  const specs = [
    cliVersionRange ? `@openai/codex@${cliVersionRange}` : null,
    `@openai/codex-sdk@${sdkVersionRange}`,
    resolveCodexPlatformInstallSpec()
  ];

  return specs.filter(Boolean);
}

function resolveCodexPlatformInstallSpec() {
  const platformPackage = resolveCodexPlatformPackageName();
  const platformVersion = resolveCodexPlatformPackageVersion();

  if (!platformPackage || !platformVersion) {
    return null;
  }

  return `${platformPackage}@npm:@openai/codex@${platformVersion}`;
}

function resolveCodexPlatformPackageVersion() {
  if (typeof cliVersionRange !== "string") {
    return null;
  }

  const exactVersionMatch = cliVersionRange.match(/^(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?)$/u);
  if (!exactVersionMatch) {
    return null;
  }

  return `${exactVersionMatch[1]}-${process.platform}-${process.arch}`;
}

function cleanupBrokenCodexPackages() {
  const openAiRoot = path.join(packageRoot, "node_modules", "@openai");
  const binRoot = path.join(packageRoot, "node_modules", ".bin");

  fs.rmSync(openAiRoot, { recursive: true, force: true });
  fs.rmSync(path.join(binRoot, "codex"), { force: true });
  fs.rmSync(path.join(binRoot, "codex.cmd"), { force: true });
  fs.rmSync(path.join(binRoot, "codex.ps1"), { force: true });
}

function runNpmInstall(args, options = {}) {
  const env = {
    ...process.env,
    CODINGNS_SKIP_POSTINSTALL_REENTRY: "1",
    npm_config_global: "false",
    npm_config_location: "project"
  };
  delete env.npm_config_prefix;
  delete env.npm_command;

  const installPrefix = options.prefix ?? packageRoot;
  const installCwd = options.cwd ?? packageRoot;
  const installArgs = [
    ...args,
    "--global=false",
    "--prefix",
    installPrefix,
    "--install-strategy=nested"
  ];
  const registries = resolveNpmRegistryCandidates();
  let lastResult = null;

  for (const registry of registries) {
    const registryArgs = [...installArgs, "--registry", registry];
    const command = resolveNpmInvocation(registryArgs);
    logInfo(
      `[codingns] 执行运行时修复命令（registry: ${registry}）：${command.file} ${command.args.map(formatCommandArg).join(" ")}`
    );

    const result = spawnSync(command.file, command.args, {
      cwd: installCwd,
      env,
      stdio: "inherit"
    });

    if (result.error) {
      const detail = result.error instanceof Error ? result.error.message : String(result.error);
      console.error(`[codingns] 运行时修复命令启动失败：${detail}`);
    }

    if (typeof result.status === "number") {
      logInfo(`[codingns] 运行时修复命令退出码：${result.status}`);
    } else if (result.signal) {
      console.error(`[codingns] 运行时修复命令被信号中断：${result.signal}`);
    }

    if (result.status === 0) {
      return result;
    }

    lastResult = result;
  }

  return lastResult ?? {
    status: 1,
    signal: null,
    error: new Error("[codingns] 未解析到可用的 npm registry")
  };
}

function resolveNpmInvocation(args) {
  const npmExecPath = process.env.npm_execpath;

  if (npmExecPath && fs.existsSync(npmExecPath)) {
    return {
      file: process.execPath,
      args: [npmExecPath, ...args]
    };
  }

  if (process.platform !== "win32") {
    return {
      file: "npm",
      args
    };
  }

  return {
    file: "cmd.exe",
    args: ["/d", "/s", "/c", quoteWindowsCommand("npm", args)]
  };
}

function quoteWindowsCommand(command, args) {
  return [command, ...args].map(quoteWindowsArg).join(" ");
}

function quoteWindowsArg(value) {
  if (!value.length) {
    return '""';
  }

  if (!/[\s"]/u.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '\\"')}"`;
}

function formatCommandArg(value) {
  return /[\s"]/u.test(value) ? JSON.stringify(value) : value;
}

function resolveNpmRegistryCandidates() {
  return uniqueNonEmptyValues([
    ...splitEnvList(process.env.CODINGNS_NPM_REGISTRIES),
    process.env.CODINGNS_NPM_REGISTRY,
    process.env.npm_config_registry,
    "https://registry.npmjs.org/",
    "https://registry.npmmirror.com/",
    "https://mirrors.cloud.tencent.com/npm/",
    "https://repo.huaweicloud.com/repository/npm/"
  ]);
}

function splitEnvList(value) {
  return String(value || "")
    .split(/[,\n;]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueNonEmptyValues(values) {
  const result = [];

  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || result.includes(normalized)) {
      continue;
    }
    result.push(normalized);
  }

  return result;
}

function logInfo(message) {
  console.error(message);
}

function isWorkspaceSourceInstall() {
  return (
    typeof sessionSyncCoreRange === "string" && sessionSyncCoreRange.startsWith("workspace:")
  );
}

function resolveCodexCliPath(sdkEntryPath) {
  const sdkPackageRoot = path.dirname(path.dirname(sdkEntryPath));
  const moduleRoots = uniquePaths([
    packageRoot,
    path.dirname(packageRoot),
    sdkPackageRoot,
    path.dirname(sdkPackageRoot)
  ]);

  const candidates = process.platform === "win32"
    ? moduleRoots.flatMap((root) => [
      path.join(root, "node_modules", ".bin", "codex.cmd"),
      path.join(root, "node_modules", ".bin", "codex.exe"),
      path.join(root, "node_modules", ".bin", "codex"),
      path.join(root, "node_modules", "@openai", "codex", "bin", "codex.js"),
      path.join(root, "node_modules", "@openai", "codex-sdk", "node_modules", ".bin", "codex.cmd"),
      path.join(root, "node_modules", "@openai", "codex-sdk", "node_modules", ".bin", "codex.exe"),
      path.join(root, "node_modules", "@openai", "codex-sdk", "node_modules", ".bin", "codex"),
      path.join(root, "node_modules", "@openai", "codex-sdk", "node_modules", "@openai", "codex", "bin", "codex.js")
    ])
    : moduleRoots.flatMap((root) => [
      path.join(root, "node_modules", ".bin", "codex"),
      path.join(root, "node_modules", "@openai", "codex", "bin", "codex.js"),
      path.join(root, "node_modules", "@openai", "codex-sdk", "node_modules", ".bin", "codex"),
      path.join(root, "node_modules", "@openai", "codex-sdk", "node_modules", "@openai", "codex", "bin", "codex.js")
    ]);

  const resolvedCodexScript = resolveModuleFile("@openai/codex/bin/codex.js");

  if (resolvedCodexScript) {
    candidates.unshift(resolvedCodexScript);
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveCodexNativeBinaryPath(codexBinPath) {
  const platformPackage = resolveCodexPlatformPackageName();

  if (!platformPackage) {
    return null;
  }

  const targetTriple = resolveCodexTargetTriple();
  const codexBinaryName = process.platform === "win32" ? "codex.exe" : "codex";
  const codexPackageRoot = findPackageRoot(codexBinPath);
  const localBinaryPath = codexPackageRoot && targetTriple
    ? resolveCodexVendorBinaryPath({
      vendorRoot: path.join(codexPackageRoot, "vendor"),
      targetTriple,
      binaryName: codexBinaryName
    })
    : null;

  if (localBinaryPath) {
    return localBinaryPath;
  }

  const platformPackageJsonPath =
    resolveModuleExportFile(platformPackage, "package.json") ??
    (codexPackageRoot
      ? findNodeModulesFile(codexPackageRoot, [...platformPackage.split("/"), "package.json"])
      : null);

  if (!platformPackageJsonPath) {
    return null;
  }

  return targetTriple
    ? resolveCodexVendorBinaryPath({
      vendorRoot: path.join(path.dirname(platformPackageJsonPath), "vendor"),
      targetTriple,
      binaryName: codexBinaryName
    })
    : null;
}

function resolveCodexPlatformPackageName() {
  switch (`${process.platform}/${process.arch}`) {
    case "linux/x64":
      return "@openai/codex-linux-x64";
    case "linux/arm64":
      return "@openai/codex-linux-arm64";
    case "darwin/x64":
      return "@openai/codex-darwin-x64";
    case "darwin/arm64":
      return "@openai/codex-darwin-arm64";
    case "win32/x64":
      return "@openai/codex-win32-x64";
    case "win32/arm64":
      return "@openai/codex-win32-arm64";
    default:
      return null;
  }
}

function isExecutableFile(filePath) {
  try {
    fs.accessSync(filePath, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readPackageVersion(packageJsonPath) {
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    return typeof packageJson?.version === "string" ? packageJson.version : "";
  } catch {
    return "";
  }
}

function resolveCodexTargetTriple() {
  switch (`${process.platform}/${process.arch}`) {
    case "linux/x64":
      return "x86_64-unknown-linux-musl";
    case "linux/arm64":
      return "aarch64-unknown-linux-musl";
    case "darwin/x64":
      return "x86_64-apple-darwin";
    case "darwin/arm64":
      return "aarch64-apple-darwin";
    case "win32/x64":
      return "x86_64-pc-windows-msvc";
    case "win32/arm64":
      return "aarch64-pc-windows-msvc";
    default:
      return null;
  }
}

function findPackageRoot(startPath) {
  let currentDirectory = fs.statSync(startPath).isDirectory()
    ? startPath
    : path.dirname(startPath);

  while (true) {
    const packageJsonCandidate = path.join(currentDirectory, "package.json");

    if (fs.existsSync(packageJsonCandidate)) {
      return currentDirectory;
    }

    const parentDirectory = path.dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      return null;
    }

    currentDirectory = parentDirectory;
  }
}

function resolveModuleFile(specifier) {
  try {
    return moduleRequire.resolve(specifier);
  } catch {
    return null;
  }
}

function resolveModuleExportFile(specifier, fallbackRelativePath) {
  const resolvedEntry = resolveModuleFile(specifier);

  if (resolvedEntry) {
    return resolvedEntry;
  }

  try {
    const packageJsonPath = moduleRequire.resolve(`${specifier}/package.json`);
    return fallbackRelativePath
      ? path.join(path.dirname(packageJsonPath), fallbackRelativePath)
      : packageJsonPath;
  } catch (error) {
    if (!isPackagePathNotExportedError(error)) {
      return null;
    }
  }

  const manualPackagePath = findNodeModulesFile(
    packageRoot,
    [...specifier.split("/"), "package.json"]
  );

  if (!manualPackagePath) {
    return null;
  }

  return fallbackRelativePath
    ? path.join(path.dirname(manualPackagePath), fallbackRelativePath)
    : manualPackagePath;
}

function isPackagePathNotExportedError(error) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
  );
}

function findNodeModulesFile(startDirectory, relativeSegments) {
  let currentDirectory = startDirectory;

  while (true) {
    const candidate = resolveNodeModulesCandidate(currentDirectory, relativeSegments);

    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parentDirectory = path.dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      return null;
    }

    currentDirectory = parentDirectory;
  }
}

function resolveNodeModulesCandidate(currentDirectory, relativeSegments) {
  if (path.basename(currentDirectory) === "node_modules") {
    return path.join(currentDirectory, ...relativeSegments);
  }

  return path.join(currentDirectory, "node_modules", ...relativeSegments);
}

function uniquePaths(values) {
  return Array.from(new Set(values.map((value) => path.resolve(value))));
}
