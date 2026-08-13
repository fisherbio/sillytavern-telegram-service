#!/bin/bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
DEPLOY_HOME="${STTG_HOME:-$HOME}"
SILLYTAVERN_DIR="${STTG_SILLYTAVERN_DIR:-$DEPLOY_HOME/SillyTavern}"
APP_DIR="${STTG_APP_DIR:-$DEPLOY_HOME/Library/Application Support/SillyTavernTelegramBridge}"
EXTENSION_DIR="${STTG_EXTENSION_DIR:-$SILLYTAVERN_DIR/data/default-user/extensions/st-telegram-safe}"
LAUNCH_AGENTS_DIR="${STTG_LAUNCH_AGENTS_DIR:-$DEPLOY_HOME/Library/LaunchAgents}"
LOG_DIR="${STTG_LOG_DIR:-$DEPLOY_HOME/Library/Logs}"
TEST_MODE="${STTG_TEST_MODE:-0}"
ASSUME_YES="${STTG_YES:-0}"
RECONFIGURE=0

BRIDGE_LABEL="com.local.sillytavern.telegram-bridge"
BROWSER_LABEL="com.local.sillytavern.telegram-browser"
SERVER_LABEL="com.local.sillytavern.server"

usage() {
    cat <<'EOF'
用法：./install.sh [--reconfigure] [--yes]

  --reconfigure  重新输入 Telegram Bot Token，并生成新的本机桥接密钥
  --yes          自动同意安装缺少的 Homebrew、Node.js 和 Google Chrome
  -h, --help     显示帮助

可选环境变量：
  STTG_TELEGRAM_TOKEN  非交互式提供 Bot Token
  STTG_PAIRING_CODE    指定一次性配对码；不指定时自动生成
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --reconfigure) RECONFIGURE=1 ;;
        --yes) ASSUME_YES=1 ;;
        -h|--help) usage; exit 0 ;;
        *) printf '未知参数：%s\n' "$1" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m错误：\033[0m %s\n' "$*" >&2; exit 1; }

confirm() {
    if [ "$ASSUME_YES" = "1" ]; then return 0; fi
    printf '%s [y/N] ' "$1"
    read -r answer
    case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

refresh_brew_path() {
    if [ -x /opt/homebrew/bin/brew ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [ -x /usr/local/bin/brew ]; then
        eval "$(/usr/local/bin/brew shellenv)"
    fi
}

ensure_homebrew() {
    refresh_brew_path
    if command -v brew >/dev/null 2>&1; then return; fi
    confirm '未检测到 Homebrew。是否从 Homebrew 官方安装脚本自动安装？' \
        || die '需要 Homebrew 来自动安装 Node.js 或 Google Chrome。'
    info '安装 Homebrew'
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    refresh_brew_path
    command -v brew >/dev/null 2>&1 || die 'Homebrew 安装后仍无法找到 brew。请重新打开终端再运行本脚本。'
}

node_is_supported() {
    command -v node >/dev/null 2>&1 || return 1
    node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'
}

ensure_node() {
    if node_is_supported; then return; fi
    ensure_homebrew
    confirm '需要 Node.js 20 或更高版本。是否通过 Homebrew 安装/升级？' \
        || die 'Node.js 版本不符合要求。'
    info '安装 Node.js'
    brew install node
    hash -r
    node_is_supported || die 'Node.js 安装失败或版本低于 20。'
}

ensure_chrome() {
    local chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    if [ -x "$chrome" ]; then return; fi
    ensure_homebrew
    confirm '未检测到 Google Chrome。是否通过 Homebrew 安装？' \
        || die '专用无头浏览器需要 Google Chrome。'
    info '安装 Google Chrome'
    brew install --cask google-chrome
    [ -x "$chrome" ] || die 'Google Chrome 安装失败。'
}

random_hex() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex "$1"
    else
        node -e "process.stdout.write(require('node:crypto').randomBytes($1).toString('hex'))"
    fi
}

install_sillytavern() {
    if [ -f "$SILLYTAVERN_DIR/server.js" ] && [ -f "$SILLYTAVERN_DIR/package.json" ]; then
        ok "复用现有 SillyTavern：$SILLYTAVERN_DIR"
    else
        command -v git >/dev/null 2>&1 || die '缺少 git。请先安装 Xcode Command Line Tools。'
        [ ! -e "$SILLYTAVERN_DIR" ] || die "$SILLYTAVERN_DIR 已存在，但不是有效的 SillyTavern 目录。"
        info "安装 SillyTavern 官方 release 分支到 $SILLYTAVERN_DIR"
        git clone --depth 1 --branch release https://github.com/SillyTavern/SillyTavern.git "$SILLYTAVERN_DIR"
    fi

    if [ "$TEST_MODE" != "1" ]; then
        info '安装 SillyTavern 依赖'
        (cd "$SILLYTAVERN_DIR" && npm install --no-audit --no-fund)
    fi
}

install_bridge_files() {
    info '部署 Telegram 桥接程序和 SillyTavern 扩展'
    mkdir -p "$APP_DIR" "$EXTENSION_DIR" "$LAUNCH_AGENTS_DIR" "$LOG_DIR"

    install -m 0644 "$SCRIPT_DIR/bridge.js" "$APP_DIR/bridge.js"
    install -m 0644 "$SCRIPT_DIR/browser-keeper.js" "$APP_DIR/browser-keeper.js"
    install -m 0644 "$SCRIPT_DIR/package.json" "$APP_DIR/package.json"
    install -m 0644 "$SCRIPT_DIR/package-lock.json" "$APP_DIR/package-lock.json"

    install -m 0644 "$SCRIPT_DIR/browser-index.js" "$EXTENSION_DIR/index.js"
    install -m 0644 "$SCRIPT_DIR/manifest.json" "$EXTENSION_DIR/manifest.json"
    install -m 0644 "$SCRIPT_DIR/settings.html" "$EXTENSION_DIR/settings.html"
    install -m 0644 "$SCRIPT_DIR/style.css" "$EXTENSION_DIR/style.css"

    if [ "$TEST_MODE" != "1" ]; then
        info '安装桥接程序依赖'
        (cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund)
    fi
}

configure_secrets() {
    local config_path="$APP_DIR/config.json"
    local extension_config="$EXTENSION_DIR/bridge-config.js"
    local token pairing secret

    if [ -f "$config_path" ] && [ "$RECONFIGURE" != "1" ]; then
        secret="$(node -e 'const c=require(process.argv[1]); process.stdout.write(String(c.bridgeSecret||""))' "$config_path")"
        [ "${#secret}" -ge 32 ] || die "现有 $config_path 中的 bridgeSecret 无效；请使用 --reconfigure。"
        ok '保留现有 Telegram Token、配对用户和桥接密钥'
    else
        token="${STTG_TELEGRAM_TOKEN:-}"
        if [ -z "$token" ]; then
            [ -t 0 ] || die '非交互运行时请设置 STTG_TELEGRAM_TOKEN。'
            printf '请输入 BotFather 提供的 Telegram Bot Token（输入不会显示）：'
            read -r -s token
            printf '\n'
        fi
        [ -n "$token" ] || die 'Telegram Bot Token 不能为空。'
        case "$token" in *:*) ;; *) die 'Bot Token 格式不正确，应包含冒号。' ;; esac

        pairing="${STTG_PAIRING_CODE:-$(random_hex 4)}"
        secret="$(random_hex 32)"
        STTG_WRITE_TOKEN="$token" STTG_WRITE_PAIRING="$pairing" STTG_WRITE_SECRET="$secret" \
            node -e '
                const fs = require("node:fs");
                const path = process.argv[1];
                const config = {
                    telegramToken: process.env.STTG_WRITE_TOKEN,
                    allowedUserId: null,
                    pairingCode: process.env.STTG_WRITE_PAIRING,
                    bridgeSecret: process.env.STTG_WRITE_SECRET,
                    listenHost: "127.0.0.1",
                    listenPort: 2333,
                };
                fs.writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
            ' "$config_path"
        chmod 0600 "$config_path"
        if [ "$RECONFIGURE" = "1" ]; then
            printf '{}\n' > "$APP_DIR/state.json"
            chmod 0600 "$APP_DIR/state.json"
        fi
        unset token
    fi

    printf "export const BRIDGE_URL = 'ws://127.0.0.1:2333';\nexport const BRIDGE_SECRET = '%s';\n" \
        "$secret" > "$extension_config"
    chmod 0600 "$extension_config"

    pairing="${pairing:-$(node -e 'const c=require(process.argv[1]); process.stdout.write(String(c.pairingCode||""))' "$config_path")}"
    local paired_user
    paired_user="$(node -e '
        const fs = require("node:fs");
        const config = require(process.argv[1]);
        let state = {};
        try { state = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); } catch {}
        process.stdout.write(String(config.allowedUserId || state.allowedUserId || ""));
    ' "$config_path" "$APP_DIR/state.json")"
    if [ -z "$paired_user" ] && [ -n "$pairing" ]; then
        printf '\n一次性配对码：\033[1;36m%s\033[0m\n' "$pairing"
        printf '机器人启动后，请在 Telegram 中发送：\033[1m/start %s\033[0m\n\n' "$pairing"
    fi
}

