#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

OUTPUT_DIR="${1:-${RUNNER_TEMP:-$REPO_DIR/.tmp}/windows-install-replay}"
PACKAGE_STAGE_DIR="$OUTPUT_DIR/codingns-package"

log_info() {
  printf '[windows-replay] %s\n' "$1"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '[windows-replay] 缺少命令：%s\n' "$1" >&2
    exit 1
  fi
}

write_manifest() {
  local output_dir="$1"

  node - "$output_dir" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");

const [outputDir] = process.argv.slice(2);
const manifest = {
  schemaVersion: 1,
  preparedAt: new Date().toISOString(),
  codingnsPackageDir: "codingns-package",
  codingnsPackageTarball: "codingns-package.tgz",
  runtimePackages: ["@lydell/node-pty", "libsql"]
};

fs.writeFileSync(
  path.join(outputDir, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`
);
EOF
}

write_stage_metadata() {
  local stage_dir="$1"

  node - "$stage_dir" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");

const [stageDir] = process.argv.slice(2);
const packageJsonPath = path.join(stageDir, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const metadataPath = path.join(stageDir, ".codingns-install-metadata.json");

const metadata = {
  packageName: typeof packageJson.name === "string" ? packageJson.name : "",
  packageVersion: typeof packageJson.version === "string" ? packageJson.version : ""
};

fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
EOF
}

main() {
  require_command pnpm
  require_command node
  require_command npm
  rm -rf "$OUTPUT_DIR"
  mkdir -p "$OUTPUT_DIR"

  log_info "安装工作区依赖（忽略 lifecycle scripts，避免 Windows 验收前误触原生脚本）"
  pnpm --dir "$REPO_DIR" install --ignore-scripts --frozen-lockfile

  log_info "构建 CodingNS 独立服务包"
  pnpm --dir "$REPO_DIR" run build:standalone
  node "$REPO_DIR/packages/codingns/scripts/create-publish-staging.mjs" "$PACKAGE_STAGE_DIR"

  log_info "把发布暂存目录打成 npm tarball，按真实发布包进行安装回放"
  npm pack "$PACKAGE_STAGE_DIR" \
    --pack-destination "$OUTPUT_DIR" \
    --ignore-scripts \
    --json > "$OUTPUT_DIR/npm-pack.json"

  local package_tarball=""
  local package_tarball_count=""
  package_tarball="$(find "$OUTPUT_DIR" -maxdepth 1 -type f -name '*.tgz' -print -quit)"
  package_tarball_count="$(find "$OUTPUT_DIR" -maxdepth 1 -type f -name '*.tgz' -print | wc -l | tr -d '[:space:]')"
  if [[ "$package_tarball_count" -ne 1 || -z "$package_tarball" ]]; then
    printf '[windows-replay] npm pack 未生成唯一 tarball：%s\n' "$package_tarball_count" >&2
    exit 1
  fi

  mv "$package_tarball" "$OUTPUT_DIR/codingns-package.tgz"

  write_stage_metadata "$PACKAGE_STAGE_DIR"
  write_manifest "$OUTPUT_DIR"

  log_info "Windows 安装回放输入已准备完成：$OUTPUT_DIR"
}

main "$@"
