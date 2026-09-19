#!/bin/bash
#
# CodingNS Android 构建脚本
# 支持 debug / release 两种模式，仅构建 arm64 架构
#
# 用法:
#   ./build-android.sh              # 默认构建 release
#   ./build-android.sh debug        # 构建 debug 版本
#   ./build-android.sh release      # 构建 release 版本（需要签名密钥）
#

set -euo pipefail

# ============================================
# 配置
# ============================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
USER_APP_DIR="$REPO_DIR/apps/user-app"
TAURI_DIR="$USER_APP_DIR/src-tauri"
ANDROID_DIR="$TAURI_DIR/gen/android"
KEYSTORE_DIR="${ANDROID_KEYSTORE_DIR:-$TAURI_DIR/target}"
KEYSTORE_PATH_OVERRIDE="${ANDROID_KEYSTORE_PATH:-}"
KEYSTORE="$KEYSTORE_DIR/codingns-release.jks"
KEY_PROPERTIES="$ANDROID_DIR/app/key.properties"
KEY_ALIAS="${ANDROID_KEY_ALIAS:-codingns}"
KEYSTORE_PASS="${ANDROID_KEYSTORE_PASSWORD:-}"
KEY_PASSWORD="${ANDROID_KEY_PASSWORD:-}"
EXPECTED_CERT_SHA256="${ANDROID_SIGNING_CERT_SHA256:-}"
KEYSTORE_CERT_SHA256=""
KEYSTORE_IS_TEMP=0

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# ============================================
# 工具函数
# ============================================
log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

is_ci() {
    [[ "${CI:-}" == "true" || "${GITHUB_ACTIONS:-}" == "true" ]]
}

normalize_fingerprint() {
    # 指纹可能带冒号、短横线或换行，统一成 64 位大写十六进制字符串。
    printf '%s' "$1" | tr -d '[:space:]:-' | tr '[:lower:]' '[:upper:]'
}

configure_keystore_path() {
    if [[ -n "$KEYSTORE_PATH_OVERRIDE" ]]; then
        KEYSTORE="$KEYSTORE_PATH_OVERRIDE"
        KEYSTORE_DIR="$(dirname "$KEYSTORE")"
        return 0
    fi

    if is_ci || [[ -n "${ANDROID_KEYSTORE_BASE64:-}" ]]; then
        # CI 和 base64 注入都使用临时目录，避免 release 密钥进入 Rust 缓存或构建产物。
        local temp_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
        KEYSTORE_DIR="$temp_root/codingns-android-signing-$$"
        KEYSTORE="$KEYSTORE_DIR/codingns-release.jks"
        KEYSTORE_IS_TEMP=1
    fi
}

# ============================================
# 环境检测与配置
# ============================================
setup_env() {
    # JAVA_HOME: 优先级 环境变量 > brew openjdk@21
    if [[ -z "${JAVA_HOME:-}" ]]; then
        local brew_jdk="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
        if [[ -d "$brew_jdk" ]]; then
            export JAVA_HOME="$brew_jdk"
            log_info "JAVA_HOME -> $JAVA_HOME"
        else
            log_error "未找到 JDK，请安装: brew install openjdk@21"
            exit 1
        fi
    fi

    # ANDROID_HOME
    if [[ -z "${ANDROID_HOME:-}" ]]; then
        export ANDROID_HOME="$HOME/Library/Android/sdk"
    fi
    if [[ ! -d "$ANDROID_HOME/cmdline-tools" ]]; then
        log_error "未找到 Android SDK cmdline-tools: $ANDROID_HOME/cmdline-tools"
        log_error "请通过 Android Studio 或 sdkmanager 安装"
        exit 1
    fi

    # NDK_HOME: 自动检测最新稳定版
    if [[ -z "${NDK_HOME:-}" ]]; then
        local ndk_dir="$ANDROID_HOME/ndk"
        if [[ -d "$ndk_dir" ]]; then
            local latest_ndk=$(ls "$ndk_dir" 2>/dev/null | grep -v "rc" | sort -V | tail -1)
            if [[ -n "$latest_ndk" ]]; then
                export NDK_HOME="$ndk_dir/$latest_ndk"
            fi
        fi
    fi

    log_info "JAVA_HOME    = $JAVA_HOME"
    log_info "ANDROID_HOME = $ANDROID_HOME"
    log_info "NDK_HOME     = ${NDK_HOME:-未设置}"
}