render_plist() {
    local template="$1" destination="$2" node_bin="$3" deploy_user="$4"
    PLIST_TEMPLATE="$template" PLIST_DESTINATION="$destination" PLIST_HOME="$DEPLOY_HOME" \
        PLIST_NODE="$node_bin" PLIST_USER="$deploy_user" PLIST_SILLYTAVERN="$SILLYTAVERN_DIR" node -e '
            const fs = require("node:fs");
            const xml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
            let text = fs.readFileSync(process.env.PLIST_TEMPLATE, "utf8");
            text = text.replaceAll("__HOME__", xml(process.env.PLIST_HOME))
                .replaceAll("__NODE__", xml(process.env.PLIST_NODE))
                .replaceAll("__USER__", xml(process.env.PLIST_USER))
                .replaceAll("__SILLYTAVERN__", xml(process.env.PLIST_SILLYTAVERN));
            fs.writeFileSync(process.env.PLIST_DESTINATION, text);
        '
    chmod 0644 "$destination"
    if command -v plutil >/dev/null 2>&1; then plutil -lint "$destination" >/dev/null; fi
}

install_launch_agents() {
    local node_bin deploy_user
    node_bin="${STTG_NODE:-$(command -v node)}"
    node_bin="$(cd "$(dirname "$node_bin")" && pwd -P)/$(basename "$node_bin")"
    deploy_user="${STTG_USER:-$(id -un)}"

    info '生成 macOS LaunchAgent'
    render_plist "$SCRIPT_DIR/com.local.sillytavern.server.plist" \
        "$LAUNCH_AGENTS_DIR/$SERVER_LABEL.plist" "$node_bin" "$deploy_user"
    render_plist "$SCRIPT_DIR/com.local.sillytavern.telegram-bridge.plist" \
        "$LAUNCH_AGENTS_DIR/$BRIDGE_LABEL.plist" "$node_bin" "$deploy_user"
    render_plist "$SCRIPT_DIR/com.local.sillytavern.telegram-browser.plist" \
        "$LAUNCH_AGENTS_DIR/$BROWSER_LABEL.plist" "$node_bin" "$deploy_user"
}

