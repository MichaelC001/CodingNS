# 安装 CodingNS Host

请先在一台准备长期使用的设备上安装 CodingNS Host。桌面端、手机和浏览器后续都会连接到这台 Host。

## 安装方式

### 一键安装

想少记命令，直接运行安装脚本：

```bash
curl -fsSL https://codingns.com/install | bash
```

也可以在仓库目录中运行：

```bash
bash install.sh
```

脚本会检查 Node.js、npm 和原生依赖，安装或更新 `@jingyi0605/codingns`，然后调用统一安装器完成服务启动和开机自启。安装时会询问端口、数据目录和是否启用开机自启。默认端口是 `3002`，默认数据目录是 `~/.codingns`。

开机自启使用操作系统原生机制：

- macOS：LaunchAgent
- Linux：systemd user service
- Windows：计划任务；计划任务不可用时使用用户启动文件夹

安装脚本不再安装或调用第三方进程管理器。服务状态、启动、停止、重启和自启开关都由 `codingns` 统一安装器处理。

### 在桌面端安装

桌面客户端首次启动时，如果没有可连的服务，会进入首次运行向导：

1. 选择“在这台电脑上安装服务”。
2. 向导检查系统、Node 运行时、已有安装、端口和数据目录。
3. 填写端口和数据目录，选择是否开机自启以及是否允许局域网访问。
4. 点击“开始安装”，查看装包、启动和自检进度。
5. 安装完成后回到登录页，地址就是刚安装的本机服务。

Node、服务包和日志默认放在用户目录下，不需要管理员权限。

## 开始前的准备

请确认机器上有：

- Node.js `22` 或更高版本
- npm `10` 或更高版本

Linux 如果需要本机编译原生依赖，先安装：

```bash
apt-get update
apt-get install -y build-essential python3
```

Windows 建议使用 Node.js `22 LTS`，并准备 Visual Studio Build Tools 2022 的 `Desktop development with C++` 工作负载，以便预编译包下载失败时仍能完成安装。

## 手动安装和管理

先安装服务包：

```bash
npm install -g @jingyi0605/codingns
```

让统一安装器安装服务、启动服务并配置开机自启：

```bash
HOST_INSTALLER="$(npm root -g)/@jingyi0605/codingns/scripts/host-install.mjs"
node "$HOST_INSTALLER" install --host 0.0.0.0 --port 3002 --data-dir ~/.codingns --autostart
```

常用管理命令：

```bash
node "$HOST_INSTALLER" status --data-dir ~/.codingns
node "$HOST_INSTALLER" start --data-dir ~/.codingns
node "$HOST_INSTALLER" stop --data-dir ~/.codingns
node "$HOST_INSTALLER" restart --data-dir ~/.codingns
node "$HOST_INSTALLER" autostart --disable --data-dir ~/.codingns
```

如果只想在当前终端临时运行，可以直接执行：

```bash
codingns start --host 0.0.0.0 --port 3002 --data-dir ~/.codingns
```

## 端口和数据目录

默认端口是 `3002`。端口被占用时，可以换成例如 `3300`：

```bash
node "$HOST_INSTALLER" install --port 3300 --data-dir ~/.codingns --autostart
```

默认数据目录是 `~/.codingns`。需要放到其他位置时，给 `--data-dir` 传绝对路径。

## 下一步

接下来查看[连接客户端](/quick-install/client-connection)。连上后再看[首次登录与开始使用](/quick-install/first-login)。

## 常见失败原因

### Windows 缺少 Visual Studio C++ 工具

如果看到 `Could not find any Visual Studio installation to use`，请安装 Visual Studio Build Tools 2022，并勾选 `Desktop development with C++`，然后重新运行统一安装器。

### Windows 下载预编译包失败

`prebuild-install` 的网络错误通常来自 GitHub Releases 下载失败，与 npm registry 不是同一个链路。优先使用 Node.js `22 LTS`，准备好 C++ Build Tools，再重试安装。