# ============================================
# 签名密钥
# ============================================
check_release_signing_inputs() {
    configure_keystore_path

    if is_ci; then
        local missing=()

        [[ -n "${ANDROID_KEYSTORE_BASE64:-}" || -n "$KEYSTORE_PATH_OVERRIDE" ]] || missing+=("ANDROID_KEYSTORE_BASE64")
        [[ -n "$KEYSTORE_PASS" ]] || missing+=("ANDROID_KEYSTORE_PASSWORD")
        [[ -n "${ANDROID_KEY_ALIAS:-}" ]] || missing+=("ANDROID_KEY_ALIAS")
        [[ -n "${ANDROID_KEY_PASSWORD:-}" ]] || missing+=("ANDROID_KEY_PASSWORD")
        [[ -n "$EXPECTED_CERT_SHA256" ]] || missing+=("ANDROID_SIGNING_CERT_SHA256")

        if [[ "${#missing[@]}" -gt 0 ]]; then
            log_error "CI 缺少 Android release 签名配置: ${missing[*]}"
            log_error "禁止在 CI 中自动生成临时密钥，请配置持久化 keystore 和证书指纹。"
            return 1
        fi
    fi
}

decode_keystore_secret() {
    local encoded="${ANDROID_KEYSTORE_BASE64:-}"
    encoded="$(printf '%s' "$encoded" | tr -d '\r\n')"

    mkdir -p "$KEYSTORE_DIR"

    if printf '%s' "$encoded" | base64 --decode > "$KEYSTORE" 2>/dev/null; then
        :
    elif printf '%s' "$encoded" | base64 -D > "$KEYSTORE" 2>/dev/null; then
        :
    else
        log_error "ANDROID_KEYSTORE_BASE64 不是有效的 base64 keystore"
        return 1
    fi

    if [[ ! -s "$KEYSTORE" ]]; then
        log_error "解码后的 Android keystore 为空"
        return 1
    fi

    chmod 600 "$KEYSTORE"
}

validate_keystore() {
    local keytool="$JAVA_HOME/bin/keytool"
    local fingerprint=""

    if [[ ! -x "$keytool" ]]; then
        log_error "未找到 keytool: $keytool"
        return 1
    fi

    if ! "$keytool" -J-Duser.language=en -J-Duser.country=US \
        -list -keystore "$KEYSTORE" -storepass "$KEYSTORE_PASS" -alias "$KEY_ALIAS" \
        >/dev/null 2>&1; then
        log_error "无法使用当前密码和别名打开 Android release keystore"
        log_error "请检查 ANDROID_KEYSTORE_PASSWORD、ANDROID_KEY_ALIAS 和 ANDROID_KEY_PASSWORD"
        return 1
    fi

    fingerprint="$("$keytool" -J-Duser.language=en -J-Duser.country=US \
        -list -v -keystore "$KEYSTORE" -storepass "$KEYSTORE_PASS" -alias "$KEY_ALIAS" \
        2>/dev/null | awk -F': ' '/SHA256:/{print $2; exit}')"
    KEYSTORE_CERT_SHA256="$(normalize_fingerprint "$fingerprint")"

    if [[ ! "$KEYSTORE_CERT_SHA256" =~ ^[0-9A-F]{64}$ ]]; then
        log_error "无法从 Android release keystore 读取 SHA-256 证书指纹"
        return 1
    fi

    log_success "Android release 证书 SHA-256: $KEYSTORE_CERT_SHA256"

    if [[ -n "$EXPECTED_CERT_SHA256" ]]; then
        local expected="$(normalize_fingerprint "$EXPECTED_CERT_SHA256")"
        if [[ "$expected" != "$KEYSTORE_CERT_SHA256" ]]; then
            log_error "Android release keystore 指纹与预期不一致"
            log_error "预期: $expected"
            log_error "实际: $KEYSTORE_CERT_SHA256"
            return 1
        fi
    fi
}

