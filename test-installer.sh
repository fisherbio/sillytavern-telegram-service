#!/bin/bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd -P)"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT

FAKE_HOME="$TEMP_ROOT/home"
FAKE_ST="$FAKE_HOME/SillyTavern"
FAKE_APP="$FAKE_HOME/Library/Application Support/SillyTavernTelegramBridge"
FAKE_EXT="$FAKE_ST/data/default-user/extensions/st-telegram-safe"
FAKE_AGENTS="$FAKE_HOME/Library/LaunchAgents"

mkdir -p "$FAKE_ST"
printf '/* fake SillyTavern server */\n' > "$FAKE_ST/server.js"
printf '{"name":"fake-sillytavern"}\n' > "$FAKE_ST/package.json"

STTG_TEST_MODE=1 \
STTG_HOME="$FAKE_HOME" \
STTG_TELEGRAM_TOKEN='TEST_BOT_ID:NOT_A_REAL_TOKEN' \
STTG_PAIRING_CODE='testpair' \
STTG_NODE="$(command -v node)" \
"$ROOT/install.sh" >/dev/null

for file in \
    "$FAKE_APP/bridge.js" \
    "$FAKE_APP/browser-keeper.js" \
    "$FAKE_APP/config.json" \
    "$FAKE_EXT/index.js" \
    "$FAKE_EXT/manifest.json" \
    "$FAKE_EXT/bridge-config.js" \
    "$FAKE_AGENTS/com.local.sillytavern.server.plist" \
    "$FAKE_AGENTS/com.local.sillytavern.telegram-bridge.plist" \
    "$FAKE_AGENTS/com.local.sillytavern.telegram-browser.plist"; do
    [ -f "$file" ] || { printf 'missing %s\n' "$file" >&2; exit 1; }
done

if rg -n '__HOME__|__NODE__|__USER__|__SILLYTAVERN__' "$FAKE_AGENTS" >/dev/null; then
    printf 'plist placeholders were not replaced\n' >&2
    exit 1
fi

CONFIG_MODE="$(stat -f '%Lp' "$FAKE_APP/config.json")"
EXT_CONFIG_MODE="$(stat -f '%Lp' "$FAKE_EXT/bridge-config.js")"
[ "$CONFIG_MODE" = '600' ] || { printf 'config mode is %s\n' "$CONFIG_MODE" >&2; exit 1; }
[ "$EXT_CONFIG_MODE" = '600' ] || { printf 'extension config mode is %s\n' "$EXT_CONFIG_MODE" >&2; exit 1; }

node - "$FAKE_APP/config.json" "$FAKE_EXT/bridge-config.js" <<'NODE'
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const browserConfig = fs.readFileSync(process.argv[3], 'utf8');
if (config.telegramToken !== 'TEST_BOT_ID:NOT_A_REAL_TOKEN') throw new Error('token mismatch');
if (config.pairingCode !== 'testpair') throw new Error('pairing code mismatch');
if (!config.bridgeSecret || config.bridgeSecret.length !== 64) throw new Error('invalid secret');
if (!browserConfig.includes(config.bridgeSecret)) throw new Error('bridge secrets do not match');
NODE

printf '{"allowedUserId":12345}\n' > "$FAKE_APP/state.json"
STTG_TEST_MODE=1 \
STTG_HOME="$FAKE_HOME" \
STTG_TELEGRAM_TOKEN='OTHER_TEST_ID:SHOULD_NOT_REPLACE_EXISTING' \
STTG_NODE="$(command -v node)" \
"$ROOT/install.sh" >/dev/null

node - "$FAKE_APP/config.json" "$FAKE_APP/state.json" <<'NODE'
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const state = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
if (config.telegramToken !== 'TEST_BOT_ID:NOT_A_REAL_TOKEN') throw new Error('reinstall replaced token');
if (state.allowedUserId !== 12345) throw new Error('reinstall replaced state');
NODE

STTG_TEST_MODE=1 \
STTG_HOME="$FAKE_HOME" \
STTG_TELEGRAM_TOKEN='NEW_TEST_ID:RECONFIGURED_TOKEN' \
STTG_PAIRING_CODE='newpair' \
STTG_NODE="$(command -v node)" \
"$ROOT/install.sh" --reconfigure >/dev/null

node - "$FAKE_APP/config.json" "$FAKE_APP/state.json" <<'NODE'
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const state = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
if (config.telegramToken !== 'NEW_TEST_ID:RECONFIGURED_TOKEN') throw new Error('reconfigure did not replace token');
if (config.pairingCode !== 'newpair') throw new Error('reconfigure did not replace pairing code');
if (Object.keys(state).length !== 0) throw new Error('reconfigure did not reset pairing state');
NODE

printf 'installer_tests=12\n'
