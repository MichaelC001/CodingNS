#!/usr/bin/env bash

set -euo pipefail
shopt -s extglob

PACKAGE_SPEC="${CODINGNS_PACKAGE_SPEC:-@jingyi0605/codingns}"
DEFAULT_PORT="${CODINGNS_DEFAULT_PORT:-3002}"
DEFAULT_DATA_DIR="${CODINGNS_DEFAULT_DATA_DIR:-$HOME/.codingns}"
OFFICIAL_NPM_REGISTRY="${CODINGNS_OFFICIAL_REGISTRY:-https://registry.npmjs.org}"
MIRROR_NPM_REGISTRY="${CODINGNS_MIRROR_REGISTRY:-https://registry.npmmirror.com}"
DRY_RUN="${CODINGNS_INSTALL_DRY_RUN:-0}"
REGISTRY_PROBE_PACKAGE_SPEC="${CODINGNS_REGISTRY_PROBE_SPEC:-@openai/codex-sdk}"
PTY_PACKAGE_NAME="@lydell/node-pty"
SQLITE_PACKAGE_NAME="libsql"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=19
DEEPSEEK_HARNESS_ROOT="${CODINGNS_DEEPSEEK_HARNESS_ROOT:-$HOME/.local/share/codingns/deepseek-harness}"
DEEPSEEK_HARNESS_BIN="${CODINGNS_DEEPSEEK_HARNESS_BIN:-$HOME/.local/bin/dsh}"
INSTALL_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

SUPPORTED_CLIS=(
  "claude-code|Claude Code|claude"
  "codex|Codex|codex"
  "opencode|OpenCode|opencode"
  "gemini|Gemini CLI|gemini"
  "kimi|Kimi CLI|kimi"
)

LANG_MODE=""
CLI_SUMMARY_LINES=()
INSTALLED_CLI_COUNT=0
ACTIVE_NPM_REGISTRY=""
NPM_BIN=""
NODE_BIN=""
CODINGNS_BIN=""
CODINGNS_SCRIPT=""
NPM_GLOBAL_PREFIX=""
USE_SUDO_FOR_NPM="0"
BREW_BIN=""
SELECTED_PORT=""
SELECTED_DATA_DIR=""
INSTALL_CODINGNS="1"
ENABLE_STARTUP="1"
INSTALL_DESKTOP_CLIENT="0"
PROMPT_INPUT_FD=""
PREREQUISITE_ISSUES=()
INSTALL_OPENCODE="0"
PREREQUISITE_WARNINGS=()
LAST_INSTALL_LOG=""
PRIVATE_INSTALL_CONTEXT="0"
SYSTEM_PATH_SNAPSHOT="${PATH:-}"
SYSTEM_NODE_BIN=""
SYSTEM_NPM_BIN=""
SYSTEM_NODE_VERSION=""
SYSTEM_NODE_ABI=""
TARGET_NODE_VERSION=""
TARGET_NODE_ABI=""
INSTALL_ENV_ARGS=()
RUNTIME_HOME=""
PRIVATE_NPM_PREFIX=""
PRIVATE_NPM_CACHE_DIR=""
PRIVATE_DOWNLOAD_CACHE_DIR=""
PRIVATE_LOG_DIR=""
PRIVATE_INSTALL_LOG_DIR=""
PRIVATE_SERVICE_STATE_DIR=""
PRIVATE_NPM_USERCONFIG=""
TARGET_RUNTIME_UNSUPPORTED_PACKAGES=()
TARGET_RUNTIME_FALLBACK_PACKAGES=()
TARGET_RUNTIME_MANAGED_PACKAGE_SUMMARY=()
CODINGNS_PACKAGE_ROOT=""
CODINGNS_PACKAGE_NAME=""
CODINGNS_PACKAGE_VERSION=""
CODINGNS_PTY_PACKAGE_NAME=""
CODINGNS_PTY_PACKAGE_VERSION=""
CODINGNS_SQLITE_PACKAGE_NAME=""
CODINGNS_SQLITE_PACKAGE_VERSION=""
PACKAGE_NAME=""
SELECTED_PACKAGE_VERSION=""
INSTALLED_PACKAGE_VERSION=""
INSTALLED_DATA_DIR=""
INSTALLED_PORT=""
INSTALLED_AUTOSTART="0"
MANAGEMENT_ACTION=""
VERSION_LIST=()
VERSION_METADATA=""