load_launch_agents() {
    [ "$TEST_MODE" != "1" ] || return 0
    local domain="gui/$(id -u)" label
    info '加载并启动后台服务'

    for label in "$BROWSER_LABEL" "$BRIDGE_LABEL" "$SERVER_LABEL"; do
        launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
    done
    launchctl bootstrap "$domain" "$LAUNCH_AGENTS_DIR/$SERVER_LABEL.plist"
    launchctl bootstrap "$domain" "$LAUNCH_AGENTS_DIR/$BRIDGE_LABEL.plist"
    launchctl bootstrap "$domain" "$LAUNCH_AGENTS_DIR/$BROWSER_LABEL.plist"

    if ! curl -fsS --max-time 2 http://127.0.0.1:8000/ >/dev/null 2>&1; then
        launchctl kickstart -k "$domain/$SERVER_LABEL"
    fi
}

wait_for_http() {
    [ "$TEST_MODE" != "1" ] || return 0
    local attempts=0
    info '等待 SillyTavern 和桥接服务就绪'
    while [ "$attempts" -lt 60 ]; do
        if curl -fsS --max-time 2 http://127.0.0.1:8000/ >/dev/null 2>&1; then
            ok 'SillyTavern 已在 http://127.0.0.1:8000 运行'
            return 0
        fi
        attempts=$((attempts + 1))
        sleep 1
    done
    warn "SillyTavern 未在 60 秒内就绪，请查看 $LOG_DIR/SillyTavernServer.error.log"
    return 0
}

print_status() {
    if [ "$TEST_MODE" = "1" ]; then
        ok '测试模式部署完成'
        return
    fi
    local domain="gui/$(id -u)" label
    for label in "$SERVER_LABEL" "$BRIDGE_LABEL" "$BROWSER_LABEL"; do
        if launchctl print "$domain/$label" >/dev/null 2>&1; then
            ok "$label 已加载"
        else
            warn "$label 未加载"
        fi
    done
    printf '\n部署完成。常用诊断命令：\n  %s/status.sh\n' "$SCRIPT_DIR"
}

if [ "$TEST_MODE" != "1" ]; then
    [ "$(uname -s)" = 'Darwin' ] || die '当前一键部署脚本仅支持 macOS。'
fi

info 'SillyTavern Telegram 服务一键部署'
ensure_node
if [ "$TEST_MODE" != "1" ]; then ensure_chrome; fi
install_sillytavern
install_bridge_files
configure_secrets
install_launch_agents
load_launch_agents
wait_for_http
print_status