ensure_keystore() {
    check_release_signing_inputs

    if [[ -n "${ANDROID_KEYSTORE_BASE64:-}" ]]; then
        log_info "从 CI Secret 解码 Android release keystore..."
        decode_keystore_secret
    elif [[ -f "$KEYSTORE" ]]; then
        if [[ -z "$KEYSTORE_PASS" ]]; then
            # 保留已有本地开发密钥的兼容性；CI 永远不会走这个默认值。
            KEYSTORE_PASS="codingns123"
        fi
        log_success "使用已有 Android release keystore: $KEYSTORE"
    elif [[ "${ANDROID_GENERATE_KEYSTORE:-0}" == "1" ]]; then
        if [[ -z "$KEYSTORE_PASS" ]]; then
            log_error "生成 keystore 前必须设置 ANDROID_KEYSTORE_PASSWORD"
            return 1
        fi
        if [[ -z "$KEY_PASSWORD" ]]; then
            KEY_PASSWORD="$KEYSTORE_PASS"
        fi

        mkdir -p "$KEYSTORE_DIR"
        log_info "按显式请求生成本地 release 签名密钥..."
        "$JAVA_HOME/bin/keytool" -genkeypair -v \
            -keystore "$KEYSTORE" \
            -storetype JKS \
            -keyalg RSA -keysize 2048 -validity 10000 \
            -alias "$KEY_ALIAS" \
            -storepass "$KEYSTORE_PASS" \
            -keypass "$KEY_PASSWORD" \
            -dname "CN=CodingNS,OU=Dev,O=CodingNS,L=Beijing,ST=Beijing,C=CN"

        log_success "本地 release 签名密钥已生成: $KEYSTORE"
    else
        log_error "未找到 Android release keystore: $KEYSTORE"
        log_error "本地请提供已有密钥，或显式设置 ANDROID_GENERATE_KEYSTORE=1 后再生成。"
        return 1
    fi

    if [[ -z "$KEY_PASSWORD" ]]; then
        KEY_PASSWORD="$KEYSTORE_PASS"
    fi

    validate_keystore
}

# 写入 key.properties（构建前调用，构建后清理）
write_key_properties() {
    mkdir -p "$(dirname "$KEY_PROPERTIES")"
    (
        umask 077
        cat > "$KEY_PROPERTIES" << EOF
storeFile=$KEYSTORE
storePassword=$KEYSTORE_PASS
keyAlias=$KEY_ALIAS
keyPassword=$KEY_PASSWORD
EOF
    )
}

clean_key_properties() {
    rm -f "$KEY_PROPERTIES"
}

clean_signing_files() {
    clean_key_properties

    if [[ "$KEYSTORE_IS_TEMP" -eq 1 && -f "$KEYSTORE" ]]; then
        rm -f "$KEYSTORE"
        rmdir "$KEYSTORE_DIR" 2>/dev/null || true
    fi
}

# ============================================
# 依赖检查
# ============================================
check_android_targets() {
    local targets=("aarch64-linux-android")
    for t in "${targets[@]}"; do
        if ! rustup target list --installed | grep -q "$t"; then
            log_info "安装 Rust target: $t"
            rustup target add "$t"
        fi
    done
    log_success "Android Rust targets 已就绪"
}

install_deps() {
    cd "$REPO_DIR"

    if [[ -d "$REPO_DIR/node_modules" && -d "$USER_APP_DIR/node_modules" ]]; then
        log_info "工作区依赖已存在，跳过 pnpm install"
        return 0
    fi

    log_info "安装项目依赖..."
    pnpm install --frozen-lockfile 2>/dev/null || pnpm install --no-frozen-lockfile
    log_success "依赖安装完成"
}

find_apksigner() {
    local candidate=""

    if [[ -n "${ANDROID_BUILD_TOOLS_VERSION:-}" && -x "$ANDROID_HOME/build-tools/$ANDROID_BUILD_TOOLS_VERSION/apksigner" ]]; then
        printf '%s' "$ANDROID_HOME/build-tools/$ANDROID_BUILD_TOOLS_VERSION/apksigner"
        return 0
    fi

    if [[ -d "$ANDROID_HOME/build-tools" ]]; then
        candidate="$(find "$ANDROID_HOME/build-tools" -maxdepth 2 -type f -name apksigner 2>/dev/null | sort -V | tail -1)"
    fi

    if [[ -n "$candidate" && -x "$candidate" ]]; then
        printf '%s' "$candidate"
    fi
}