msg() {
  local key="$1"
  shift || true

  case "${LANG_MODE}:${key}" in
    zh:choose_language_title) printf '请选择安装脚本语言';;
    en:choose_language_title) printf 'Select installer language';;
    zh:choose_language_option_zh) printf '1) 中文';;
    en:choose_language_option_zh) printf '1) 中文';;
    zh:choose_language_option_en) printf '2) English';;
    en:choose_language_option_en) printf '2) English';;
    zh:choose_language_prompt) printf '请输入 1 或 2 [1]: ';;
    en:choose_language_prompt) printf 'Enter 1 or 2 [1]: ';;

    zh:prefix) printf '[codingns-install] ';;
    en:prefix) printf '[codingns-install] ';;

    zh:error_root) printf '不要直接用 sudo 整个执行脚本。请用普通用户运行，脚本会在需要管理员权限时单独请求 sudo。';;
    en:error_root) printf 'Do not run the whole installer with sudo. Run it as a normal user and the script will request sudo only when needed.';;
    zh:error_no_node) printf '未检测到 node，请先安装 Node.js 22.19 或更高版本。';;
    en:error_no_node) printf 'Node.js was not found. Please install Node.js 22.19 or later first.';;
    zh:error_no_npm) printf '未检测到 npm，请先安装 npm 10 或更高版本。';;
    en:error_no_npm) printf 'npm was not found. Please install npm 10 or later first.';;
    zh:error_no_make) printf '未检测到 make，Linux 下安装 CodingNS 需要编译工具链。';;
    en:error_no_make) printf 'make was not found. CodingNS installation on Linux needs a native build toolchain.';;
    zh:error_no_cpp_compiler) printf '未检测到 g++，Linux 下安装 CodingNS 需要 C++ 编译器。';;
    en:error_no_cpp_compiler) printf 'g++ was not found. CodingNS installation on Linux needs a C++ compiler.';;
    zh:error_no_python3) printf '未检测到 python3，Linux 下安装 CodingNS 需要 Python 3。';;
    en:error_no_python3) printf 'python3 was not found. CodingNS installation on Linux needs Python 3.';;
    zh:error_bad_node_version) printf '当前 Node.js 版本是 %s，项目要求 Node.js 22.19 或更高版本。' "$@";;
    en:error_bad_node_version) printf 'Your current Node.js version is %s, but CodingNS requires Node.js 22.19 or later.' "$@";;
    zh:error_bad_npm_version) printf '当前 npm 版本是 %s，项目要求 >= 10。' "$@";;
    en:error_bad_npm_version) printf 'Your current npm version is %s, but CodingNS requires >= 10.' "$@";;
    zh:error_read_node_version) printf '无法识别 Node.js 版本：%s' "$@";;
    en:error_read_node_version) printf 'Unable to detect the Node.js version: %s' "$@";;
    zh:error_read_npm_version) printf '无法识别 npm 版本：%s' "$@";;
    en:error_read_npm_version) printf 'Unable to detect the npm version: %s' "$@";;
    zh:error_read_prefix) printf '无法读取 npm 全局安装目录。';;
    en:error_read_prefix) printf 'Unable to read the npm global install directory.';;
    zh:error_no_sudo) printf 'npm 全局目录不可写，且当前系统没有 sudo，无法继续安装。';;
    en:error_no_sudo) printf 'The npm global directory is not writable and sudo is not available, so the installer cannot continue.';;
    zh:error_port_invalid) printf '端口必须是 1 到 65535 之间的整数。';;
    en:error_port_invalid) printf 'The port must be an integer between 1 and 65535.';;
    zh:error_registry_unavailable) printf '官方 npm 源和国内镜像都不可用，请检查网络后重试。';;
    en:error_registry_unavailable) printf 'Both the official npm registry and the mirror are unavailable. Please check your network and try again.';;
    zh:error_no_codingns_after_install) printf '安装完成后仍未找到 codingns 命令。';;
    en:error_no_codingns_after_install) printf 'The codingns command was still not found after installation.';;
    zh:error_host_installer_failed) printf '统一安装器执行失败，安装已中止，请查看安装日志后重试。';;
    en:error_host_installer_failed) printf 'The unified installer failed, so installation was stopped. Check the install log and retry.';;
    zh:error_skip_codingns_without_existing) printf '你跳过了 CodingNS 安装，但当前机器上也没有可用的 codingns 命令。';;
    en:error_skip_codingns_without_existing) printf 'You skipped CodingNS installation, but there is no existing codingns command on this machine.';;
    zh:error_prompt_interrupted) printf '没有读取到终端输入，安装流程已中止。请在交互式终端里重新运行脚本。';;
    en:error_prompt_interrupted) printf 'No terminal input was received. The installation was aborted. Please run the script again in an interactive terminal.';;
    zh:error_prereq_auto_install_cancelled) printf '缺少必备环境，且你没有同意自动安装，安装流程已中止。';;
    en:error_prereq_auto_install_cancelled) printf 'Required dependencies are missing, and automatic installation was not approved. The installation was aborted.';;
    zh:error_prereq_auto_install_unsupported) printf '当前系统暂不支持自动安装必备环境，请先手工安装 Node.js 22.19+、npm 10+ 和所需编译工具后重试。';;
    en:error_prereq_auto_install_unsupported) printf 'Automatic dependency installation is not supported on this system yet. Please install Node.js 22.19+, npm 10+, and the required build tools manually, then try again.';;
    zh:error_prereq_auto_install_failed) printf '自动安装必备环境失败，请检查网络、权限或软件源后重试。';;
    en:error_prereq_auto_install_failed) printf 'Automatic dependency installation failed. Please check your network, permissions, or package sources and try again.';;
    zh:error_no_supported_linux_installer) printf '当前 Linux 发行版没有检测到受支持的自动安装方式。暂时只支持 apt-get。';;
    en:error_no_supported_linux_installer) printf 'No supported automatic installer was detected for this Linux distribution. Only apt-get is supported for now.';;
    zh:error_brew_install_failed) printf 'Homebrew 安装或初始化失败，无法继续自动安装 Node.js。';;
    en:error_brew_install_failed) printf 'Homebrew installation or initialization failed, so Node.js cannot be installed automatically.';;

    zh:info_need_sudo) printf '检测到 npm 全局目录需要管理员权限，后续全局安装会使用 sudo。';;
    en:info_need_sudo) printf 'The npm global directory needs administrator permission. The installer will use sudo for global installs.';;
    zh:info_prereq_check_title) printf '开始检查必备运行环境...';;
    en:info_prereq_check_title) printf 'Checking required runtime dependencies...';;
    zh:info_prereq_missing_title) printf '检测到以下必备环境缺失或版本不符合要求：';;
    en:info_prereq_missing_title) printf 'The following required dependencies are missing or do not meet the version requirements:';;
    zh:info_installing_homebrew) printf '未检测到 Homebrew，开始自动安装 Homebrew...';;
    en:info_installing_homebrew) printf 'Homebrew was not found. Installing Homebrew automatically...';;
    zh:info_installing_nodejs) printf '开始自动安装或升级 Node.js 运行环境...';;
    en:info_installing_nodejs) printf 'Installing or upgrading the Node.js runtime automatically...';;
    zh:info_installing_linux_build_tools) printf '开始自动安装 Linux 编译工具链...';;
    en:info_installing_linux_build_tools) printf 'Installing the Linux native build toolchain automatically...';;
    zh:info_auto_install_done) printf '必备环境已准备完成，继续安装流程。';;
    en:info_auto_install_done) printf 'Required dependencies are now ready. Continuing the installation flow.';;
    zh:info_detect_clis) printf '检测当前机器上的受支持 CLI：';;
    en:info_detect_clis) printf 'Checking supported CLI tools on this machine:';;
    zh:info_no_cli) printf '当前没有检测到任何受支持的 CLI。';;
    en:info_no_cli) printf 'No supported CLI tools were detected on this machine.';;
    zh:info_recommend_opencode) printf '建议优先安装 OpenCode：自带免费模型，开箱即用；即使现在先装 CodingNS，后续补装 CLI 也不影响。';;
    en:info_recommend_opencode) printf 'OpenCode is the recommended first CLI to install: it works out of the box with built-in free models, and you can still add more CLI tools later.';;
    zh:info_install_opencode) printf '安装 OpenCode：%s' "$@";;
    en:info_install_opencode) printf 'Install OpenCode: %s' "$@";;
    zh:info_installing_opencode) printf '开始安装 OpenCode...';;
    en:info_installing_opencode) printf 'Installing OpenCode...';;
    zh:info_opencode_installed) printf 'OpenCode 安装流程已执行完成。';;
    en:info_opencode_installed) printf 'The OpenCode installation flow completed.';;
    zh:warn_opencode_install_failed) printf 'OpenCode 安装没有成功，你可以稍后手工执行：curl -fsSL https://opencode.ai/install | bash';;
    en:warn_opencode_install_failed) printf 'OpenCode installation did not complete successfully. You can run this later: curl -fsSL https://opencode.ai/install | bash';;
    zh:warn_opencode_install_requires_curl) printf '当前机器没有检测到 curl，暂时无法自动安装 OpenCode。';;
    en:warn_opencode_install_requires_curl) printf 'curl was not found on this machine, so OpenCode cannot be installed automatically right now.';;
    zh:info_summary_title) printf '安装计划：';;
    en:info_summary_title) printf 'Installation plan:';;
    zh:prompt_enable_startup) printf '是否配置开机自动启动？';;
    en:prompt_enable_startup) printf 'Enable start on boot?';;
    zh:info_enable_startup) printf '开机自动启动：%s' "$@";;
    en:info_enable_startup) printf 'Start on boot: %s' "$@";;
    zh:info_port) printf '服务端口：%s' "$@";;
    en:info_port) printf 'Service port: %s' "$@";;
    zh:info_data_dir) printf '数据目录：%s' "$@";;
    en:info_data_dir) printf 'Data directory: %s' "$@";;
    zh:info_install_codingns) printf '安装或更新 CodingNS：%s' "$@";;
    en:info_install_codingns) printf 'Install or update CodingNS: %s' "$@";;
    zh:info_startup) printf '配置开机自启：%s' "$@";;
    en:info_startup) printf 'Configure start on boot: %s' "$@";;
    zh:info_begin) printf '开始执行你选中的步骤...';;
    en:info_begin) printf 'Starting the steps you selected...';;
    zh:info_using_official_registry) printf 'npm 源探测结果：使用官方源 %s' "$@";;
    en:info_using_official_registry) printf 'Registry check: using the official npm registry %s' "$@";;
    zh:warn_official_registry_failed) printf '官方 npm 源暂时不可用，准备切换到国内镜像。';;
    en:warn_official_registry_failed) printf 'The official npm registry is temporarily unavailable. Switching to the mirror.';;
    zh:info_using_mirror_registry) printf 'npm 源探测结果：使用镜像源 %s' "$@";;
    en:info_using_mirror_registry) printf 'Registry check: using the mirror %s' "$@";;
    zh:info_installing_codingns) printf '开始安装或更新 CodingNS...';;
    en:info_installing_codingns) printf 'Installing or updating CodingNS...';;
    zh:info_skip_codingns) printf '已跳过 CodingNS 安装，继续使用当前机器上的现有命令。';;
    en:info_skip_codingns) printf 'Skipped CodingNS installation. The installer will use the existing command on this machine.';;
    zh:info_skip_startup) printf '已按你的选择跳过开机自启配置。';;
    en:info_skip_startup) printf 'Start-on-boot configuration was skipped as requested.';;
    zh:warn_linux_startup_no_sudo) printf '当前 Linux 平台需要 sudo 才能写入 systemd 启动项，已跳过自动配置。';;
    en:warn_linux_startup_no_sudo) printf 'This Linux machine needs sudo to write the systemd startup entry, so automatic startup setup was skipped.';;
    zh:warn_windows_missing_build_tools) printf '当前是 Windows 环境，但未检测到 Visual Studio C++ Build Tools。CodingNS 依赖 libsql、@lydell/node-pty 这类原生模块；如果预编译包下载失败，npm 会回退到本机编译，并要求你先安装 Visual Studio Build Tools 2022，勾选“Desktop development with C++”。';;
    en:warn_windows_missing_build_tools) printf 'This is a Windows environment, but Visual Studio C++ Build Tools were not detected. CodingNS depends on native modules such as libsql and @lydell/node-pty. If the prebuilt binaries cannot be downloaded, npm falls back to local compilation and requires Visual Studio Build Tools 2022 with the "Desktop development with C++" workload.';;
    zh:warn_windows_registry_not_enough) printf '补充说明：切换 npm 源只会影响 npm 包下载，不会解决 libsql 或 @lydell/node-pty 从 GitHub Releases 下载预编译包失败的问题。';;
    en:warn_windows_registry_not_enough) printf 'Important: switching the npm registry only affects npm package downloads. It does not fix failures when libsql or @lydell/node-pty try to download prebuilt binaries from GitHub Releases.';;
    zh:warn_windows_install_failed_vs) printf '安装日志里已经看到 node-gyp 找不到 Visual Studio。请先安装 Visual Studio Build Tools 2022，并勾选“Desktop development with C++”，然后重试。';;
    en:warn_windows_install_failed_vs) printf 'The install log shows that node-gyp could not find Visual Studio. Install Visual Studio Build Tools 2022 with the "Desktop development with C++" workload, then retry.';;
    zh:warn_windows_install_failed_prebuild_network) printf '安装日志里已经看到原生模块预编译包下载失败（例如 ECONNRESET 或 timed out）。这通常是访问 GitHub Releases 失败，不是 npm 源本身的问题。';;
    en:warn_windows_install_failed_prebuild_network) printf 'The install log shows that downloading native prebuilt binaries failed (for example ECONNRESET or timed out). This is usually a GitHub Releases connectivity problem, not an npm registry problem.';;
    zh:info_runtime_sqlite) printf '实际 SQLite 依赖：%s' "$@";;
    en:info_runtime_sqlite) printf 'Runtime SQLite dependency: %s' "$@";;
    zh:info_windows_managed_package_summary) printf '受管原生依赖检查：%s' "$@";;
    en:info_windows_managed_package_summary) printf 'Managed native package check: %s' "$@";;
    zh:warn_install_log_path) printf '失败日志位置：%s' "$@";;
    en:warn_install_log_path) printf 'Failure log path: %s' "$@";;
    zh:info_using_host_installer) printf '使用统一安装器完成配置、启动与开机自启...';;
    en:info_managed_by_installer) printf 'Service is now managed by the unified installer.';;
    zh:info_managed_by_installer) printf '服务已经交给统一安装器管理。';;
    zh:prompt_install_desktop_client) printf '顺便安装桌面客户端吗？';;
    en:prompt_install_desktop_client) printf 'Also install the desktop client?';;
    zh:info_desktop_client_downloading) printf '正在下载桌面客户端安装包...';;
    en:info_desktop_client_downloading) printf 'Downloading the desktop client installer...';;
    zh:info_desktop_client_installed) printf '桌面客户端已经装到 %s。';;
    en:info_desktop_client_installed) printf 'Desktop client installed to %s.';;
    zh:warn_desktop_client_download_failed) printf '桌面客户端下载失败，服务端不受影响。可以稍后从 GitHub Release 手动下载。';;
    en:warn_desktop_client_download_failed) printf 'Desktop client download failed; the service install is unaffected. Download it later from GitHub Releases.';;
    zh:warn_desktop_client_install_failed) printf '桌面客户端安装失败，服务端不受影响。';;
    en:warn_desktop_client_install_failed) printf 'Desktop client install failed; the service install is unaffected.';;
    zh:warn_desktop_client_unsupported) printf '当前平台暂不支持自动安装桌面客户端，请到 GitHub Release 手动下载。';;
    en:warn_desktop_client_unsupported) printf 'Automatic desktop client install is not supported on this platform yet. Download it from GitHub Releases.';;
    en:info_installer_service_hint) printf 'Autostart, startup, and the health check were handled by the installer.';;
    zh:info_installer_service_hint) printf '开机自启、服务启动和健康检查都已经由安装器完成。';;
    en:info_installer_state_hint) printf 'Open the desktop app settings to see the service state, or run the unified installer status command.';;
    zh:info_installer_state_hint) printf '可以在桌面端设置页查看服务状态，也可以直接运行统一安装器的 status 命令。';;
    en:info_using_host_installer) printf 'Using the unified installer for setup, startup, and autostart...';;
    zh:info_done) printf '安装流程已完成。';;
    en:info_done) printf 'The installation flow is complete.';;
    zh:info_existing_install) printf '检测到已安装的 CodingNS：%s（数据目录：%s）' "$@";;
    en:info_existing_install) printf 'Existing CodingNS installation detected: %s (data directory: %s)' "$@";;
    zh:prompt_existing_action) printf '请选择操作：';;
    en:prompt_existing_action) printf 'Choose an action:';;
    zh:existing_action_upgrade) printf '1) 升级';;
    en:existing_action_upgrade) printf '1) Upgrade';;
    zh:existing_action_downgrade) printf '2) 降级';;
    en:existing_action_downgrade) printf '2) Downgrade';;
    zh:existing_action_uninstall) printf '3) 卸载';;
    en:existing_action_uninstall) printf '3) Uninstall';;
    zh:existing_action_cancel) printf '4) 取消';;
    en:existing_action_cancel) printf '4) Cancel';;
    zh:prompt_version) printf '请输入版本编号';;
    en:prompt_version) printf 'Enter the version number';;
    zh:info_no_versions) printf '没有找到符合条件的版本。';;
    en:info_no_versions) printf 'No matching versions were found.';;
    zh:info_version_source_failed) printf '无法读取 npm 版本列表，请检查网络或稍后重试。';;
    en:info_version_source_failed) printf 'Unable to read the npm version list. Check the network and try again later.';;
    zh:info_version_upgrade_title) printf '可升级到以下版本（当前：%s）：' "$@";;
    en:info_version_upgrade_title) printf 'Available upgrade versions (current: %s):' "$@";;
    zh:info_version_downgrade_title) printf '可降级到以下版本（当前：%s）：' "$@";;
    en:info_version_downgrade_title) printf 'Available downgrade versions (current: %s):' "$@";;
    zh:version_show_development) printf 'd) 显示开发版本';;
    en:version_show_development) printf 'd) Show development versions';;
    zh:version_cancel) printf 'q) 取消';;
    en:version_cancel) printf 'q) Cancel';;
    zh:info_selected_version) printf '已选择 CodingNS %s。' "$@";;
    en:info_selected_version) printf 'Selected CodingNS %s.' "$@";;
    zh:prompt_purge_data) printf '是否同时清理数据目录？';;
    en:prompt_purge_data) printf 'Also remove the data directory?';;
    zh:info_uninstalling) printf '开始卸载 CodingNS，并清理服务和开机自启配置...';;
    en:info_uninstalling) printf 'Uninstalling CodingNS and removing service/autostart configuration...';;
    zh:info_uninstalled) printf 'CodingNS 已卸载。';;
    en:info_uninstalled) printf 'CodingNS has been uninstalled.';;
    zh:info_uninstall_keep_data) printf '已保留数据目录：%s' "$@";;
    en:info_uninstall_keep_data) printf 'Data directory kept: %s' "$@";;
    zh:info_registry) printf '当前 npm 源：%s' "$@";;
    en:info_registry) printf 'Registry used: %s' "$@";;
    zh:info_runtime_node) printf '实际运行时 Node.js：%s' "$@";;
    en:info_runtime_node) printf 'Runtime Node.js: %s' "$@";;
    zh:info_runtime_prefix) printf '实际 npm 前缀：%s' "$@";;
    en:info_runtime_prefix) printf 'Runtime npm prefix: %s' "$@";;
    zh:info_runtime_pty) printf '实际 PTY 依赖：%s' "$@";;
    en:info_runtime_pty) printf 'Runtime PTY dependency: %s' "$@";;
    zh:info_access_title) printf '访问方式：';;
    en:info_access_title) printf 'Access:';;
    zh:info_service_url) printf '浏览器或客户端连接地址：http://127.0.0.1:%s/' "$@";;
    en:info_service_url) printf 'Browser or client URL: http://127.0.0.1:%s/' "$@";;
    zh:info_password_title) printf '登录说明：';;
    en:info_password_title) printf 'Login:';;
    zh:info_password_none) printf '默认密码：无';;
    en:info_password_none) printf 'Default password: none';;
    zh:info_password_setup_hint) printf '首次访问会进入初始化页面，请先创建管理员账号和密码。';;
    en:info_password_setup_hint) printf 'On first access, you will see the bootstrap page and create the admin account and password yourself.';;
    zh:info_manual_start_title) printf '你还没有让脚本替你启动服务。后续可以手工执行：';;
    en:info_manual_start_title) printf 'You chose not to let the installer start the service. You can run this command later:';;
    zh:info_open_docs_title) printf '如果你想继续看后续操作说明，可以访问：';;
    en:info_open_docs_title) printf 'If you want the next-step guide, open:';;
    zh:info_docs_link) printf 'https://docs.codingns.com/quick-install/host-installation';;
    en:info_docs_link) printf 'https://docs.codingns.com/quick-install/host-installation';;

    zh:prompt_port) printf '请输入服务端口';;
    en:prompt_port) printf 'Enter the service port';;
    zh:prompt_data_dir) printf '请输入数据保存目录';;
    en:prompt_data_dir) printf 'Enter the data directory';;
    zh:prompt_auto_install_prereq) printf '检测到缺少必备环境，是否现在自动安装？';;
    en:prompt_auto_install_prereq) printf 'Required dependencies are missing. Install them automatically now?';;
    zh:prompt_install_opencode) printf '当前没有检测到受支持 CLI，是否现在安装 OpenCode？';;
    en:prompt_install_opencode) printf 'No supported CLI was detected. Install OpenCode now?';;
    zh:prompt_install_codingns) printf '现在安装或更新 CodingNS 吗？';;
    en:prompt_install_codingns) printf 'Install or update CodingNS now?';;
    zh:prompt_confirm_plan) printf '按上面的计划继续吗？';;
    en:prompt_confirm_plan) printf 'Continue with this plan?';;
    zh:prompt_aborted) printf '已取消安装流程。';;
    en:prompt_aborted) printf 'The installation flow was cancelled.';;

    zh:yes_word) printf '是';;
    en:yes_word) printf 'Yes';;
    zh:no_word) printf '否';;
    en:no_word) printf 'No';;
    *)
      printf '%s' "$key"
      ;;
  esac
}

