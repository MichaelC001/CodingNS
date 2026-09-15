# 开发环境设置指南

## 系统要求

本项目需要以下环境：

- **Node.js**: >= 22.19.0（Node 24、Node 26 也受支持）
- **pnpm**: >= 9.0.0 （推荐使用 pnpm 10.7.1）

## 快速开始

### 1. 安装 Node.js 版本管理器（推荐）

#### 选项 A: 使用 nvm (Node Version Manager)

```bash
# 安装 nvm (如果还没有)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# 安装 Node.js 22.19
nvm install 22.19.0

# 使用 Node.js 22.19
nvm use 22.19.0

# 在项目目录中自动切换版本
cd /path/to/CodingNS
nvm use  # 自动读取 .nvmrc 文件
```

#### 选项 B: 使用 fnm (Fast Node Manager) - 更快

```bash
# 安装 fnm (如果还没有)
brew install fnm  # macOS
# 或
curl -fsSL https://fnm.vercel.app/install | bash  # Linux/其他

# 安装 Node.js 22.19
fnm install 22.19.0

# 使用 Node.js 22.19
fnm use 22.19.0

# 在项目目录中自动切换版本
cd /path/to/CodingNS
fnm use  # 自动读取 .nvmrc 文件
```

### 2. 启用 pnpm

```bash
# 启用 Corepack (Node.js 内置的包管理器管理器)
corepack enable

# 验证 pnpm 版本
pnpm --version  # 应该显示 10.7.1 或更高
```

### 3. 安装依赖

```bash
# 安装项目依赖
pnpm install
```

> 注意：安装过程中会自动检查 Node.js 版本，如果版本不对会提示错误。

### 4. 重新编译原生模块（重要！）

⚠️ **如果你刚刚切换了 Node.js 版本**（例如从 v20 升级到 v22），**必须重新编译原生模块**：

```bash
# 重新编译所有原生模块
pnpm rebuild

# 如果以上方法不行，完全重装
rm -rf node_modules pnpm-lock.yaml
pnpm install
```

> **为什么需要这一步？**
>
> 原生模块（如 `libsql`, `@lydell/node-pty`）通过 npm 发布的 N-API 预编译包安装，Node.js 22.19 及更高版本（包括 24、26）可以共用对应平台二进制，不需要在本机重新编译。
>
> **常见错误**：
> ```
> Error: The module 'better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 115.
> This version of Node.js requires NODE_MODULE_VERSION 127.
> ```
> 这表示安装到了不匹配的平台文件。请删除 `node_modules` 后重新执行 `pnpm install`，不要在用户环境中编译 native 模块。
>
> PTY 由 `@lydell/node-pty` 统一提供，不再需要项目脚本修复 `spawn-helper` 权限。

### 5. 运行开发服务器

```bash
# 查看可用的开发命令
pnpm dev

# 或者直接运行后端
pnpm dev:backend

# 运行前端
pnpm dev:frontend
```

## 常见问题

### Q: 为什么需要 Node.js 22.19+？

A: 项目运行时和工具链按 Node.js 22.19+ 维护，并明确验证 Node.js 24 和 26。SQLite 正式运行链路统一使用 `libsql`，不要直接使用 Node 内置的实验性 `node:sqlite`。

### Q: 我已经安装了 Node.js 20，怎么办？

A: 你有两个选择：

1. **推荐**: 使用 nvm/fnm 安装 Node.js 22.19，并与旧版本共存
2. 或者卸载旧版本，直接安装 Node.js 22.19 或更高版本

### Q: 切换 Node.js 版本后出现 "NODE_MODULE_VERSION" 错误怎么办？

A: 这是因为原生模块是用旧版本 Node.js 编译的。解决方法：

```bash
# 确保使用正确的 Node.js 版本
node --version  # 应该显示 v22.19.x 或 v24.x/v26.x

# 重新编译所有原生模块
pnpm rebuild
```

### Q: 每次进入项目目录都需要手动切换版本吗？

A: 不需要！如果你使用 nvm 或 fnm：

- **nvm**: 可以配置 shell 自动切换（参见 nvm 文档）
- **fnm**: 默认支持自动切换，只需在 shell 配置中添加：
  ```bash
  # 对于 zsh (~/.zshrc)
  eval "$(fnm env --use-on-cd)"

  # 对于 bash (~/.bashrc)
  eval "$(fnm env --use-on-cd)"
  ```

### Q: pnpm install 失败怎么办？

A: 检查以下几点：

1. 确保 Node.js 版本 >= 22
   ```bash
   node --version
   ```

2. 确保 Corepack 已启用
   ```bash
   corepack enable
   ```

3. 清理缓存重试
   ```bash
   pnpm store prune
   rm -rf node_modules pnpm-lock.yaml
   pnpm install
   ```

### Q: 安装后 native 模块无法加载怎么办？

A: 删除 `node_modules` 后重新执行 `pnpm install`，让 npm 根据当前平台和 Node 版本重新选择 N-API 预编译包。项目不建议在用户环境执行 `pnpm rebuild`。

## 验证安装

运行以下命令验证环境配置正确：

```bash
# 检查 Node.js 版本
node --version  # 应该显示 v22.19.x 或 v24.x/v26.x

# 检查 pnpm 版本
pnpm --version  # 应该显示 10.7.1 或更高

# 检查项目依赖
pnpm list --depth=0

# 安装依赖时会自动检查 Node.js 版本和 pnpm
pnpm install
```

## 新设备设置清单

在新设备上设置项目时，请按以下步骤操作：

- [ ] 安装 Node.js 版本管理器（nvm 或 fnm）
- [ ] 安装 Node.js 22.19 或更高版本
- [ ] 启用 Corepack（`corepack enable`）
- [ ] 克隆项目仓库
- [ ] 进入项目目录（如果配置了自动切换，会自动使用 `.nvmrc` 指定的版本）
- [ ] 运行 `pnpm install`
- [ ] **确认 Node.js 版本为 22.19+、24 或 26，并重新执行 `pnpm install`**
- [ ] 运行 `pnpm dev:backend` 测试后端
- [ ] 运行 `pnpm dev:frontend` 测试前端

## 相关链接

- [Node.js 官网](https://nodejs.org/)
- [nvm GitHub](https://github.com/nvm-sh/nvm)
- [fnm GitHub](https://github.com/Schniz/fnm)
- [pnpm 文档](https://pnpm.io/)
