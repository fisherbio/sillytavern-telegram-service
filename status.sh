#!/bin/bash

set -u

DOMAIN="gui/$(id -u)"
LOG_DIR="${STTG_LOG_DIR:-$HOME/Library/Logs}"
FAILED=0

for label in \
    com.local.sillytavern.server \
    com.local.sillytavern.telegram-bridge \
    com.local.sillytavern.telegram-browser; do
    if launchctl print "$DOMAIN/$label" >/dev/null 2>&1; then
        printf '✓ %s 已加载\n' "$label"
    else
        printf '✗ %s 未加载\n' "$label"
        FAILED=1
    fi
done

if curl -fsS --max-time 2 http://127.0.0.1:8000/ >/dev/null 2>&1; then
    printf '✓ SillyTavern HTTP 服务正常\n'
else
    printf '! SillyTavern 当前未运行（可在 Telegram 中使用 /wake）\n'
fi

if command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 2333 >/dev/null 2>&1; then
    printf '✓ Telegram 桥接端口仅在本机监听\n'
else
    printf '✗ Telegram 桥接端口不可用\n'
    FAILED=1
fi

if [ "$FAILED" -ne 0 ]; then
    printf '\n最近的错误日志：\n'
    for log in \
        "$LOG_DIR/SillyTavernServer.error.log" \
        "$LOG_DIR/SillyTavernTelegramBridge.error.log" \
        "$LOG_DIR/SillyTavernTelegramBrowser.error.log"; do
        if [ -s "$log" ]; then
            printf '\n--- %s ---\n' "$log"
            tail -n 12 "$log"
        fi
    done
fi

exit "$FAILED"