say_info() {
  printf '%s' "$(msg prefix)"
  msg "$@"
  printf '\n'
}

say_warn() {
  printf '%s' "$(msg prefix)" >&2
  msg "$@" >&2
  printf '\n' >&2
}

die() {
  printf '%s' "$(msg prefix)" >&2
  msg "$@" >&2
  printf '\n' >&2
  exit 1
}

die_without_language() {
  printf '%s\n' '[codingns-install] 交互式安装需要终端输入，请直接在终端中运行该命令。 / This interactive installer requires terminal input. Please run the command in a terminal.' >&2
  exit 1
}

init_prompt_input() {
  if [[ -n "${CODINGNS_INSTALL_INPUT_FD:-}" ]]; then
    PROMPT_INPUT_FD="${CODINGNS_INSTALL_INPUT_FD}"
    return
  fi

  if { exec 3</dev/tty; } 2>/dev/null; then
    PROMPT_INPUT_FD="3"
    return
  fi

  die_without_language
}

prompt_read_line() {
  local prompt_text="$1"
  local __result_var="$2"
  local line_value=""

  printf '%s' "$prompt_text" >&2

  if ! IFS= read -r -u "$PROMPT_INPUT_FD" line_value; then
    if [[ -n "$LANG_MODE" ]]; then
      die error_prompt_interrupted
    fi
    die_without_language
  fi

  printf -v "$__result_var" '%s' "$line_value"
}

choose_language() {
  local input=""

  while true; do
    printf '%s\n' 'Select installer language / 请选择安装脚本语言'
    printf '%s\n' '1) 中文'
    printf '%s\n' '2) English'
    prompt_read_line 'Enter 1 or 2 / 请输入 1 或 2 [1]: ' input
    input="$(trim "$input")"

    case "$input" in
      ""|1)
        LANG_MODE="zh"
        return
        ;;
      2)
        LANG_MODE="en"
        return
        ;;
      *)
        printf '%s\n' 'Please enter 1 or 2. / 请输入 1 或 2。'
        ;;
    esac
  done
}

