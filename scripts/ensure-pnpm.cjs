#!/usr/bin/env node

/**
 * 安装前环境检查脚本
 * 目标：
 * 1. 强制使用 pnpm 安装依赖
 * 2. 不限制 Node.js 主版本，原生依赖由 N-API 预编译包提供兼容性
 */

const userAgent = process.env.npm_config_user_agent ?? "";
const execPath = process.env.npm_execpath ?? "";

const isPnpm =
  userAgent.startsWith("pnpm/") ||
  execPath.includes("\\pnpm") ||
  execPath.includes("/pnpm");

if (isPnpm) {
  process.exit(0);
}

console.error("依赖安装必须使用 pnpm，不要运行 npm install。");
console.error("正确命令：corepack pnpm install");
console.error("安装完成后，你仍然可以继续使用 npm run dev:frontend / npm run dev:backend。");
process.exit(1);