verify_release_apk_signature() {
    local apk_path="$ANDROID_DIR/app/build/outputs/apk/universal/release/app-universal-release.apk"
    local apksigner=""
    local signer_output=""
    local apk_cert_sha256=""

    if [[ ! -f "$apk_path" ]]; then
        log_error "未找到 Android release APK，无法校验签名: $apk_path"
        return 1
    fi

    apksigner="$(find_apksigner)"
    if [[ -z "$apksigner" ]]; then
        if is_ci; then
            log_error "CI 未找到 apksigner，无法确认 release APK 的签名"
            return 1
        fi
        log_warn "本机未找到 apksigner，跳过 APK 签名复核"
        return 0
    fi

    if ! signer_output="$("$apksigner" verify --print-certs "$apk_path" 2>&1)"; then
        log_error "Android release APK 签名校验失败"
        printf '%s\n' "$signer_output" >&2
        return 1
    fi

    apk_cert_sha256="$(printf '%s\n' "$signer_output" | awk -F': ' '/certificate SHA-256 digest:/{print $2; exit}')"
    apk_cert_sha256="$(normalize_fingerprint "$apk_cert_sha256")"

    if [[ "$apk_cert_sha256" != "$KEYSTORE_CERT_SHA256" ]]; then
        log_error "APK 签名证书与 release keystore 不一致"
        log_error "keystore: $KEYSTORE_CERT_SHA256"
        log_error "APK:      $apk_cert_sha256"
        return 1
    fi

    if [[ -n "$EXPECTED_CERT_SHA256" && "$(normalize_fingerprint "$EXPECTED_CERT_SHA256")" != "$apk_cert_sha256" ]]; then
        log_error "APK 签名证书与预期发布指纹不一致"
        log_error "预期: $(normalize_fingerprint "$EXPECTED_CERT_SHA256")"
        log_error "实际: $apk_cert_sha256"
        return 1
    fi

    log_success "Android release APK 签名校验通过: $apk_cert_sha256"
}

# ============================================
# 构建
# ============================================
build_debug() {
    log_info "============================================"
    log_info "构建 Android Debug APK (arm64)"
    log_info "============================================"

    cd "$USER_APP_DIR"
    pnpm tauri android build --debug -t aarch64 --apk
    print_output "debug"
}

build_release() {
    log_info "============================================"
    log_info "构建 Android Release APK (arm64)"
    log_info "============================================"

    trap clean_signing_files EXIT
    ensure_keystore
    write_key_properties

    cd "$USER_APP_DIR"
    if ! pnpm tauri android build -t aarch64 --apk; then
        log_error "构建失败"
        return 1
    fi

    verify_release_apk_signature
    print_output "release"
    clean_signing_files
    trap - EXIT
}

# ============================================
# 输出
# ============================================
print_output() {
    local mode="$1"
    local apk_dir="$ANDROID_DIR/app/build/outputs/apk"

    echo ""
    log_success "============================================"
    log_success "构建完成！"
    log_success "============================================"

    local found=0
    for apk in $(find "$apk_dir" -name "*.apk" 2>/dev/null); do
        local size=$(du -h "$apk" | cut -f1 | tr -d ' ')
        log_success "  $apk  ($size)"
        found=1
    done

    if [[ $found -eq 0 ]]; then
        log_warn "未找到 APK 文件，请检查构建日志"
    fi
}

# ============================================
# 主程序
# ============================================
print_banner() {
    echo ""
    echo "╔═══════════════════════════════════════════╗"
    echo "║      CodingNS Android 构建脚本            ║"
    echo "╚═══════════════════════════════════════════╝"
    echo ""
}

print_usage() {
    echo "用法:"
    echo "  $0              默认构建 release"
    echo "  $0 debug        构建 debug 版本"
    echo "  $0 release      构建 release 版本（需签名密钥）"
    echo "  $0 help         显示帮助"
    echo ""
    echo "默认本地签名密钥位置: $KEYSTORE"
    echo "CI 必须注入固定的 ANDROID_KEYSTORE_BASE64，不会自动生成临时密钥"
    echo "本地首次生成请显式设置 ANDROID_GENERATE_KEYSTORE=1"
    echo ""
}

main() {
    print_banner

    local mode="${1:-release}"

    case "$mode" in
        help|--help|-h)
            print_usage
            exit 0
            ;;
        debug|release)
            ;;
        *)
            log_error "未知模式: $mode (可选: debug | release)"
            exit 1
            ;;
    esac

    if [[ "$mode" == "release" ]]; then
        check_release_signing_inputs
    fi

    setup_env
    check_android_targets
    install_deps

    case "$mode" in
        debug)   build_debug   ;;
        release) build_release ;;
    esac
}

main "$@"