trim() {
  local value="$1"
  value="${value##+([[:space:]])}"
  value="${value%%+([[:space:]])}"
  printf '%s' "$value"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

is_windows_environment() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_root_user() {
  [[ "$(id -u)" -eq 0 ]]
}

refresh_runtime_binaries() {
  NODE_BIN="$(command -v node 2>/dev/null || true)"
  NPM_BIN="$(command -v npm 2>/dev/null || true)"
}

build_windows_runtime_paths() {
  RUNTIME_HOME="$SELECTED_DATA_DIR/runtime"
  PRIVATE_NPM_PREFIX="$RUNTIME_HOME/npm-global"
  PRIVATE_NPM_CACHE_DIR="$RUNTIME_HOME/cache/npm"
  PRIVATE_DOWNLOAD_CACHE_DIR="$RUNTIME_HOME/cache/downloads"
  PRIVATE_LOG_DIR="$RUNTIME_HOME/logs"
  PRIVATE_INSTALL_LOG_DIR="$PRIVATE_LOG_DIR/install"
  PRIVATE_SERVICE_STATE_DIR="$RUNTIME_HOME/service"
  PRIVATE_NPM_USERCONFIG="$PRIVATE_NPM_PREFIX/npmrc"
}

ensure_windows_runtime_dirs() {
  mkdir -p \
    "$PRIVATE_NPM_PREFIX" \
    "$PRIVATE_NPM_CACHE_DIR" \
    "$PRIVATE_DOWNLOAD_CACHE_DIR" \
    "$PRIVATE_INSTALL_LOG_DIR" \
    "$PRIVATE_SERVICE_STATE_DIR"
}

read_node_version_text() {
  local node_path="$1"
  "$node_path" -p "process.version" 2>/dev/null | tr -d '\r'
}

read_node_abi_text() {
  local node_path="$1"
  "$node_path" -p "process.versions.modules" 2>/dev/null | tr -d '\r'
}

normalize_version_text() {
  local version_text="$1"
  printf '%s' "${version_text#v}"
}

to_native_windows_path() {
  local target_path="$1"
  if is_windows_environment && command_exists cygpath; then
    cygpath -w "$target_path"
    return
  fi
  printf '%s\n' "$target_path"
}

native_path_for_node_runtime() {
  local target_path="$1"
  if is_windows_environment; then
    to_native_windows_path "$target_path"
    return
  fi
  printf '%s\n' "$target_path"
}

extract_package_name_from_spec() {
  local package_spec="$1"

  if [[ "$package_spec" == @*/* ]]; then
    local without_scope_prefix="${package_spec#@}"
    local scope_name="${without_scope_prefix%%/*}"
    local package_tail="${without_scope_prefix#*/}"
    printf '@%s/%s\n' "$scope_name" "${package_tail%%@*}"
    return
  fi

  printf '%s\n' "${package_spec%%@*}"
}

is_registry_package_spec() {
  local package_spec="$1"

  case "$package_spec" in
    file:*|git+*|github:*|http://*|https://*|./*|../*|/*|*.tgz|*.tar.gz)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

resolve_registry_probe_package_spec() {
  if is_registry_package_spec "$PACKAGE_SPEC"; then
    printf '%s\n' "$PACKAGE_SPEC"
    return
  fi

  printf '%s\n' "$REGISTRY_PROBE_PACKAGE_SPEC"
}

resolve_private_package_root_from_spec() {
  local npm_prefix="$1"
  local package_spec="$2"
  local package_name=""
  local package_root=""
  local local_package_root=""

  local_package_root="$(resolve_local_package_spec_dir "$package_spec" || true)"

  if [[ -d "$local_package_root" && -f "$local_package_root/package.json" ]]; then
    printf '%s\n' "$local_package_root"
    return 0
  fi

  package_name="$(extract_package_name_from_spec "$package_spec")"
  [[ -n "$package_name" ]] || return 1

  case "$package_name" in
    http://*|https://*|file:*|git+*|github:*|./*|../*|/*)
      return 1
      ;;
  esac

  local package_roots=(
    "$npm_prefix/node_modules/$package_name"
    "$npm_prefix/lib/node_modules/$package_name"
  )
  for package_root in "${package_roots[@]}"; do
    [[ -f "$package_root/package.json" ]] || continue
    printf '%s\n' "$package_root"
    return 0
  done
  return 1
}

resolve_local_package_spec_dir() {
  local package_spec="$1"
  local local_package_root=""

  local_package_root="$package_spec"
  if [[ "$local_package_root" == file:* ]]; then
    local_package_root="${local_package_root#file:}"
  fi

  if [[ "$local_package_root" =~ ^[A-Za-z]:[\\/].* ]] && is_windows_environment && command_exists cygpath; then
    local_package_root="$(cygpath -u "$local_package_root" 2>/dev/null || printf '%s' "$local_package_root")"
  fi

  printf '%s\n' "$local_package_root"
}

resolve_private_package_root_from_command_name() {
  local npm_prefix="$1"
  local command_name="$2"

  [[ -n "$NODE_BIN" ]] || return 1
  [[ -n "$npm_prefix" ]] || return 1
  [[ -n "$command_name" ]] || return 1
  [[ -d "$npm_prefix/node_modules" || -d "$npm_prefix/lib/node_modules" ]] || return 1

  "$NODE_BIN" - "$npm_prefix" "$command_name" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");

const [npmPrefix, commandName] = process.argv.slice(2);
const nodeModulesRoots = [
  path.join(npmPrefix, "node_modules"),
  path.join(npmPrefix, "lib", "node_modules")
].filter((candidate) => fs.existsSync(candidate));

function normalizeBinName(binPath) {
  return path.basename(binPath).replace(/\.(?:mjs|cjs|js)$/iu, "");
}

function packageOwnsCommand(packageJson) {
  const binField = packageJson?.bin;

  if (typeof binField === "string") {
    return normalizeBinName(binField) === commandName;
  }

  if (binField && typeof binField === "object") {
    return typeof binField[commandName] === "string" && binField[commandName].trim().length > 0;
  }

  return false;
}

function inspectPackageRoot(packageRoot) {
  const packageJsonPath = path.join(packageRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    return packageOwnsCommand(packageJson) ? packageRoot : null;
  } catch {
    return null;
  }
}

function printIfFound(packageRoot) {
  const resolvedRoot = inspectPackageRoot(packageRoot);
  if (resolvedRoot) {
    process.stdout.write(resolvedRoot);
    process.exit(0);
  }
}

for (const nodeModulesRoot of nodeModulesRoots) {
for (const entry of fs.readdirSync(nodeModulesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) {
    continue;
  }

  if (entry.name.startsWith("@")) {
    const scopeRoot = path.join(nodeModulesRoot, entry.name);
    for (const scopedEntry of fs.readdirSync(scopeRoot, { withFileTypes: true })) {
      if (!scopedEntry.isDirectory()) {
        continue;
      }
      printIfFound(path.join(scopeRoot, scopedEntry.name));
    }
    continue;
  }

  printIfFound(path.join(nodeModulesRoot, entry.name));
}
}

process.exit(1);
EOF
}

read_package_json_field() {
  local package_json_path="$1"
  local field_name="$2"

  [[ -n "$NODE_BIN" ]] || return 1
  [[ -f "$package_json_path" ]] || return 1

  "$NODE_BIN" - "$package_json_path" "$field_name" <<'EOF'
const fs = require("node:fs");

const [packageJsonPath, fieldName] = process.argv.slice(2);
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const value = packageJson?.[fieldName];

if (typeof value === "string" && value.trim()) {
  process.stdout.write(value.trim());
}
EOF
}

read_install_metadata_field() {
  local metadata_path="$1"
  local field_name="$2"

  [[ -n "$NODE_BIN" ]] || return 1
  [[ -f "$metadata_path" ]] || return 1

  "$NODE_BIN" - "$metadata_path" "$field_name" <<'EOF'
const fs = require("node:fs");

const [metadataPath, fieldName] = process.argv.slice(2);
const payload = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
const value = payload?.[fieldName];

if (typeof value === "string" && value.trim()) {
  process.stdout.write(value.trim());
}
EOF
}

resolve_package_root_from_dependency() {
  local owner_package_root="$1"
  local dependency_name="$2"

  [[ -n "$NODE_BIN" ]] || return 1
  [[ -n "$owner_package_root" ]] || return 1
  [[ -f "$owner_package_root/package.json" ]] || return 1

  "$NODE_BIN" - "$owner_package_root" "$dependency_name" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const [ownerPackageRoot, dependencyName] = process.argv.slice(2);

function findPackageRoot(startPath, expectedPackageName) {
  let currentDirectory = fs.statSync(startPath).isDirectory()
    ? startPath
    : path.dirname(startPath);

  while (true) {
    const packageJsonPath = path.join(currentDirectory, "package.json");

    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
        if (packageJson?.name === expectedPackageName) {
          process.stdout.write(currentDirectory);
          process.exit(0);
        }
      } catch {
      }
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      process.exit(1);
    }

    currentDirectory = parentDirectory;
  }
}

try {
  const packageRequire = createRequire(path.join(ownerPackageRoot, "package.json"));
  const resolvedEntry = packageRequire.resolve(dependencyName);
  findPackageRoot(resolvedEntry, dependencyName);
} catch (error) {
  if (error && typeof error === "object" && error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
    try {
      const packageRequire = createRequire(path.join(ownerPackageRoot, "package.json"));
      const resolvedPackageJson = packageRequire.resolve(`${dependencyName}/package.json`);
      process.stdout.write(path.dirname(resolvedPackageJson));
      process.exit(0);
    } catch {
      process.exit(1);
    }
  }

  process.exit(1);
}
EOF
}

resolve_required_sqlite_package_name() {
  printf 'libsql\n'
}

resolve_codingns_sqlite_dependency_metadata() {
  CODINGNS_SQLITE_PACKAGE_NAME=""
  CODINGNS_SQLITE_PACKAGE_VERSION=""

  if [[ -z "$CODINGNS_PACKAGE_ROOT" ]]; then
    return 0
  fi

  local required_package_name=""
  local dependency_package_root=""
  local dependency_package_json=""

  required_package_name="$(resolve_required_sqlite_package_name)"
  dependency_package_root="$(resolve_package_root_from_dependency "$CODINGNS_PACKAGE_ROOT" "$required_package_name" 2>/dev/null || true)"

  if [[ -z "$dependency_package_root" ]]; then
    return 0
  fi

  dependency_package_json="$dependency_package_root/package.json"
  if [[ ! -f "$dependency_package_json" ]]; then
    return 0
  fi

  CODINGNS_SQLITE_PACKAGE_NAME="$(read_package_json_field "$dependency_package_json" "name" || true)"
  CODINGNS_SQLITE_PACKAGE_VERSION="$(read_package_json_field "$dependency_package_json" "version" || true)"

  [[ -n "$CODINGNS_SQLITE_PACKAGE_NAME" ]] || CODINGNS_SQLITE_PACKAGE_NAME="$required_package_name"
  return 0
}

resolve_required_pty_package_name() {
  printf '%s\n' "$PTY_PACKAGE_NAME"
}

resolve_codingns_pty_dependency_metadata() {
  CODINGNS_PTY_PACKAGE_NAME=""
  CODINGNS_PTY_PACKAGE_VERSION=""

  if [[ -z "$CODINGNS_PACKAGE_ROOT" ]]; then
    return 0
  fi

  local required_package_name=""
  local dependency_package_root=""
  local dependency_package_json=""

  required_package_name="$(resolve_required_pty_package_name)"
  dependency_package_root="$(resolve_package_root_from_dependency "$CODINGNS_PACKAGE_ROOT" "$required_package_name" 2>/dev/null || true)"

  if [[ -z "$dependency_package_root" ]]; then
    return 0
  fi

  dependency_package_json="$dependency_package_root/package.json"
  if [[ ! -f "$dependency_package_json" ]]; then
    return 0
  fi

  CODINGNS_PTY_PACKAGE_NAME="$(read_package_json_field "$dependency_package_json" "name" || true)"
  CODINGNS_PTY_PACKAGE_VERSION="$(read_package_json_field "$dependency_package_json" "version" || true)"

  [[ -n "$CODINGNS_PTY_PACKAGE_NAME" ]] || CODINGNS_PTY_PACKAGE_NAME="$required_package_name"
  return 0
}

resolve_script_from_npm_shim() {
  local shim_path="$1"

  [[ -n "$NODE_BIN" ]] || return 1
  [[ -f "$shim_path" ]] || return 1

  "$NODE_BIN" - "$shim_path" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");

const shimPath = path.resolve(process.argv[2]);
const shimDir = path.dirname(shimPath);
const content = fs.readFileSync(shimPath, "utf8");
const patterns = [
  /%~dp0\\([^"\r\n]+?\.(?:mjs|cjs|js))/gi,
  /\$basedir\/([^"\r\n]+?\.(?:mjs|cjs|js))/g,
  /"([^"\r\n]*node_modules[\\/][^"\r\n]+?\.(?:mjs|cjs|js))"/g,
  /'([^'\r\n]*node_modules[\\/][^'\r\n]+?\.(?:mjs|cjs|js))'/g
];

for (const pattern of patterns) {
  for (const match of content.matchAll(pattern)) {
    const candidate = (match[1] || "").trim();
    if (!candidate) {
      continue;
    }

    const normalized = candidate
      .replace(/^%~dp0/i, "")
      .replace(/^%dp0%/i, "")
      .replace(/^\$basedir\/?/i, "")
      .replace(/\\/g, "/");
    const resolved = path.resolve(shimDir, normalized);

    if (fs.existsSync(resolved)) {
      process.stdout.write(resolved);
      process.exit(0);
    }
  }
}

process.exit(1);
EOF
}

download_file_with_fallback() {
  local source_url="$1"
  local target_path="$2"
  local native_target_path=""

  if command_exists curl; then
    curl -fL "$source_url" -o "$target_path"
    return
  fi

  if command_exists powershell.exe; then
    native_target_path="$(to_native_windows_path "$target_path")"
    CODINGNS_DOWNLOAD_URL="$source_url" \
    CODINGNS_DOWNLOAD_OUT="$native_target_path" \
      powershell.exe -NoLogo -NoProfile -Command \
        '$ErrorActionPreference = "Stop"; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri $env:CODINGNS_DOWNLOAD_URL -OutFile $env:CODINGNS_DOWNLOAD_OUT'
    return
  fi

  return 1
}

path_or_parent_writable() {
  local target="$1"
  while [[ ! -e "$target" ]]; do
    target="$(dirname "$target")"
    if [[ "$target" == "/" ]]; then
      break
    fi
  done
  [[ -w "$target" ]]
}

read_major_version() {
  local version_text="$1"
  version_text="${version_text#v}"
  version_text="${version_text%%[^0-9.]*}"
  if [[ "$version_text" =~ ^([0-9]+) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  printf ''
}

is_supported_node_version() {
  local version_text="$1"
  local major_version=""
  local minor_version=""

  version_text="${version_text#v}"
  if [[ ! "$version_text" =~ ^([0-9]+)\.([0-9]+)(\.|$) ]]; then
    return 1
  fi

  major_version="${BASH_REMATCH[1]}"
  minor_version="${BASH_REMATCH[2]}"

  if (( major_version > MIN_NODE_MAJOR )); then
    return 0
  fi

  if (( major_version < MIN_NODE_MAJOR )); then
    return 1
  fi

  (( minor_version >= MIN_NODE_MINOR ))
}

localized_bool() {
  if [[ "$1" == "1" ]]; then
    msg yes_word
  else
    msg no_word
  fi
}

read_with_default() {
  local prompt="$1"
  local default_value="$2"
  local input=""
  local prompt_text=""

  if [[ "$LANG_MODE" == "zh" ]]; then
    prompt_text="$(printf '%s（默认：%s）：' "$prompt" "$default_value")"
  else
    prompt_text="$(printf '%s (Default: %s):' "$prompt" "$default_value")"
  fi

  prompt_read_line "$prompt_text " input
  input="$(trim "$input")"

  if [[ -z "$input" ]]; then
    printf '%s\n' "$default_value"
    return
  fi

  printf '%s\n' "$input"
}

read_yes_no() {
  local prompt="$1"
  local default_value="$2"
  local input=""
  local normalized_default=""
  local normalized_input=""
  local yes_suffix=""

  normalized_default="$(trim "$default_value")"

  if [[ "$LANG_MODE" == "zh" ]]; then
    yes_suffix="[Y/n]"
    [[ "$normalized_default" == "n" ]] && yes_suffix="[y/N]"
  else
    yes_suffix="[Y/n]"
    [[ "$normalized_default" == "n" ]] && yes_suffix="[y/N]"
  fi

  while true; do
    prompt_read_line "$(printf '%s %s: ' "$prompt" "$yes_suffix")" input
    input="$(trim "$input")"

    if [[ -z "$input" ]]; then
      input="$normalized_default"
    fi

    normalized_input="$(printf '%s' "$input" | tr '[:upper:]' '[:lower:]')"

    case "$normalized_input" in
      y|yes|1|shi|是)
        printf '1\n'
        return
        ;;
      n|no|0|fou|否)
        printf '0\n'
        return
        ;;
      *)
        if [[ "$LANG_MODE" == "zh" ]]; then
          say_warn_custom '请输入 y 或 n。'
        else
          say_warn_custom 'Please enter y or n.'
        fi
        ;;
    esac
  done
}

say_warn_custom() {
  printf '%s' "$(msg prefix)" >&2
  printf '%s\n' "$1" >&2
}

expand_path() {
  local raw_path="$1"

  case "$raw_path" in
    "~")
      printf '%s\n' "$HOME"
      ;;
    "~/"*)
      printf '%s/%s\n' "$HOME" "${raw_path#~/}"
      ;;
    [A-Za-z]:\\*|[A-Za-z]:/*)
      if is_windows_environment && command_exists cygpath; then
        cygpath -u "$raw_path"
      else
        printf '%s\n' "$raw_path"
      fi
      ;;
    /*)
      printf '%s\n' "$raw_path"
      ;;
    *)
      printf '%s/%s\n' "$(pwd)" "$raw_path"
      ;;
  esac
}

validate_port() {
  local port_text="$1"
  if [[ ! "$port_text" =~ ^[0-9]+$ ]]; then
    return 1
  fi

  local port_value=$((10#$port_text))
  (( port_value >= 1 && port_value <= 65535 ))
}

has_windows_native_build_tools() {
  command_exists cl && return 0
  command_exists msbuild && return 0
  command_exists vswhere && return 0
  [[ -x "/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe" ]] && return 0
  [[ -x "/c/Program Files/Microsoft Visual Studio/2022/BuildTools/MSBuild/Current/Bin/MSBuild.exe" ]] && return 0
  return 1
}

collect_prerequisite_issues() {
  PREREQUISITE_ISSUES=()
  PREREQUISITE_WARNINGS=()
  refresh_runtime_binaries

  local node_version="" npm_version="" node_major="" npm_major=""

  SYSTEM_NODE_BIN="$NODE_BIN"
  SYSTEM_NPM_BIN="$NPM_BIN"
  SYSTEM_NODE_VERSION=""
  SYSTEM_NODE_ABI=""

  if [[ -z "$NODE_BIN" ]]; then
    if ! is_windows_environment; then
      PREREQUISITE_ISSUES+=("error_no_node")
    fi
  else
    node_version="$("$NODE_BIN" -v 2>/dev/null || true)"
    SYSTEM_NODE_VERSION="$node_version"
    SYSTEM_NODE_ABI="$("$NODE_BIN" -p "process.versions.modules" 2>/dev/null | tr -d '\r' || true)"
    node_major="$(read_major_version "$node_version")"
    if [[ -z "$node_major" ]]; then
      PREREQUISITE_ISSUES+=("error_read_node_version|$node_version")
    elif ! is_supported_node_version "$node_version"; then
      PREREQUISITE_ISSUES+=("error_bad_node_version|$node_version")
    fi
  fi

  if [[ -z "$NPM_BIN" ]]; then
    if ! is_windows_environment; then
      PREREQUISITE_ISSUES+=("error_no_npm")
    fi
  else
    npm_version="$("$NPM_BIN" -v 2>/dev/null || true)"
    npm_major="$(read_major_version "$npm_version")"
    if [[ -z "$npm_major" ]]; then
      if ! is_windows_environment; then
        PREREQUISITE_ISSUES+=("error_read_npm_version|$npm_version")
      fi
    elif (( npm_major < 10 )) && ! is_windows_environment; then
      PREREQUISITE_ISSUES+=("error_bad_npm_version|$npm_version")
    fi
  fi

  if [[ "$(uname -s)" == "Linux" ]]; then
    command_exists make || PREREQUISITE_ISSUES+=("error_no_make")
    command_exists g++ || PREREQUISITE_ISSUES+=("error_no_cpp_compiler")
    command_exists python3 || PREREQUISITE_ISSUES+=("error_no_python3")
  fi

  if is_windows_environment; then
    if ! has_windows_native_build_tools; then
      PREREQUISITE_WARNINGS+=("warn_windows_missing_build_tools")
      PREREQUISITE_WARNINGS+=("warn_windows_registry_not_enough")
    fi

    if [[ -n "$node_major" ]] && (( node_major >= 24 )); then
      PREREQUISITE_WARNINGS+=("warn_windows_node24_native_modules|$node_version")
    fi
  fi

  if (( ${#PREREQUISITE_ISSUES[@]} > 0 )); then
    return 1
  fi

  return 0
}

print_prerequisite_issues() {
  local issue raw_key raw_arg
  say_warn info_prereq_missing_title
  for issue in "${PREREQUISITE_ISSUES[@]}"; do
    IFS='|' read -r raw_key raw_arg <<<"$issue"
    printf '%s' "$(msg prefix)" >&2
    printf -- '- ' >&2
    if [[ -n "${raw_arg:-}" ]]; then
      msg "$raw_key" "$raw_arg" >&2
    else
      msg "$raw_key" >&2
    fi
    printf '\n' >&2
  done
}

print_prerequisite_warnings() {
  local issue raw_key raw_arg
  for issue in "${PREREQUISITE_WARNINGS[@]}"; do
    IFS='|' read -r raw_key raw_arg <<<"$issue"
    if [[ -n "${raw_arg:-}" ]]; then
      say_warn "$raw_key" "$raw_arg"
    else
      say_warn "$raw_key"
    fi
  done
}

detect_brew_bin() {
  if command_exists brew; then
    command -v brew
    return
  fi

  if [[ -x "/opt/homebrew/bin/brew" ]]; then
    printf '%s\n' "/opt/homebrew/bin/brew"
    return
  fi

  if [[ -x "/usr/local/bin/brew" ]]; then
    printf '%s\n' "/usr/local/bin/brew"
    return
  fi

  printf '\n'
}

activate_brew_shellenv() {
  BREW_BIN="$(detect_brew_bin)"
  [[ -n "$BREW_BIN" ]] || die error_brew_install_failed

  if [[ "$DRY_RUN" == "1" ]]; then
    case "$BREW_BIN" in
      /opt/homebrew/bin/brew)
        export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"
        ;;
      /usr/local/bin/brew)
        export PATH="/usr/local/bin:/usr/local/sbin:$PATH"
        ;;
    esac
    return
  fi

  eval "$("$BREW_BIN" shellenv)"
}

supports_automatic_prerequisite_install() {
  local system_name
  system_name="$(uname -s)"

  case "$system_name" in
    Darwin)
      return 0
      ;;
    Linux)
      command_exists apt-get
      return
      ;;
    *)
      return 1
      ;;
  esac
}

install_prerequisites_macos() {
  if ! command_exists brew && [[ -z "$(detect_brew_bin)" ]]; then
    say_info info_installing_homebrew
    if [[ "$DRY_RUN" == "1" ]]; then
      say_info_custom "/bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
      BREW_BIN="/opt/homebrew/bin/brew"
    else
      NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || die error_brew_install_failed
    fi
  fi

  activate_brew_shellenv
  say_info info_installing_nodejs

  if [[ "$DRY_RUN" == "1" ]]; then
    say_info_custom "$BREW_BIN install node"
    say_info_custom "$BREW_BIN link --force --overwrite node"
    return
  fi

  if "$BREW_BIN" list node >/dev/null 2>&1; then
    "$BREW_BIN" upgrade node || "$BREW_BIN" install node
  else
    "$BREW_BIN" install node
  fi

  "$BREW_BIN" link --force --overwrite node >/dev/null 2>&1 || true

  hash -r
}

install_prerequisites_linux_apt() {
  say_info info_installing_nodejs
  say_info info_installing_linux_build_tools

  local apt_prefix=()
  local gpg_target_prefix=()
  local tee_prefix=()

  if is_root_user; then
    apt_prefix=()
    gpg_target_prefix=()
    tee_prefix=()
  else
    command_exists sudo || die error_no_sudo
    apt_prefix=(sudo)
    gpg_target_prefix=(sudo)
    tee_prefix=(sudo)
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    if is_root_user; then
      say_info_custom "apt-get update"
      say_info_custom "apt-get install -y ca-certificates curl gnupg build-essential python3"
      say_info_custom "mkdir -p /etc/apt/keyrings"
      say_info_custom "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg"
      say_info_custom "apt-get update"
      say_info_custom "apt-get install -y nodejs"
    else
      say_info_custom "sudo apt-get update"
      say_info_custom "sudo apt-get install -y ca-certificates curl gnupg build-essential python3"
      say_info_custom "sudo mkdir -p /etc/apt/keyrings"
      say_info_custom "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg"
      say_info_custom "sudo apt-get update"
      say_info_custom "sudo apt-get install -y nodejs"
    fi
    return
  fi

  "${apt_prefix[@]}" apt-get update
  "${apt_prefix[@]}" apt-get install -y ca-certificates curl gnupg build-essential python3
  "${apt_prefix[@]}" mkdir -p /etc/apt/keyrings
  "${apt_prefix[@]}" apt-get update
  "${apt_prefix[@]}" apt-get install -y nodejs
  hash -r
}

auto_install_prerequisites() {
  local system_name
  system_name="$(uname -s)"

  case "$system_name" in
    Darwin)
      install_prerequisites_macos
      ;;
    Linux)
      if ! command_exists apt-get; then
        die error_no_supported_linux_installer
      fi
      install_prerequisites_linux_apt
      ;;
    *)
      die error_prereq_auto_install_unsupported
      ;;
  esac
}

ensure_npm_install_context() {
  refresh_runtime_binaries

  NPM_GLOBAL_PREFIX="$(trim "$("$NPM_BIN" config get prefix 2>/dev/null || true)")"
  [[ -n "$NPM_GLOBAL_PREFIX" ]] || die error_read_prefix

  USE_SUDO_FOR_NPM="0"
  if ! path_or_parent_writable "$NPM_GLOBAL_PREFIX"; then
    if is_root_user; then
      USE_SUDO_FOR_NPM="0"
    elif command_exists sudo; then
      USE_SUDO_FOR_NPM="1"
      say_info info_need_sudo
    else
      die error_no_sudo
    fi
  fi
}

find_existing_install_state() {
  local data_dir="$1"
  local candidate=""

  for candidate in \
    "$data_dir/runtime/install-state.json" \
    "$data_dir/runtime/service/install-state.json"; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

read_existing_install_state() {
  local data_dir="$1"
  local state_path=""
  local state_line=""

  state_path="$(find_existing_install_state "$data_dir" || true)"
  [[ -n "$state_path" && -n "$NODE_BIN" ]] || return 1

  state_line="$($NODE_BIN - "$state_path" <<'EOF'
const fs = require("node:fs");

try {
  const state = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const version = typeof state.packageVersion === "string" ? state.packageVersion.trim() : "";
  const resolvedDataDir = typeof state.dataDir === "string" && state.dataDir.trim()
    ? state.dataDir.trim()
    : "";
  const port = Number.isInteger(state.port) ? String(state.port) : "";
  const autostart = state.autostartEnabled === true ? "1" : "0";
  process.stdout.write([version, resolvedDataDir, port, autostart].join("\t"));
} catch {
  process.exit(1);
}
EOF
  )"

  [[ -n "$state_line" ]] || return 1
  IFS=$'\t' read -r INSTALLED_PACKAGE_VERSION INSTALLED_DATA_DIR INSTALLED_PORT INSTALLED_AUTOSTART <<<"$state_line"
  [[ -n "$INSTALLED_PACKAGE_VERSION" ]] || return 1
  return 0
}

detect_existing_installation() {
  INSTALLED_PACKAGE_VERSION=""
  INSTALLED_DATA_DIR=""
  INSTALLED_PORT=""
  INSTALLED_AUTOSTART="0"
  PACKAGE_NAME="$(extract_package_name_from_spec "$PACKAGE_SPEC")"

  local default_data_dir=""
  default_data_dir="$(expand_path "$DEFAULT_DATA_DIR")"
  read_existing_install_state "$default_data_dir" || true

  if [[ -n "$INSTALLED_DATA_DIR" ]]; then
    INSTALLED_DATA_DIR="$(expand_path "$INSTALLED_DATA_DIR")"
  else
    INSTALLED_DATA_DIR="$default_data_dir"
  fi

  if [[ -z "$INSTALLED_PACKAGE_VERSION" ]]; then
    local package_root=""
    if [[ -n "$NPM_GLOBAL_PREFIX" ]]; then
      package_root="$(resolve_private_package_root_from_spec "$NPM_GLOBAL_PREFIX" "$PACKAGE_SPEC" 2>/dev/null || true)"
    fi
    if [[ -n "$package_root" && -f "$package_root/package.json" ]]; then
      CODINGNS_PACKAGE_ROOT="$package_root"
      INSTALLED_PACKAGE_VERSION="$(read_package_json_field "$package_root/package.json" "version" || true)"
    fi
  fi

  if [[ -z "$CODINGNS_PACKAGE_ROOT" && -n "$NPM_GLOBAL_PREFIX" ]]; then
    CODINGNS_PACKAGE_ROOT="$(resolve_private_package_root_from_spec "$NPM_GLOBAL_PREFIX" "$PACKAGE_SPEC" 2>/dev/null || true)"
  fi

  [[ -n "$INSTALLED_PACKAGE_VERSION" ]]
}

fetch_version_metadata() {
  VERSION_METADATA=""
  local registry_url="${ACTIVE_NPM_REGISTRY:-$OFFICIAL_NPM_REGISTRY}"
  VERSION_METADATA="$($NPM_BIN view "$PACKAGE_NAME" versions --json --registry "$registry_url" 2>/dev/null || true)"
  [[ -n "$VERSION_METADATA" && "$VERSION_METADATA" != "null" ]]
}

build_version_list() {
  local direction="$1"
  local include_development="$2"
  VERSION_LIST=()

  while IFS= read -r version; do
    [[ -n "$version" ]] || continue
    VERSION_LIST[${#VERSION_LIST[@]}]="$version"
  done < <(CODINGNS_VERSION_METADATA="$VERSION_METADATA" "$NODE_BIN" - "$INSTALLED_PACKAGE_VERSION" "$direction" "$include_development" <<'EOF'
const fs = require("node:fs");

const current = process.argv[2] || "0.0.0";
const direction = process.argv[3];
const includeDevelopment = process.argv[4] === "1";
const raw = process.env.CODINGNS_VERSION_METADATA ?? "";
let versions = [];

try {
  const parsed = JSON.parse(raw);
  versions = Array.isArray(parsed) ? parsed : [parsed];
} catch {
  process.exit(0);
}

function parse(value) {
  const match = String(value).trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return { raw: match[0], major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ?? "" };
}

function compare(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (!left.pre && !right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  const a = left.pre.split(".");
  const b = right.pre.split(".");
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    if (a[index] === b[index]) continue;
    const an = /^\d+$/.test(a[index]);
    const bn = /^\d+$/.test(b[index]);
    if (an && bn) return Number(a[index]) - Number(b[index]);
    if (an !== bn) return an ? -1 : 1;
    return a[index].localeCompare(b[index]);
  }
  return 0;
}

const currentParsed = parse(current);
if (!currentParsed) process.exit(0);
const selected = versions
  .map(parse)
  .filter(Boolean)
  .filter((version) => includeDevelopment || !version.pre)
  .filter((version) => direction === "upgrade" ? compare(version, currentParsed) > 0 : compare(version, currentParsed) < 0)
  .sort((left, right) => compare(right, left));

const limit = direction === "upgrade" ? 6 : 5;
for (const version of selected.slice(0, limit)) process.stdout.write(`${version.raw}\n`);
EOF
  )
}

has_development_versions() {
  CODINGNS_VERSION_METADATA="$VERSION_METADATA" "$NODE_BIN" <<'EOF'
const fs = require("node:fs");
try {
  const parsed = JSON.parse(process.env.CODINGNS_VERSION_METADATA ?? "");
  process.exit((Array.isArray(parsed) ? parsed : [parsed]).some((version) => /-/.test(String(version))) ? 0 : 1);
} catch {
  process.exit(1);
}
EOF
}

select_managed_version() {
  local action="$1"
  local include_development="0"
  local prompt_value=""
  local index=""

  if ! fetch_version_metadata; then
    say_warn info_version_source_failed
    return 1
  fi

  while true; do
    build_version_list "$action" "$include_development"
    if (( ${#VERSION_LIST[@]} == 0 )); then
      say_warn info_no_versions
      return 1
    fi

    if [[ "$action" == "upgrade" ]]; then
      say_info info_version_upgrade_title "$INSTALLED_PACKAGE_VERSION"
    else
      say_info info_version_downgrade_title "$INSTALLED_PACKAGE_VERSION"
    fi

    local version_number=1
    local version=""
    for version in "${VERSION_LIST[@]}"; do
      printf '%s) %s\n' "$version_number" "$version"
      version_number=$((version_number + 1))
    done

    if [[ "$include_development" == "0" ]] && has_development_versions; then
      printf '%s\n' "$(msg version_show_development)"
    fi
    printf '%s\n' "$(msg version_cancel)"
    prompt_read_line "$(msg prompt_version) [1]: " prompt_value
    prompt_value="$(trim "$prompt_value")"

    if [[ "$prompt_value" == "d" && "$include_development" == "0" ]]; then
      include_development="1"
      continue
    fi
    if [[ "$prompt_value" == "q" || "$prompt_value" == "" && ${#VERSION_LIST[@]} -eq 0 ]]; then
      return 1
    fi
    if [[ "$prompt_value" =~ ^[0-9]+$ ]]; then
      index=$((10#$prompt_value - 1))
      if (( index >= 0 && index < ${#VERSION_LIST[@]} )); then
        SELECTED_PACKAGE_VERSION="${VERSION_LIST[$index]}"
        say_info info_selected_version "$SELECTED_PACKAGE_VERSION"
        return 0
      fi
    fi
    say_warn_custom '请输入列表中的编号，或输入 d 查看开发版本。'
  done
}

choose_existing_install_action() {
  say_info info_existing_install "$INSTALLED_PACKAGE_VERSION" "$INSTALLED_DATA_DIR"
  printf '%s\n' "$(msg existing_action_upgrade)"
  printf '%s\n' "$(msg existing_action_downgrade)"
  printf '%s\n' "$(msg existing_action_uninstall)"
  printf '%s\n' "$(msg existing_action_cancel)"

  local choice=""
  prompt_read_line "$(msg prompt_existing_action) " choice
  choice="$(trim "$choice")"

  case "$choice" in
    1)
      MANAGEMENT_ACTION="upgrade"
      ;;
    2)
      MANAGEMENT_ACTION="downgrade"
      ;;
    3)
      MANAGEMENT_ACTION="uninstall"
      ;;
    *)
      MANAGEMENT_ACTION="cancel"
      ;;
  esac
}

prepare_windows_install_runtime() {
  if ! is_windows_environment; then
    return
  fi

  build_windows_runtime_paths
  ensure_windows_runtime_dirs
  # 依赖包已经提供跨 Node 主版本的预编译 N-API 二进制，Windows 不再下载私有 Node 运行时。
  refresh_runtime_binaries
  [[ -n "$NODE_BIN" ]] || die error_no_node
  [[ -n "$NPM_BIN" ]] || die error_no_npm
  TARGET_NODE_VERSION="$(read_node_version_text "$NODE_BIN")"
  TARGET_NODE_ABI="$(read_node_abi_text "$NODE_BIN")"
  NPM_GLOBAL_PREFIX="$PRIVATE_NPM_PREFIX"
  PRIVATE_INSTALL_CONTEXT="1"
  INSTALL_ENV_ARGS=(
    "PATH=${PRIVATE_NPM_PREFIX}:${SYSTEM_PATH_SNAPSHOT}"
    "npm_config_prefix=${PRIVATE_NPM_PREFIX}"
    "npm_config_cache=${PRIVATE_NPM_CACHE_DIR}"
    "npm_config_userconfig=${PRIVATE_NPM_USERCONFIG}"
    "CODINGNS_DATA_DIR=${SELECTED_DATA_DIR}"
    "CODINGNS_RUNTIME_ROOT=${RUNTIME_HOME}"
    "CODINGNS_RUNTIME_NODE_VERSION=${TARGET_NODE_VERSION}"
  )
  USE_SUDO_FOR_NPM="0"
}

ensure_prerequisites() {
  say_info info_prereq_check_title

  if ! collect_prerequisite_issues; then
    print_prerequisite_issues

    if ! supports_automatic_prerequisite_install; then
      die error_prereq_auto_install_unsupported
    fi

    if [[ "$(read_yes_no "$(msg prompt_auto_install_prereq)" "y")" != "1" ]]; then
      die error_prereq_auto_install_cancelled
    fi

    auto_install_prerequisites

    if ! collect_prerequisite_issues; then
      print_prerequisite_issues
      die error_prereq_auto_install_failed
    fi

    say_info info_auto_install_done
  fi

  if (( ${#PREREQUISITE_WARNINGS[@]} > 0 )); then
    print_prerequisite_warnings
  fi

  if ! is_windows_environment; then
    ensure_npm_install_context
  fi
}

detect_supported_clis() {
  CLI_SUMMARY_LINES=()
  INSTALLED_CLI_COUNT=0

  local spec provider_id label command_name command_path version_text
  for spec in "${SUPPORTED_CLIS[@]}"; do
    IFS='|' read -r provider_id label command_name <<<"$spec"
    command_path="$(command -v "$command_name" 2>/dev/null || true)"
    if [[ -n "$command_path" ]]; then
      version_text="$(read_cli_version "$command_name")"
      CLI_SUMMARY_LINES[${#CLI_SUMMARY_LINES[@]}]="- ${label}: ${version_text}"
      INSTALLED_CLI_COUNT=$((INSTALLED_CLI_COUNT + 1))
    else
      if [[ "$LANG_MODE" == "zh" ]]; then
        CLI_SUMMARY_LINES[${#CLI_SUMMARY_LINES[@]}]="- ${label}：未检测到"
      else
        CLI_SUMMARY_LINES[${#CLI_SUMMARY_LINES[@]}]="- ${label}: not detected"
      fi
    fi
  done
}

read_cli_version() {
  local command_name="$1"
  local output=""

  output="$("$command_name" --version 2>&1 | sed -n '1p' | tr -d '\r' || true)"
  if [[ -n "$(trim "$output")" ]]; then
    printf '%s\n' "$(trim "$output")"
    return
  fi

  output="$("$command_name" version 2>&1 | sed -n '1p' | tr -d '\r' || true)"
  if [[ -n "$(trim "$output")" ]]; then
    printf '%s\n' "$(trim "$output")"
    return
  fi

  output="$("$command_name" -v 2>&1 | sed -n '1p' | tr -d '\r' || true)"
  if [[ -n "$(trim "$output")" ]]; then
    printf '%s\n' "$(trim "$output")"
    return
  fi

  if [[ "$LANG_MODE" == "zh" ]]; then
    printf '%s\n' "已找到命令，版本未知"
  else
    printf '%s\n' "found, version unknown"
  fi
}

print_cli_summary() {
  say_info info_detect_clis
  local line
  for line in "${CLI_SUMMARY_LINES[@]}"; do
    printf '%s\n' "$line"
  done
}

collect_install_options() {
  while true; do
    SELECTED_PORT="$(read_with_default "$(msg prompt_port)" "$DEFAULT_PORT")"
    if validate_port "$SELECTED_PORT"; then
      break
    fi
    say_warn error_port_invalid
  done

  local raw_data_dir=""
  raw_data_dir="$(read_with_default "$(msg prompt_data_dir)" "$DEFAULT_DATA_DIR")"
  SELECTED_DATA_DIR="$(expand_path "$raw_data_dir")"

  detect_supported_clis
  print_cli_summary

  if (( INSTALLED_CLI_COUNT == 0 )); then
    say_warn info_no_cli
    say_warn info_recommend_opencode
    INSTALL_OPENCODE="$(read_yes_no "$(msg prompt_install_opencode)" "y")"
  else
    INSTALL_OPENCODE="0"
  fi

  INSTALL_CODINGNS="$(read_yes_no "$(msg prompt_install_codingns)" "y")"
  if [[ -n "${CODINGNS_INSTALL_DESKTOP_CLIENT:-}" ]]; then
    INSTALL_DESKTOP_CLIENT="$CODINGNS_INSTALL_DESKTOP_CLIENT"
  else
    INSTALL_DESKTOP_CLIENT="$(read_yes_no "$(msg prompt_install_desktop_client)" "n")"
  fi
  ENABLE_STARTUP="$(read_yes_no "$(msg prompt_enable_startup)" "y")"
}

print_install_summary() {
  printf '\n'
  say_info info_summary_title
  printf -- '- %s\n' "$(msg info_port "$SELECTED_PORT")"
  printf -- '- %s\n' "$(msg info_data_dir "$SELECTED_DATA_DIR")"
  if (( INSTALLED_CLI_COUNT == 0 )); then
    printf -- '- %s\n' "$(msg info_install_opencode "$(localized_bool "$INSTALL_OPENCODE")")"
  fi
  printf -- '- %s\n' "$(msg info_install_codingns "$(localized_bool "$INSTALL_CODINGNS")")"
  printf -- '- %s\n' "$(msg info_enable_startup "$(localized_bool "$ENABLE_STARTUP")")"
  if [[ "$INSTALL_DESKTOP_CLIENT" == "1" ]]; then
    printf -- '- %s\n' "$(msg prompt_install_desktop_client)"
  fi
}

probe_registry() {
  local registry_url="$1"
  local probe_package_spec=""
  probe_package_spec="$(resolve_registry_probe_package_spec)"
  if [[ "$PRIVATE_INSTALL_CONTEXT" == "1" ]]; then
    env "${INSTALL_ENV_ARGS[@]}" "$NPM_BIN" view "$probe_package_spec" version \
      --registry "$registry_url" \
      --fetch-retries=1 \
      --fetch-timeout=6000 \
      --silent >/dev/null 2>&1
    return
  fi

  "$NPM_BIN" view "$probe_package_spec" version \
    --registry "$registry_url" \
    --fetch-retries=1 \
    --fetch-timeout=6000 \
    --silent >/dev/null 2>&1
}

resolve_registry() {
  if probe_registry "$OFFICIAL_NPM_REGISTRY"; then
    ACTIVE_NPM_REGISTRY="$OFFICIAL_NPM_REGISTRY"
    say_info info_using_official_registry "$ACTIVE_NPM_REGISTRY"
    return
  fi

  say_warn warn_official_registry_failed

  if probe_registry "$MIRROR_NPM_REGISTRY"; then
    ACTIVE_NPM_REGISTRY="$MIRROR_NPM_REGISTRY"
    say_info info_using_mirror_registry "$ACTIVE_NPM_REGISTRY"
    return
  fi

  die error_registry_unavailable
}

run_with_optional_sudo() {
  if [[ "$USE_SUDO_FOR_NPM" == "1" ]]; then
    sudo "$@"
    return
  fi

  "$@"
}

create_install_log_file() {
  local base_dir=""
  local log_path=""

  if [[ "$PRIVATE_INSTALL_CONTEXT" == "1" && -n "$PRIVATE_INSTALL_LOG_DIR" ]]; then
    base_dir="$PRIVATE_INSTALL_LOG_DIR"
  else
    base_dir="${TMPDIR:-/tmp}"
  fi
  mkdir -p "$base_dir" >/dev/null 2>&1 || true

  if log_path="$(mktemp "$base_dir/codingns-install.XXXXXX.log" 2>/dev/null)"; then
    printf '%s\n' "$log_path"
    return
  fi

  if log_path="$(mktemp -t codingns-install.XXXXXX 2>/dev/null)"; then
    printf '%s\n' "$log_path"
    return
  fi

  log_path="$base_dir/codingns-install-$$.log"
  : > "$log_path"
  printf '%s\n' "$log_path"
}

diagnose_install_failure() {
  local package_label="$1"
  local log_path="$2"

  [[ -n "$log_path" && -f "$log_path" ]] || return
  [[ "$package_label" == "CodingNS" ]] || return

  if grep -Eq 'Could not find any Visual Studio installation to use|Desktop development with C\+\+' "$log_path"; then
    say_warn warn_windows_install_failed_vs
  fi

  if grep -Eq 'prebuild-install warn install (read ECONNRESET|Request timed out|No prebuilt binaries found)' "$log_path"; then
    say_warn warn_windows_install_failed_prebuild_network
    say_warn warn_windows_registry_not_enough
  fi

  say_warn warn_install_log_path "$log_path"
}

install_global_package_once() {
  local registry_url="$1"
  local package_spec="$2"
  local install_log=""

  if [[ "$DRY_RUN" == "1" ]]; then
    if [[ "$PRIVATE_INSTALL_CONTEXT" == "1" ]]; then
      say_info_custom "env ${INSTALL_ENV_ARGS[*]} \"$NPM_BIN\" install -g --registry $registry_url $package_spec"
    else
      say_info_custom "npm install -g --registry $registry_url $package_spec"
    fi
    return 0
  fi

  install_log="$(create_install_log_file)"
  LAST_INSTALL_LOG="$install_log"

  if [[ "$PRIVATE_INSTALL_CONTEXT" == "1" ]]; then
    env "${INSTALL_ENV_ARGS[@]}" npm_config_registry="$registry_url" \
      "$NPM_BIN" install -g "$package_spec" \
      --registry "$registry_url" \
      --fetch-retries=1 \
      --fetch-timeout=20000 \
      --foreground-scripts 2>&1 | tee "$install_log"
    return
  fi

  run_with_optional_sudo env npm_config_registry="$registry_url" \
    "$NPM_BIN" install -g "$package_spec" \
    --registry "$registry_url" \
    --fetch-retries=1 \
    --fetch-timeout=20000 \
    --foreground-scripts 2>&1 | tee "$install_log"
}

say_info_custom() {
  printf '%s%s\n' "$(msg prefix)" "$1"
}

install_global_package() {
  local package_spec="$1"
  local package_label="$2"

  if install_global_package_once "$ACTIVE_NPM_REGISTRY" "$package_spec"; then
    return
  fi

  if [[ "$ACTIVE_NPM_REGISTRY" == "$MIRROR_NPM_REGISTRY" ]]; then
    if [[ "$LANG_MODE" == "zh" ]]; then
      die_custom "$package_label 安装失败，请检查 npm 日志。"
    else
      die_custom "$package_label installation failed. Please check the npm logs."
    fi
  fi

  if [[ "$LANG_MODE" == "zh" ]]; then
    say_warn_custom "$package_label 在官方 npm 源安装失败，改用镜像重试。"
  else
    say_warn_custom "$package_label failed from the official npm registry. Retrying with the mirror."
  fi

  ACTIVE_NPM_REGISTRY="$MIRROR_NPM_REGISTRY"
  install_global_package_once "$ACTIVE_NPM_REGISTRY" "$package_spec" || {
    diagnose_install_failure "$package_label" "$LAST_INSTALL_LOG"
    if [[ "$LANG_MODE" == "zh" ]]; then
      die_custom "$package_label 在镜像源安装也失败了，请检查网络或权限。"
    else
      die_custom "$package_label also failed from the mirror. Please check your network or permissions."
    fi
  }
}

die_custom() {
  printf '%s%s\n' "$(msg prefix)" "$1" >&2
  exit 1
}

resolve_private_installed_binary() {
  local command_name="$1"

  [[ -n "$NPM_GLOBAL_PREFIX" ]] || return 1

  if is_windows_environment && [[ -f "$NPM_GLOBAL_PREFIX/${command_name}.cmd" ]]; then
    printf '%s\n' "$NPM_GLOBAL_PREFIX/${command_name}.cmd"
    return 0
  fi

  if [[ -x "$NPM_GLOBAL_PREFIX/$command_name" || -f "$NPM_GLOBAL_PREFIX/$command_name" ]]; then
    printf '%s\n' "$NPM_GLOBAL_PREFIX/$command_name"
    return 0
  fi

  if [[ -x "$NPM_GLOBAL_PREFIX/bin/$command_name" || -f "$NPM_GLOBAL_PREFIX/bin/$command_name" ]]; then
    printf '%s\n' "$NPM_GLOBAL_PREFIX/bin/$command_name"
    return 0
  fi

  return 1
}

resolve_installed_binary() {
  local command_name="$1"
  local candidate=""

  if [[ "$PRIVATE_INSTALL_CONTEXT" == "1" ]]; then
    resolve_private_installed_binary "$command_name" || printf '\n'
    return
  fi

  candidate="$(command -v "$command_name" 2>/dev/null || true)"
  if [[ -n "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return
  fi

  if [[ -x "$NPM_GLOBAL_PREFIX/bin/$command_name" ]]; then
    printf '%s\n' "$NPM_GLOBAL_PREFIX/bin/$command_name"
    return
  fi

  printf '\n'
}

resolve_realpath_fallback() {
  local target_path="$1"

  if command_exists realpath; then
    realpath "$target_path"
    return
  fi

  "$NODE_BIN" -e 'const fs=require("node:fs"); const path=require("node:path"); console.log(fs.realpathSync(path.resolve(process.argv[1])));' "$target_path"
}

resolve_codingns_script_path() {
  local binary_path="$1"
  local resolved_path=""
  local private_package_root=""
  local shim_target=""

  [[ -n "$binary_path" ]] || return 1
  [[ -n "$NODE_BIN" ]] || return 1

  if [[ "$PRIVATE_INSTALL_CONTEXT" == "1" ]]; then
    private_package_root="$(resolve_private_package_root_from_command_name "$NPM_GLOBAL_PREFIX" "codingns" || true)"
    if [[ -z "$private_package_root" ]]; then
      private_package_root="$(resolve_private_package_root_from_spec "$NPM_GLOBAL_PREFIX" "$PACKAGE_SPEC" || true)"
    fi
    if [[ -n "$private_package_root" && -f "$private_package_root/bin/codingns.mjs" ]]; then
      printf '%s\n' "$private_package_root/bin/codingns.mjs"
      return 0
    fi
  fi

  resolved_path="$(resolve_realpath_fallback "$binary_path" 2>/dev/null || true)"
  resolved_path="$(trim "$resolved_path")"

  if [[ -z "$resolved_path" ]]; then
    return 1
  fi

  if [[ "$resolved_path" == *.cmd || "$resolved_path" == *.ps1 ]]; then
    shim_target="$(resolve_script_from_npm_shim "$resolved_path" 2>/dev/null || true)"
    shim_target="$(trim "$shim_target")"
    if [[ -n "$shim_target" && -f "$shim_target" ]]; then
      printf '%s\n' "$shim_target"
      return 0
    fi
  fi

  if [[ ! -f "$resolved_path" ]]; then
    return 1
  fi

  printf '%s\n' "$resolved_path"
}

write_private_runtime_state() {
  if [[ "$PRIVATE_INSTALL_CONTEXT" != "1" ]]; then
    return
  fi

  local install_state_path="$PRIVATE_SERVICE_STATE_DIR/install-state.json"
  local previous_state_path="$PRIVATE_SERVICE_STATE_DIR/install-state.previous.json"
  local launch_env_path="$PRIVATE_SERVICE_STATE_DIR/launch-env.json"

  mkdir -p "$PRIVATE_SERVICE_STATE_DIR"

  if [[ -f "$install_state_path" ]]; then
    cp "$install_state_path" "$previous_state_path"
  fi

  CODINGNS_STATE_PACKAGE_NAME="${CODINGNS_PACKAGE_NAME:-$PACKAGE_SPEC}" \
  CODINGNS_STATE_PACKAGE_VERSION="${CODINGNS_PACKAGE_VERSION}" \
  CODINGNS_STATE_PTY_PACKAGE_NAME="${CODINGNS_PTY_PACKAGE_NAME}" \
  CODINGNS_STATE_PTY_PACKAGE_VERSION="${CODINGNS_PTY_PACKAGE_VERSION}" \
  CODINGNS_STATE_SQLITE_PACKAGE_NAME="${CODINGNS_SQLITE_PACKAGE_NAME}" \
  CODINGNS_STATE_SQLITE_PACKAGE_VERSION="${CODINGNS_SQLITE_PACKAGE_VERSION}" \
  CODINGNS_STATE_PACKAGE_SPEC="${PACKAGE_SPEC}" \
  CODINGNS_STATE_REGISTRY="${ACTIVE_NPM_REGISTRY}" \
  CODINGNS_STATE_NODE_VERSION="$(normalize_version_text "${TARGET_NODE_VERSION:-unknown}")" \
  CODINGNS_STATE_NODE_EXE="${NODE_BIN}" \
  CODINGNS_STATE_NPM_CMD="${NPM_BIN}" \
  CODINGNS_STATE_NPM_PREFIX="${NPM_GLOBAL_PREFIX}" \
  CODINGNS_STATE_CODINGNS_COMMAND="${CODINGNS_BIN}" \
  CODINGNS_STATE_DATA_DIR="${SELECTED_DATA_DIR}" \
  CODINGNS_STATE_PORT="${SELECTED_PORT}" \
  CODINGNS_STATE_INSTALLED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    "$NODE_BIN" - "$install_state_path" <<'EOF'
const fs = require("node:fs");

const outputPath = process.argv[2];
const payload = {
  schemaVersion: 1,
  packageName: process.env.CODINGNS_STATE_PACKAGE_NAME ?? "",
  packageVersion: process.env.CODINGNS_STATE_PACKAGE_VERSION ?? "",
  ptyPackageName: process.env.CODINGNS_STATE_PTY_PACKAGE_NAME ?? "",
  ptyPackageVersion: process.env.CODINGNS_STATE_PTY_PACKAGE_VERSION ?? "",
  sqlitePackageName: process.env.CODINGNS_STATE_SQLITE_PACKAGE_NAME ?? "",
  sqlitePackageVersion: process.env.CODINGNS_STATE_SQLITE_PACKAGE_VERSION ?? "",
  packageSpec: process.env.CODINGNS_STATE_PACKAGE_SPEC ?? "",
  registry: process.env.CODINGNS_STATE_REGISTRY ?? "",
  nodeVersion: process.env.CODINGNS_STATE_NODE_VERSION ?? "",
  nodeExe: process.env.CODINGNS_STATE_NODE_EXE ?? "",
  npmCmd: process.env.CODINGNS_STATE_NPM_CMD ?? "",
  npmPrefix: process.env.CODINGNS_STATE_NPM_PREFIX ?? "",
  codingnsCommand: process.env.CODINGNS_STATE_CODINGNS_COMMAND ?? "",
  dataDir: process.env.CODINGNS_STATE_DATA_DIR ?? "",
  port: Number(process.env.CODINGNS_STATE_PORT ?? "0"),
  installedAt: process.env.CODINGNS_STATE_INSTALLED_AT ?? ""
};

fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
EOF

  CODINGNS_LAUNCH_PATH="${PRIVATE_NPM_PREFIX}:${SYSTEM_PATH_SNAPSHOT}" \
  CODINGNS_LAUNCH_NPM_PREFIX="${PRIVATE_NPM_PREFIX}" \
  CODINGNS_LAUNCH_NPM_CACHE="${PRIVATE_NPM_CACHE_DIR}" \
  CODINGNS_LAUNCH_NPM_USERCONFIG="${PRIVATE_NPM_USERCONFIG}" \
  CODINGNS_LAUNCH_DATA_DIR="${SELECTED_DATA_DIR}" \
  CODINGNS_LAUNCH_RUNTIME_ROOT="${RUNTIME_HOME}" \
  CODINGNS_LAUNCH_RUNTIME_NODE_VERSION="${TARGET_NODE_VERSION}" \
    "$NODE_BIN" - "$launch_env_path" <<'EOF'
const fs = require("node:fs");

const outputPath = process.argv[2];
const payload = {
  PATH: process.env.CODINGNS_LAUNCH_PATH ?? "",
  npm_config_prefix: process.env.CODINGNS_LAUNCH_NPM_PREFIX ?? "",
  npm_config_cache: process.env.CODINGNS_LAUNCH_NPM_CACHE ?? "",
  npm_config_userconfig: process.env.CODINGNS_LAUNCH_NPM_USERCONFIG ?? "",
  CODINGNS_DATA_DIR: process.env.CODINGNS_LAUNCH_DATA_DIR ?? "",
  CODINGNS_RUNTIME_ROOT: process.env.CODINGNS_LAUNCH_RUNTIME_ROOT ?? "",
  CODINGNS_RUNTIME_NODE_VERSION: process.env.CODINGNS_LAUNCH_RUNTIME_NODE_VERSION ?? "",
};

fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
EOF
}

collect_access_urls() {
  local port="$1"

  if [[ -z "$NODE_BIN" ]]; then
    printf '%s\n' "http://127.0.0.1:${port}/"
    printf '%s\n' "http://localhost:${port}/"
    return
  fi

  "$NODE_BIN" - "$port" <<'EOF'
const os = require("node:os");

const port = process.argv[2];
const urls = new Set([
  `http://127.0.0.1:${port}/`,
  `http://localhost:${port}/`
]);

const hostname = os.hostname().trim();
if (hostname && hostname !== "localhost") {
  urls.add(`http://${hostname}:${port}/`);
}

for (const entries of Object.values(os.networkInterfaces())) {
  for (const entry of entries ?? []) {
    if (!entry || entry.internal) {
      continue;
    }

    const family = typeof entry.family === "string" ? entry.family : `IPv${entry.family}`;

    if (family === "IPv4") {
      urls.add(`http://${entry.address}:${port}/`);
      continue;
    }

    if (family === "IPv6" && !entry.address.startsWith("fe80:")) {
      urls.add(`http://[${entry.address}]:${port}/`);
    }
  }
}

for (const url of urls) {
  console.log(url);
}
EOF
}

ensure_registry_if_needed() {
  if [[ "$INSTALL_CODINGNS" == "1" ]]; then
    resolve_registry
  fi
}

install_opencode_if_requested() {
  if [[ "$INSTALL_OPENCODE" != "1" ]]; then
    return
  fi

  if ! command_exists curl; then
    say_warn warn_opencode_install_requires_curl
    return
  fi

  say_info info_installing_opencode

  if [[ "$DRY_RUN" == "1" ]]; then
    say_info_custom "curl -fsSL https://opencode.ai/install | bash"
    return
  fi

  if curl -fsSL https://opencode.ai/install | bash; then
    say_info info_opencode_installed
    return
  fi

  say_warn warn_opencode_install_failed
}

# 重新安装时，正在运行的服务会锁住旧的安装目录（Windows 上 npm 直接报 EBUSY），先停掉再装。
# 停不掉也不拦着安装：后面 npm 或健康检查会给出更具体的错。
stop_running_host_before_install() {
  local installer_script=""
  installer_script="$(resolve_host_installer_script || true)"
  [[ -n "$installer_script" && -n "$NODE_BIN" ]] || return 0

  local -a args=("stop")

  if [[ -n "$SELECTED_DATA_DIR" ]]; then
    args+=("--data-dir" "$SELECTED_DATA_DIR")
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    say_info_custom "node $installer_script ${args[*]}"
    return 0
  fi

  "$NODE_BIN" "$installer_script" "${args[@]}" >/dev/null 2>&1 || true
}

install_or_resolve_codingns() {
  if [[ "$INSTALL_CODINGNS" == "1" ]]; then
    say_info info_installing_codingns
    stop_running_host_before_install
    install_global_package "$PACKAGE_SPEC" "CodingNS"
    CODINGNS_BIN="$(resolve_installed_binary "codingns")"
    [[ -n "$CODINGNS_BIN" ]] || die error_no_codingns_after_install
  else
    say_info info_skip_codingns
    CODINGNS_BIN="$(resolve_installed_binary "codingns")"
    [[ -n "$CODINGNS_BIN" ]] || die error_skip_codingns_without_existing
  fi

  CODINGNS_SCRIPT="$(resolve_codingns_script_path "$CODINGNS_BIN" || true)"
  [[ -n "$CODINGNS_SCRIPT" ]] || die error_no_codingns_after_install

  CODINGNS_PACKAGE_ROOT="$(resolve_private_package_root_from_command_name "$NPM_GLOBAL_PREFIX" "codingns" || true)"
  if [[ -z "$CODINGNS_PACKAGE_ROOT" ]]; then
    CODINGNS_PACKAGE_ROOT="$(resolve_private_package_root_from_spec "$NPM_GLOBAL_PREFIX" "$PACKAGE_SPEC" || true)"
  fi
  if [[ -z "$CODINGNS_PACKAGE_ROOT" && -n "$CODINGNS_SCRIPT" ]]; then
    CODINGNS_PACKAGE_ROOT="$(dirname "$(dirname "$CODINGNS_SCRIPT")")"
  fi

  if [[ -n "$CODINGNS_PACKAGE_ROOT" && -f "$CODINGNS_PACKAGE_ROOT/package.json" ]]; then
    CODINGNS_PACKAGE_NAME="$(read_package_json_field "$CODINGNS_PACKAGE_ROOT/package.json" "name" || true)"
    CODINGNS_PACKAGE_VERSION="$(read_package_json_field "$CODINGNS_PACKAGE_ROOT/package.json" "version" || true)"
  fi

  if [[ -z "$CODINGNS_PACKAGE_NAME" ]]; then
    local local_package_spec_dir=""
    local metadata_path=""
    local_package_spec_dir="$(resolve_local_package_spec_dir "$PACKAGE_SPEC" || true)"
    metadata_path="$local_package_spec_dir/.codingns-install-metadata.json"
    if [[ -f "$metadata_path" ]]; then
      CODINGNS_PACKAGE_NAME="$(read_install_metadata_field "$metadata_path" "packageName" || true)"
      CODINGNS_PACKAGE_VERSION="$(read_install_metadata_field "$metadata_path" "packageVersion" || true)"
    fi
  fi

  if [[ -z "$CODINGNS_PACKAGE_NAME" && -n "$CODINGNS_SCRIPT" ]]; then
    local resolved_package_root=""
    resolved_package_root="$(dirname "$(dirname "$CODINGNS_SCRIPT")")"
    if [[ -f "$resolved_package_root/package.json" ]]; then
      CODINGNS_PACKAGE_ROOT="$resolved_package_root"
      CODINGNS_PACKAGE_NAME="$(read_package_json_field "$resolved_package_root/package.json" "name" || true)"
      CODINGNS_PACKAGE_VERSION="$(read_package_json_field "$resolved_package_root/package.json" "version" || true)"
    fi
  fi

  [[ -n "$CODINGNS_PACKAGE_NAME" ]] || CODINGNS_PACKAGE_NAME="$(extract_package_name_from_spec "$PACKAGE_SPEC")"
  resolve_codingns_pty_dependency_metadata
  resolve_codingns_sqlite_dependency_metadata
}

refresh_deepseek_harness_launcher() {
  local launcher_script="$INSTALL_SCRIPT_DIR/scripts/ensure-deepseek-harness-launcher.mjs"
  [[ -f "$launcher_script" ]] || return 0
  [[ -d "$DEEPSEEK_HARNESS_ROOT" ]] || return 0

  if [[ "$DRY_RUN" == "1" ]]; then
    say_info_custom "node $launcher_script $DEEPSEEK_HARNESS_ROOT $DEEPSEEK_HARNESS_BIN"
    return 0
  fi

  if ! "$NODE_BIN" "$launcher_script" "$DEEPSEEK_HARNESS_ROOT" "$DEEPSEEK_HARNESS_BIN"; then
    say_warn_custom "DeepSeek Harness 稳定 dsh 入口更新失败，保留现有入口。"
  fi
}

resolve_host_installer_script() {
  local candidate=""
  local -a candidates=(
    "$INSTALL_SCRIPT_DIR/packages/codingns/scripts/host-install.mjs"
    "${CODINGNS_PACKAGE_ROOT:-}/scripts/host-install.mjs"
  )

  for candidate in "${candidates[@]}"; do
    [[ -n "$candidate" && -f "$candidate" ]] || continue
    printf '%s\n' "$candidate"
    return 0
  done

  return 1
}

run_host_installer_setup() {
  local installer_script=""
  installer_script="$(resolve_host_installer_script || true)"
  [[ -n "$installer_script" ]] || return 1
  [[ -n "$NODE_BIN" ]] || return 1

  local -a args=(
    "install"
    "--data-dir" "$SELECTED_DATA_DIR"
    "--port" "$SELECTED_PORT"
    "--install-prefix" "$NPM_GLOBAL_PREFIX"
    "--reuse-existing"
  )

  if [[ "$ENABLE_STARTUP" == "1" ]]; then
    args+=("--autostart")
  fi

  say_info info_using_host_installer

  if [[ "$DRY_RUN" == "1" ]]; then
    say_info_custom "node $installer_script ${args[*]}"
    return 0
  fi

  if "$NODE_BIN" "$installer_script" "${args[@]}"; then
    return 0
  fi

  return 1
}

run_host_installer_uninstall() {
  local installer_script=""
  installer_script="$(resolve_host_installer_script || true)"
  [[ -n "$installer_script" && -n "$NODE_BIN" ]] || return 1

  local -a args=("uninstall" "--data-dir" "$SELECTED_DATA_DIR")
  if [[ "${PURGE_DATA:-0}" == "1" ]]; then
    args+=("--purge")
  fi

  say_info info_uninstalling
  if [[ "$DRY_RUN" == "1" ]]; then
    say_info_custom "node $installer_script ${args[*]}"
    return 0
  fi

  # 统一安装器必须以当前用户运行，否则 sudo 会把 HOME 切到 root，导致
  # launchd/systemd/计划任务清理落到错误的用户目录。系统前缀下的包目录
  # 由统一安装器按安全路径规则单独删除。
  "$NODE_BIN" "$installer_script" "${args[@]}"
}

run_existing_installation_management() {
  SELECTED_DATA_DIR="$INSTALLED_DATA_DIR"
  SELECTED_PORT="${INSTALLED_PORT:-$DEFAULT_PORT}"
  ENABLE_STARTUP="$INSTALLED_AUTOSTART"
  INSTALL_CODINGNS="1"
  INSTALL_OPENCODE="0"
  INSTALL_DESKTOP_CLIENT="0"
  INSTALLED_CLI_COUNT="1"

  choose_existing_install_action
  if is_windows_environment; then
    prepare_windows_install_runtime
  fi
  if [[ -z "$CODINGNS_PACKAGE_ROOT" && -n "$NPM_GLOBAL_PREFIX" ]]; then
    CODINGNS_PACKAGE_ROOT="$(resolve_private_package_root_from_spec "$NPM_GLOBAL_PREFIX" "$PACKAGE_SPEC" 2>/dev/null || true)"
  fi
  case "$MANAGEMENT_ACTION" in
    cancel)
      say_info prompt_aborted
      exit 0
      ;;
    uninstall)
      PURGE_DATA="$(read_yes_no "$(msg prompt_purge_data)" "n")"
      if ! run_host_installer_uninstall; then
        die error_host_installer_failed
      fi
      say_info info_uninstalled
      if [[ "$PURGE_DATA" != "1" ]]; then
        say_info info_uninstall_keep_data "$SELECTED_DATA_DIR"
      fi
      exit 0
      ;;
    upgrade|downgrade)
      ensure_registry_if_needed
      if ! select_managed_version "$MANAGEMENT_ACTION"; then
        exit 0
      fi
      PACKAGE_SPEC="${PACKAGE_NAME}@${SELECTED_PACKAGE_VERSION}"
      ;;
  esac
}

resolve_desktop_release_asset_url() {
  local pattern="$1"
  local api_url="https://api.github.com/repos/jingyi0605/CodingNS/releases/latest"
  local payload=""

  payload="$(curl -fsSL "$api_url" 2>/dev/null || true)"
  [[ -n "$payload" ]] || return 1

  printf '%s' "$payload" \
    | tr ',' '\n' \
    | grep -o 'https://[^"]*'"$pattern" \
    | head -1
}

install_desktop_client_macos() {
  local url=""
  local tmp_dir=""
  local mount_point=""
  local app_source=""
  url="$(resolve_desktop_release_asset_url '\.dmg')"

  if [[ -z "$url" ]]; then
    say_warn_custom "$(msg warn_desktop_client_download_failed)"
    return 0
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    say_info_custom "下载 ${url} 后挂载 dmg，并把 CodingNS.app 复制到 $HOME/Applications"
    return 0
  fi

  say_info_custom "$(msg info_desktop_client_downloading)"
  tmp_dir="$(mktemp -d)"

  if ! curl -fL --retry 2 -o "$tmp_dir/CodingNS.dmg" "$url"; then
    say_warn_custom "$(msg warn_desktop_client_download_failed)"
    rm -rf "$tmp_dir"
    return 0
  fi

  mount_point="$(hdiutil attach "$tmp_dir/CodingNS.dmg" -nobrowse -readonly 2>/dev/null | tail -1 | awk '{print $NF}')"

  if [[ -z "$mount_point" || ! -d "$mount_point" ]]; then
    say_warn_custom "$(msg warn_desktop_client_install_failed)"
    rm -rf "$tmp_dir"
    return 0
  fi

  app_source="$(find "$mount_point" -maxdepth 1 -name "*.app" | head -1)"
  mkdir -p "$HOME/Applications"

  if [[ -n "$app_source" ]] && cp -R "$app_source" "$HOME/Applications/"; then
    say_info_custom "$(msg info_desktop_client_installed "$HOME/Applications")"
  else
    say_warn_custom "$(msg warn_desktop_client_install_failed)"
  fi

  hdiutil detach "$mount_point" >/dev/null 2>&1 || true
  rm -rf "$tmp_dir"
}

install_desktop_client_windows() {
  local url=""
  local tmp_file=""
  url="$(resolve_desktop_release_asset_url '\.exe')"

  if [[ -z "$url" ]]; then
    say_warn_custom "$(msg warn_desktop_client_download_failed)"
    return 0
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    say_info_custom "下载 $url 并静默安装桌面客户端"
    return 0
  fi

  say_info_custom "$(msg info_desktop_client_downloading)"
  tmp_file="$(mktemp -t codingns-desktop-client-XXXXXX.exe)"

  if ! curl -fL --retry 2 -o "$tmp_file" "$url"; then
    say_warn_custom "$(msg warn_desktop_client_download_failed)"
    rm -f "$tmp_file"
    return 0
  fi

  if "$tmp_file" /S; then
    say_info_custom "$(msg info_desktop_client_installed "$LOCALAPPDATA")"
  else
    say_warn_custom "$(msg warn_desktop_client_install_failed)"
  fi

  rm -f "$tmp_file"
}

# 桌面客户端装失败只提示，不影响已经装好的服务端。
install_desktop_client_if_requested() {
  [[ "$INSTALL_DESKTOP_CLIENT" == "1" ]] || return 0

  case "$(uname -s)" in
    Darwin)
      install_desktop_client_macos
      ;;
    MINGW* | MSYS* | CYGWIN*)
      install_desktop_client_windows
      ;;
    *)
      say_warn_custom "$(msg warn_desktop_client_unsupported)"
      ;;
  esac
}

print_success_summary() {
  printf '\n'
  say_info info_done
  printf -- '- %s\n' "$(msg info_data_dir "$SELECTED_DATA_DIR")"

  if [[ "$ACTIVE_NPM_REGISTRY" != "" ]]; then
    printf -- '- %s\n' "$(msg info_registry "$ACTIVE_NPM_REGISTRY")"
  fi
  if [[ "$PRIVATE_INSTALL_CONTEXT" == "1" ]]; then
    printf -- '- %s\n' "$(msg info_runtime_node "${TARGET_NODE_VERSION:-unknown}")"
    printf -- '- %s\n' "$(msg info_runtime_prefix "$NPM_GLOBAL_PREFIX")"
    if [[ -n "$CODINGNS_PTY_PACKAGE_NAME" ]]; then
      local runtime_pty_summary="$CODINGNS_PTY_PACKAGE_NAME"
      if [[ -n "$CODINGNS_PTY_PACKAGE_VERSION" ]]; then
        runtime_pty_summary="${runtime_pty_summary}@${CODINGNS_PTY_PACKAGE_VERSION}"
      fi
      printf -- '- %s\n' "$(msg info_runtime_pty "$runtime_pty_summary")"
    fi
    if [[ -n "$CODINGNS_SQLITE_PACKAGE_NAME" ]]; then
      local runtime_sqlite_summary="$CODINGNS_SQLITE_PACKAGE_NAME"
      if [[ -n "$CODINGNS_SQLITE_PACKAGE_VERSION" ]]; then
        runtime_sqlite_summary="${runtime_sqlite_summary}@${CODINGNS_SQLITE_PACKAGE_VERSION}"
      fi
      printf -- '- %s\n' "$(msg info_runtime_sqlite "$runtime_sqlite_summary")"
    fi
  fi

  printf '\n'
  say_info info_access_title
  while IFS= read -r access_url; do
    [[ -n "$access_url" ]] || continue
    printf -- '- %s\n' "$access_url"
  done < <(collect_access_urls "$SELECTED_PORT")

  printf '\n'
  say_info info_password_title
  printf -- '- %s\n' "$(msg info_password_none)"
  printf -- '- %s\n' "$(msg info_password_setup_hint)"

  printf '\n'
  say_info_custom "$(msg info_managed_by_installer)"
  printf -- '- %s\n' "$(msg info_installer_service_hint)"
  printf -- '- %s\n' "$(msg info_installer_state_hint)"

  printf '\n'
  say_info info_open_docs_title
  printf '%s\n' "$(msg info_docs_link)"
}

main() {
  init_prompt_input
  choose_language
  ensure_prerequisites

  SELECTED_DATA_DIR="$(expand_path "$DEFAULT_DATA_DIR")"
  if detect_existing_installation; then
    run_existing_installation_management
    if [[ "$MANAGEMENT_ACTION" == "cancel" || "$MANAGEMENT_ACTION" == "uninstall" ]]; then
      exit 0
    fi
    print_install_summary
  else
    say_info info_intro "$PACKAGE_SPEC"
    collect_install_options
    print_install_summary
  fi

  if [[ "$(read_yes_no "$(msg prompt_confirm_plan)" "y")" != "1" ]]; then
    say_info prompt_aborted
    exit 0
  fi

  printf '\n'
  say_info info_begin
  install_opencode_if_requested
  prepare_windows_install_runtime
  ensure_registry_if_needed
  install_or_resolve_codingns
  refresh_deepseek_harness_launcher

  if ! run_host_installer_setup; then
    die error_host_installer_failed
  fi

  write_private_runtime_state

  install_desktop_client_if_requested
  print_success_summary
}

main "$@"
