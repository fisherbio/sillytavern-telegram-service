'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { promisify } = require('node:util');
const { WebSocket, WebSocketServer } = require('ws');

const APP_DIR = __dirname;
const CONFIG_PATH = path.join(APP_DIR, 'config.json');
const STATE_PATH = path.join(APP_DIR, 'state.json');
const MTPROTO_CONFIG_PATH = path.join(APP_DIR, 'mtproto-config.json');
const MTPROTO_CLEAR_SCRIPT_PATH = path.join(APP_DIR, 'mtproto-clear.py');
const MTPROTO_PYTHON_PATH = path.join(APP_DIR, '.venv-mtproto', 'bin', 'python');
const MAX_TELEGRAM_CODEPOINTS = 3_800;
const MAX_GENERATION_MS = 20 * 60 * 1_000;
const REPLY_ACTION_TTL_MS = 24 * 60 * 60 * 1_000;
const TRIM_SESSION_TTL_MS = 15 * 60 * 1_000;
const STREAM_EDIT_INTERVAL_MS = 900;
const AUTO_CONFIG_TTL_MS = 30 * 60 * 1_000;
const AUTO_MAX_ROUNDS = 30;
const AUTO_MAX_PER_MESSAGE_CHARS = 4_000;
const AUTO_MAX_TOTAL_CHARS = 120_000;
const TELEGRAM_DELETE_WINDOW_MS = 48 * 60 * 60 * 1_000;
const TELEGRAM_DELETE_SAFETY_MS = 5 * 60 * 1_000;
const SILLYTAVERN_LAUNCH_LABEL = 'com.local.sillytavern.server';
const BROWSER_KEEPER_LAUNCH_LABEL = 'com.local.sillytavern.telegram-browser';
const SILLYTAVERN_URL = 'http://127.0.0.1:8000/';
const CHROME_DEBUG_TARGETS_URL = 'http://127.0.0.1:9223/json/list';
const execFileAsync = promisify(execFile);

function log(message) {
    process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

function fail(message) {
    process.stderr.write(`${new Date().toISOString()} ${message}\n`);
    process.exit(1);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function withDedicatedChromePage(callback) {
    const response = await fetch(CHROME_DEBUG_TARGETS_URL, { signal: AbortSignal.timeout(4_000) });
    if (!response.ok) throw new Error(`Chrome debug endpoint returned HTTP ${response.status}`);
    const targets = await response.json();
    const target = targets.find(item => item.type === 'page' && String(item.url || '').includes('stTelegramController=dedicated'));
    if (!target?.webSocketDebuggerUrl) throw new Error('Dedicated SillyTavern Chrome page was not found');

    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Chrome debugger connection timed out')), 5_000);
        socket.once('open', () => {
            clearTimeout(timer);
            resolve();
        });
        socket.once('error', error => {
            clearTimeout(timer);
            reject(error);
        });
    });

    let commandId = 0;
    const pending = new Map();
    const onMessage = raw => {
        let message;
        try {
            message = JSON.parse(String(raw));
        } catch {
            return;
        }
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error.message || 'Chrome debugger command failed'));
        else request.resolve(message.result);
    };
    socket.on('message', onMessage);

    const command = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++commandId;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Chrome debugger ${method} timed out`));
        }, 12_000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
    });

    try {
        return await callback(command);
    } finally {
        socket.off('message', onMessage);
        for (const request of pending.values()) {
            clearTimeout(request.timer);
            request.reject(new Error('Chrome debugger connection closed'));
        }
        pending.clear();
        socket.close();
    }
}

async function captureFrontendScreenshots(frontend) {
    const visualIds = Array.isArray(frontend?.visualIds) ? frontend.visualIds.slice(0, 3) : [];
    const messageIndex = Number(frontend?.messageIndex);
    const fingerprint = String(frontend?.fingerprint || '');
    if (visualIds.length === 0 || !Number.isSafeInteger(messageIndex) || !fingerprint) return [];

    return withDedicatedChromePage(async command => {
        await command('Page.bringToFront');
        const screenshots = [];
        for (const visualId of visualIds) {
            const expression = `(async () => {
                const visualId = ${JSON.stringify(String(visualId))};
                const messageIndex = ${JSON.stringify(messageIndex)};
                const expectedFingerprint = ${JSON.stringify(fingerprint)};
                const context = window.SillyTavern?.getContext?.();
                const message = context?.chat?.[messageIndex];
                if (!message) return { error: 'message_missing' };
                const input = JSON.stringify([
                    Boolean(message?.is_user), Boolean(message?.is_system), String(message?.name || ''),
                    String(message?.mes ?? ''), String(message?.send_date || ''),
                ]);
                let hash = 0x811c9dc5;
                for (let index = 0; index < input.length; index += 1) {
                    hash ^= input.charCodeAt(index);
                    hash = Math.imul(hash, 0x01000193);
                }
                if ((hash >>> 0).toString(36) !== expectedFingerprint) return { error: 'message_changed' };
                const element = document.querySelector('[data-telegram-visual-id="' + CSS.escape(visualId) + '"]');
                if (!element) return { error: 'visual_missing' };
                element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
                await new Promise(resolve => setTimeout(resolve, 300));
                const rect = element.getBoundingClientRect();
                const left = Math.max(0, rect.left);
                const top = Math.max(0, rect.top);
                const right = Math.min(window.innerWidth, rect.right);
                const bottom = Math.min(window.innerHeight, rect.bottom);
                return {
                    x: left + window.scrollX,
                    y: top + window.scrollY,
                    width: right - left,
                    height: bottom - top,
                    title: element.contentDocument?.title || element.getAttribute('title') || '',
                };
            })()`;
            const evaluated = await command('Runtime.evaluate', {
                expression,
                awaitPromise: true,
                returnByValue: true,
            });
            if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text || 'Could not inspect frontend element');
            const rect = evaluated.result?.value;
            if (!rect || rect.error || rect.width < 120 || rect.height < 60) {
                log(`frontend screenshot skipped visual=${JSON.stringify(visualId)} reason=${JSON.stringify(rect?.error || 'invalid_bounds')}`);
                continue;
            }
            const captured = await command('Page.captureScreenshot', {
                format: 'png',
                fromSurface: true,
                captureBeyondViewport: false,
                clip: {
                    x: rect.x,
                    y: rect.y,
                    width: Math.min(rect.width, 2_000),
                    height: Math.min(rect.height, 2_600),
                    scale: 1,
                },
            });
            if (captured?.data) {
                screenshots.push({
                    buffer: Buffer.from(captured.data, 'base64'),
                    title: String(rect.title || ''),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                });
            }
        }
        return screenshots;
    });
}

class TelegramBot extends EventEmitter {
    constructor(token) {
        super();
        this.baseUrl = `https://api.telegram.org/bot${token}`;
        this.polling = false;
        this.offset = 0;
        this.abortController = null;
    }

    async call(method, body = {}, signal = undefined, attempt = 0) {
        const response = await fetch(`${this.baseUrl}/${method}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal,
        });
        const result = await response.json().catch(() => null);
        const retryAfter = Number(result?.parameters?.retry_after || 0);
        if (result?.error_code === 429 && retryAfter > 0 && attempt < 3) {
            await delay((retryAfter + 1) * 1_000);
            return this.call(method, body, signal, attempt + 1);
        }
        if (!response.ok || !result?.ok) {
            throw new Error(result?.description || `Telegram API ${method} failed with HTTP ${response.status}`);
        }
        return result.result;
    }

    async callMultipart(method, fields, file, attempt = 0) {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields || {})) {
            if (value === undefined || value === null) continue;
            form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
        }
        form.append(file.field, new Blob([file.buffer], { type: file.mimeType }), file.filename);
        const response = await fetch(`${this.baseUrl}/${method}`, { method: 'POST', body: form });
        const result = await response.json().catch(() => null);
        const retryAfter = Number(result?.parameters?.retry_after || 0);
        if (result?.error_code === 429 && retryAfter > 0 && attempt < 3) {
            await delay((retryAfter + 1) * 1_000);
            return this.callMultipart(method, fields, file, attempt + 1);
        }
        if (!response.ok || !result?.ok) {
            throw new Error(result?.description || `Telegram API ${method} failed with HTTP ${response.status}`);
        }
        return result.result;
    }

    getMe() {
        return this.call('getMe');
    }

    deleteWebhook(options) {
        return this.call('deleteWebhook', options);
    }

    setMyCommands(commands) {
        return this.call('setMyCommands', { commands });
    }

    sendMessage(chatId, text, options = {}) {
        return this.call('sendMessage', { chat_id: chatId, text, ...options });
    }

    sendPhoto(chatId, buffer, options = {}) {
        return this.callMultipart('sendPhoto', { chat_id: chatId, ...options }, {
            field: 'photo',
            buffer,
            mimeType: 'image/png',
            filename: 'sillytavern-frontend.png',
        });
    }

    sendChatAction(chatId, action) {
        return this.call('sendChatAction', { chat_id: chatId, action });
    }

    editMessageText(text, options = {}) {
        return this.call('editMessageText', { text, ...options });
    }

    answerCallbackQuery(callbackQueryId, options = {}) {
        return this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...options });
    }

    deleteMessage(chatId, messageId) {
        return this.call('deleteMessage', { chat_id: chatId, message_id: messageId });
    }

    deleteMessages(chatId, messageIds) {
        return this.call('deleteMessages', { chat_id: chatId, message_ids: messageIds });
    }

    async startPolling() {
        if (this.polling) return;
        this.polling = true;
        while (this.polling) {
            this.abortController = new AbortController();
            try {
                const updates = await this.call('getUpdates', {
                    offset: this.offset,
                    timeout: 25,
                    allowed_updates: ['message', 'callback_query'],
                }, this.abortController.signal);
                for (const update of updates) {
                    this.offset = Math.max(this.offset, update.update_id + 1);
                    if (update.message) this.emit('message', update.message);
                    if (update.callback_query) this.emit('callback_query', update.callback_query);
                }
            } catch (error) {
                if (!this.polling || error.name === 'AbortError') break;
                this.emit('polling_error', error);
                await delay(2_000);
            }
        }
    }

    async stopPolling() {
        this.polling = false;
        this.abortController?.abort();
    }
}

function readJson(filePath, fallback = null) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return fallback;
        throw error;
    }
}

const config = readJson(CONFIG_PATH);
if (!config) fail(`Missing ${CONFIG_PATH}`);
if (!config.telegramToken || config.telegramToken === 'PASTE_BOT_TOKEN_HERE') fail('Telegram Bot Token is not configured');
if (!config.bridgeSecret || config.bridgeSecret.length < 32) fail('bridgeSecret must contain at least 32 characters');
if (config.listenHost !== '127.0.0.1') fail('listenHost must be 127.0.0.1');

let state = readJson(STATE_PATH, {});
let allowedUserId = Number(config.allowedUserId || state.allowedUserId) || null;
let browserClient = null;
let browserConnectionVersion = 0;
let browserStatus = null;
let activeRequest = null;
let typingTimer = null;
let generationTimer = null;
const menuSessions = new Map();
const pendingSelections = new Map();
const historySessions = new Map();
const pendingHistoryRequests = new Map();
const replyActions = new Map();
const latestReplyActionByChat = new Map();
const pendingTrimByChat = new Map();
const pendingMutations = new Map();
const chatDeleteConfirmations = new Map();
const pendingChatDeletions = new Map();
const generationStreams = new Map();
const clearingChats = new Set();
const pendingAutoConfigs = new Map();
let autoSession = null;
let tavernControlPromise = null;
let botUsername = '';

function browserClientPriority(socket) {
    return Number(socket?.controllerPriority) || 0;
}

function shouldSelectBrowserClient(socket) {
    if (!isBrowserReady()) return true;
    const nextHasWorlds = socket.capabilities?.has('worlds-v1');
    const currentHasWorlds = browserClient.capabilities?.has('worlds-v1');
    if (nextHasWorlds !== currentHasWorlds) return nextHasWorlds;
    return browserClientPriority(socket) > browserClientPriority(browserClient);
}

function launchctlTarget() {
    return `gui/${process.getuid()}/${SILLYTAVERN_LAUNCH_LABEL}`;
}

function browserKeeperLaunchctlTarget() {
    return `gui/${process.getuid()}/${BROWSER_KEEPER_LAUNCH_LABEL}`;
}

async function isTavernHttpReady() {
    return new Promise(resolve => {
        const request = http.get(SILLYTAVERN_URL, response => {
            response.resume();
            resolve(response.statusCode >= 200 && response.statusCode < 500);
        });
        request.setTimeout(1_500, () => request.destroy());
        request.once('error', () => resolve(false));
    });
}

async function isTavernJobRunning() {
    try {
        const { stdout } = await execFileAsync('/bin/launchctl', ['print', launchctlTarget()], {
            timeout: 5_000,
            maxBuffer: 256 * 1024,
        });
        return /\bstate = running\b/.test(stdout) || /^\s*pid = \d+/m.test(stdout);
    } catch {
        return false;
    }
}

async function waitForTavernState(expectedReady, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ready = await isTavernHttpReady();
        if (ready === expectedReady) return true;
        await delay(1_000);
    }
    return (await isTavernHttpReady()) === expectedReady;
}

async function startTavern() {
    if (await isTavernHttpReady()) return { changed: false, ready: true };
    if (await isTavernJobRunning()) {
        const ready = await waitForTavernState(true, 45_000);
        return { changed: false, ready };
    }
    await execFileAsync('/bin/launchctl', ['kickstart', launchctlTarget()], { timeout: 10_000 });
    const ready = await waitForTavernState(true, 45_000);
    return { changed: true, ready };
}

async function stopTavern() {
    const wasReady = await isTavernHttpReady();
    const wasRunning = await isTavernJobRunning();
    if (!wasReady && !wasRunning) return { changed: false, stopped: true };
    await execFileAsync('/bin/launchctl', ['kill', 'SIGTERM', launchctlTarget()], { timeout: 10_000 });
    const stopped = await waitForTavernState(false, 30_000);
    if (stopped) {
        await execFileAsync('/bin/launchctl', ['kill', 'SIGTERM', browserKeeperLaunchctlTarget()], {
            timeout: 10_000,
        }).catch(error => log(`browser keeper reset failed: ${error.message}`));
    }
    return { changed: true, stopped };
}

async function runTavernControl(operation) {
    if (tavernControlPromise) return { busy: true };
    tavernControlPromise = operation === 'start' ? startTavern() : stopTavern();
    try {
        return await tavernControlPromise;
    } finally {
        tavernControlPromise = null;
    }
}

function persistState() {
    fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(STATE_PATH, 0o600);
}

function persistAllowedUser(userId) {
    state = { ...state, allowedUserId: Number(userId), pairedAt: new Date().toISOString() };
    persistState();
    allowedUserId = Number(userId);
}

function streamingRepliesEnabled() {
    return state.streamingReplies === true;
}

function setStreamingReplies(enabled) {
    state.streamingReplies = Boolean(enabled);
    persistState();
}

function recordMessageId(chatId, messageId, recordedAt = Date.now()) {
    if (!Number.isSafeInteger(Number(chatId)) || !Number.isSafeInteger(Number(messageId))) return;
    const key = `${chatId}:${messageId}`;
    const existing = Array.isArray(state.telegramMessageIds) ? state.telegramMessageIds : [];
    const deduplicated = existing.filter(item => `${item.chatId}:${item.messageId}` !== key);
    deduplicated.push({
        chatId: Number(chatId),
        messageId: Number(messageId),
        recordedAt: Number(recordedAt) || Date.now(),
    });
    state.telegramMessageIds = deduplicated.slice(-300);
    persistState();
}

function forgetMessageIds(chatId, messageIds) {
    const existing = Array.isArray(state.telegramMessageIds) ? state.telegramMessageIds : [];
    const ids = new Set(messageIds.map(Number));
    state.telegramMessageIds = existing.filter(item => (
        Number(item.chatId) !== Number(chatId) || !ids.has(Number(item.messageId))
    ));
    persistState();
}

function codePointLength(text) {
    return Array.from(text).length;
}

function splitTelegramText(input) {
    const text = String(input ?? '').replace(/\r\n/g, '\n').trim();
    if (!text) return ['（空回复）'];
    if (codePointLength(text) <= MAX_TELEGRAM_CODEPOINTS) return [text];

    const chunks = [];
    let remaining = text;
    while (codePointLength(remaining) > MAX_TELEGRAM_CODEPOINTS) {
        const points = Array.from(remaining);
        const windowText = points.slice(0, MAX_TELEGRAM_CODEPOINTS).join('');
        const paragraphBreak = windowText.lastIndexOf('\n\n');
        const lineBreak = windowText.lastIndexOf('\n');
        const sentenceBreak = Math.max(windowText.lastIndexOf('。'), windowText.lastIndexOf('！'), windowText.lastIndexOf('？'));
        let cut = Math.max(paragraphBreak, lineBreak, sentenceBreak);
        if (cut < Math.floor(MAX_TELEGRAM_CODEPOINTS * 0.55)) cut = windowText.length;
        else cut += 1;
        const chunk = windowText.slice(0, cut).trim();
        chunks.push(chunk);
        remaining = remaining.slice(cut).trimStart();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
}

async function sendPlain(chatId, text) {
    const messages = [];
    for (const chunk of splitTelegramText(text)) {
        messages.push(await sendTrackedMessage(chatId, chunk, { link_preview_options: { is_disabled: true } }));
    }
    return messages;
}

function replyActionMarkup(actionId) {
    return {
        inline_keyboard: [[
            { text: '↩️ 撤回这条回复', callback_data: `rev:undo:${actionId}` },
            { text: '✂️ 截断后半段', callback_data: `rev:trim:${actionId}` },
        ]],
    };
}

async function sendAiReply(chatId, text, target, frontend = null) {
    const actionId = shortId();
    const action = {
        id: actionId,
        chatId: Number(chatId),
        target: target || null,
        telegramMessageIds: [],
        createdAt: Date.now(),
    };
    replyActions.set(actionId, action);

    try {
        const chunks = splitTelegramText(text);
        for (let index = 0; index < chunks.length; index += 1) {
            const options = { link_preview_options: { is_disabled: true } };
            if (index === chunks.length - 1) options.reply_markup = replyActionMarkup(actionId);
            const message = await sendTrackedMessage(chatId, chunks[index], options);
            action.telegramMessageIds.push(Number(message.message_id));
        }
        if (frontend) {
            try {
                const screenshots = await captureFrontendScreenshots(frontend);
                for (let index = 0; index < screenshots.length; index += 1) {
                    const screenshot = screenshots[index];
                    const suffix = screenshots.length > 1 ? ` ${index + 1}/${screenshots.length}` : '';
                    const title = screenshot.title ? ` · ${screenshot.title}` : '';
                    const message = await sendTrackedPhoto(chatId, screenshot.buffer, {
                        caption: `🖼 酒馆前端界面${suffix}${title}`,
                    });
                    action.telegramMessageIds.push(Number(message.message_id));
                    log(`frontend screenshot sent ${screenshot.width}x${screenshot.height} bytes=${screenshot.buffer.length}`);
                }
                if (screenshots.length === 0) log('frontend was detected but no screenshot could be captured');
            } catch (error) {
                log(`frontend screenshot failed: ${error.message}`);
            }
        }
        latestReplyActionByChat.set(Number(chatId), actionId);
        return action;
    } catch (error) {
        replyActions.delete(actionId);
        if (latestReplyActionByChat.get(Number(chatId)) === actionId) {
            latestReplyActionByChat.delete(Number(chatId));
        }
        throw error;
    }
}

async function deleteTelegramMessageIds(chatId, messageIds) {
    const ids = [...new Set((messageIds || []).map(Number))]
        .filter(Number.isSafeInteger)
        .sort((a, b) => a - b);
    for (let offset = 0; offset < ids.length; offset += 100) {
        const chunk = ids.slice(offset, offset + 100);
        await bot.deleteMessages(chatId, chunk).catch(async () => {
            for (const messageId of chunk) {
                await bot.deleteMessage(chatId, messageId).catch(() => {});
            }
        });
    }
}

function fixedTelegramStreamChunks(input) {
    const text = String(input ?? '').replace(/\r\n/g, '\n').trim();
    if (!text) return [];
    const points = Array.from(text);
    const chunks = [];
    for (let offset = 0; offset < points.length; offset += MAX_TELEGRAM_CODEPOINTS) {
        const chunk = points.slice(offset, offset + MAX_TELEGRAM_CODEPOINTS).join('');
        chunks.push(chunk.trim() || '…');
    }
    return chunks;
}

function closeGenerationStream(state) {
    if (!state) return;
    state.closed = true;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
}

function beginGenerationStream(data) {
    const requestId = String(data.requestId || '');
    if (!requestId || !activeRequest || activeRequest.requestId !== requestId) return null;
    const existing = generationStreams.get(requestId);
    if (existing) return existing;
    const state = {
        requestId,
        chatId: Number(data.chatId),
        latestText: '',
        renderedText: '',
        renderedChunks: [],
        messageIds: [],
        lastFlushAt: 0,
        timer: null,
        flushPromise: Promise.resolve(),
        closed: false,
        createdAt: Date.now(),
    };
    generationStreams.set(requestId, state);
    return state;
}

async function flushGenerationStream(state) {
    if (state.closed || !state.latestText || state.latestText === state.renderedText) return;
    const text = state.latestText;
    const chunks = fixedTelegramStreamChunks(text);
    let completed = true;

    for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        if (state.messageIds[index]) {
            if (state.renderedChunks[index] === chunk) continue;
            try {
                await bot.editMessageText(chunk, {
                    chat_id: state.chatId,
                    message_id: state.messageIds[index],
                    link_preview_options: { is_disabled: true },
                });
                state.renderedChunks[index] = chunk;
            } catch (error) {
                if (!error.message.includes('message is not modified')) {
                    log(`stream edit failed: ${error.message}`);
                    completed = false;
                    break;
                }
                state.renderedChunks[index] = chunk;
            }
        } else {
            try {
                const message = await sendTrackedMessage(state.chatId, chunk, {
                    link_preview_options: { is_disabled: true },
                });
                state.messageIds[index] = Number(message.message_id);
                state.renderedChunks[index] = chunk;
            } catch (error) {
                log(`stream send failed: ${error.message}`);
                completed = false;
                break;
            }
        }
    }

    if (completed && state.messageIds.length > chunks.length) {
        const obsoleteIds = state.messageIds.slice(chunks.length);
        await deleteTelegramMessageIds(state.chatId, obsoleteIds);
        state.messageIds.length = chunks.length;
        state.renderedChunks.length = chunks.length;
    }
    state.lastFlushAt = Date.now();
    if (completed) state.renderedText = text;
}

function scheduleGenerationStreamFlush(state, immediate = false) {
    if (!state || state.closed || state.timer || !state.latestText || state.latestText === state.renderedText) return;
    const wait = immediate ? 0 : Math.max(0, STREAM_EDIT_INTERVAL_MS - (Date.now() - state.lastFlushAt));
    state.timer = setTimeout(() => {
        state.timer = null;
        state.flushPromise = state.flushPromise
            .then(() => flushGenerationStream(state))
            .catch(error => log(`stream flush failed: ${error.message}`))
            .finally(() => {
                if (!state.closed && state.latestText !== state.renderedText) scheduleGenerationStreamFlush(state);
            });
    }, wait);
}

function handleGenerationProgress(data) {
    const requestId = String(data.requestId || '');
    if (!activeRequest || activeRequest.requestId !== requestId || Number(activeRequest.chatId) !== Number(data.chatId)) return;
    const state = generationStreams.get(requestId) || beginGenerationStream(data);
    if (!state) return;
    const text = String(data.text || '');
    if (!text || text === state.latestText) return;
    state.latestText = text;
    scheduleGenerationStreamFlush(state, state.messageIds.length === 0);
}

async function finalizeGenerationStream(data) {
    const requestId = String(data.requestId || '');
    const state = generationStreams.get(requestId);
    if (!state) return sendAiReply(data.chatId, data.text, data.target, data.frontend);
    closeGenerationStream(state);
    await state.flushPromise.catch(() => {});

    try {
        const action = await sendAiReply(data.chatId, data.text, data.target, data.frontend);
        await deleteTelegramMessageIds(state.chatId, state.messageIds);
        generationStreams.delete(requestId);
        return action;
    } catch (error) {
        generationStreams.delete(requestId);
        throw error;
    }
}

async function replaceGenerationStreamWithMessage(data) {
    const requestId = String(data.requestId || '');
    const state = generationStreams.get(requestId);
    if (state) {
        closeGenerationStream(state);
        await state.flushPromise.catch(() => {});
    }
    try {
        const messages = await sendPlain(data.chatId, data.text);
        if (state) {
            await deleteTelegramMessageIds(state.chatId, state.messageIds);
        }
        generationStreams.delete(requestId);
        return messages;
    } catch (error) {
        generationStreams.delete(requestId);
        throw error;
    }
}

function consumeReplyAction(action) {
    if (!action) return;
    replyActions.delete(action.id);
    if (latestReplyActionByChat.get(Number(action.chatId)) === action.id) {
        latestReplyActionByChat.delete(Number(action.chatId));
    }
    const pendingTrim = pendingTrimByChat.get(Number(action.chatId));
    if (pendingTrim?.action?.id === action.id) {
        pendingTrimByChat.delete(Number(action.chatId));
        if (pendingTrim.promptMessageId) {
            void bot.deleteMessage(action.chatId, pendingTrim.promptMessageId).catch(() => {});
        }
    }
}

function getLatestReplyAction(chatId) {
    const actionId = latestReplyActionByChat.get(Number(chatId));
    return actionId ? replyActions.get(actionId) || null : null;
}

async function sendTrackedMessage(chatId, text, options = {}) {
    const message = await bot.sendMessage(chatId, text, options);
    recordMessageId(chatId, message?.message_id, Number(message?.date) * 1_000);
    return message;
}

async function sendTrackedPhoto(chatId, buffer, options = {}) {
    const message = await bot.sendPhoto(chatId, buffer, options);
    recordMessageId(chatId, message?.message_id, Number(message?.date) * 1_000);
    return message;
}

function shortId() {
    return Math.random().toString(36).slice(2, 10);
}

function truncateLabel(input, max = 58) {
    const points = Array.from(String(input || '未命名'));
    return points.length > max ? `${points.slice(0, max - 1).join('')}…` : points.join('');
}

function countNarrativeChars(input) {
    return Array.from(String(input || '').replace(/\s/gu, '')).length;
}

function normalizeAutoSettings(input = {}) {
    const rounds = Number(input.rounds ?? 10);
    const perMessageChars = Number(input.perMessageChars ?? 0);
    const totalChars = Number(input.totalChars ?? 0);
    const delivery = input.delivery === 'final' ? 'final' : 'live';
    const outline = String(input.outline || '').trim();

    if (!Number.isInteger(rounds) || rounds < 1 || rounds > AUTO_MAX_ROUNDS) {
        throw new Error(`轮数必须是 1–${AUTO_MAX_ROUNDS} 的整数`);
    }
    if (!Number.isInteger(perMessageChars) || perMessageChars < 0 || perMessageChars > AUTO_MAX_PER_MESSAGE_CHARS) {
        throw new Error(`单条字数必须是 0–${AUTO_MAX_PER_MESSAGE_CHARS} 的整数；0 表示沿用角色卡默认长度`);
    }
    if (perMessageChars > 0 && perMessageChars < 50) {
        throw new Error('单条字数至少为 50；填写 0 可沿用角色卡默认长度');
    }
    if (!Number.isInteger(totalChars) || totalChars < 0 || totalChars > AUTO_MAX_TOTAL_CHARS) {
        throw new Error(`总字数必须是 0–${AUTO_MAX_TOTAL_CHARS} 的整数；0 表示只按轮数结束`);
    }
    if (totalChars > 0 && totalChars < 100) {
        throw new Error('总字数至少为 100；填写 0 可只按轮数结束');
    }
    if (outline.length > 12_000) throw new Error('大纲不能超过 12000 个字符');
    return { rounds, perMessageChars, totalChars, delivery, outline };
}

function parseAutoConfigText(input) {
    const text = String(input || '').replace(/\r\n/gu, '\n').trim();
    if (!text) return normalizeAutoSettings();

    const settings = { rounds: 10, perMessageChars: 500, totalChars: 0, delivery: 'live' };
    const outlineLines = [];
    let readingOutline = false;
    let recognized = 0;
    for (const line of text.split('\n')) {
        if (readingOutline) {
            outlineLines.push(line);
            continue;
        }
        let match = line.match(/^\s*(?:轮数|rounds?)\s*[:：=]\s*(\d+)\s*$/iu);
        if (match) {
            settings.rounds = Number(match[1]);
            recognized += 1;
            continue;
        }
        match = line.match(/^\s*(?:单条字数|每条字数|每轮字数|permessage)\s*[:：=]\s*(\d+)\s*$/iu);
        if (match) {
            settings.perMessageChars = Number(match[1]);
            recognized += 1;
            continue;
        }
        match = line.match(/^\s*(?:总字数|total)\s*[:：=]\s*(\d+)\s*$/iu);
        if (match) {
            settings.totalChars = Number(match[1]);
            recognized += 1;
            continue;
        }
        match = line.match(/^\s*(?:推送|显示|delivery)\s*[:：=]\s*(.+?)\s*$/iu);
        if (match) {
            settings.delivery = /(?:结束|完成|最终|最后|汇总|final)/iu.test(match[1]) ? 'final' : 'live';
            recognized += 1;
            continue;
        }
        match = line.match(/^\s*(?:大纲|剧情|outline)\s*[:：=]\s*(.*)$/iu);
        if (match) {
            readingOutline = true;
            recognized += 1;
            if (match[1]) outlineLines.push(match[1]);
            continue;
        }
        if (line.trim()) outlineLines.push(line);
    }
    settings.outline = recognized > 0 ? outlineLines.join('\n').trim() : text;
    return normalizeAutoSettings(settings);
}

function autoSettingsText(settings) {
    const length = settings.perMessageChars > 0 ? `每条约 ${settings.perMessageChars} 字` : '单条长度沿用角色卡设置';
    const total = settings.totalChars > 0 ? `，达到约 ${settings.totalChars} 总字数时也会结束` : '';
    const outline = settings.outline ? `\n大纲：${truncateLabel(settings.outline, 180)}` : '\n剧情：沿用当前角色卡、用户人格、世界书和聊天上下文';
    const delivery = settings.delivery === 'final' ? '结束后汇总' : '每条完成后推送';
    return `${settings.rounds} 轮 · ${length}${total} · ${delivery}${outline}`;
}

function autoControlMarkup() {
    return {
        inline_keyboard: [
            [
                { text: '⏸ 暂停', callback_data: 'auto:pause' },
                { text: '▶️ 继续', callback_data: 'auto:resume' },
                { text: '⏹ 停止', callback_data: 'auto:stop' },
            ],
            [
                { text: '📊 运行状态', callback_data: 'auto:status' },
                { text: '‹ 返回主菜单', callback_data: 'act:menu' },
            ],
        ],
    };
}

function autoMenuMarkup() {
    return {
        inline_keyboard: [
            [
                { text: '▶️ 默认跑 5 轮', callback_data: 'auto:preset:5' },
                { text: '▶️ 默认跑 10 轮', callback_data: 'auto:preset:10' },
            ],
            [{ text: '📝 自定义大纲与字数', callback_data: 'auto:custom' }],
            [
                { text: '📊 当前状态', callback_data: 'auto:status' },
                { text: '⏹ 停止运行', callback_data: 'auto:stop' },
            ],
            [{ text: '‹ 返回主菜单', callback_data: 'act:menu' }],
        ],
    };
}

async function sendAutoMenu(chatId) {
    const running = autoSession
        ? `\n\n当前：${autoSession.status} · 已完成 ${autoSession.roundsCompleted || 0}/${autoSession.settings.rounds} 轮 · ${autoSession.totalChars || 0} 字`
        : '';
    await sendTrackedMessage(
        chatId,
        `自动跑剧情\n\n默认模式会沿用当前角色卡、用户人格、世界书、模型和已有上下文。每轮由模型先扮演你的用户人格，再由当前角色回复。${running}`,
        { reply_markup: autoMenuMarkup() },
    );
}

async function beginAutoConfig(chatId) {
    const existing = pendingAutoConfigs.get(Number(chatId));
    if (existing?.promptMessageId) await bot.deleteMessage(chatId, existing.promptMessageId).catch(() => {});
    const prompt = await sendTrackedMessage(chatId, [
        '请回复这条消息并填写自动剧情设置。未填写的大纲会沿用角色卡默认剧情。',
        '',
        '轮数: 10',
        '单条字数: 500',
        '总字数: 0',
        '推送: 每轮',
        '大纲:',
        '在这里填写剧情目标、关键事件、文风或限制。',
        '',
        '说明：单条字数或总字数填 0 表示不额外限制；推送可填写“每轮”或“结束后汇总”。发送 /cancel 取消。',
    ].join('\n'), {
        reply_markup: {
            force_reply: true,
            input_field_placeholder: '修改设置并填写大纲',
            selective: true,
        },
    });
    pendingAutoConfigs.set(Number(chatId), {
        promptMessageId: Number(prompt.message_id),
        createdAt: Date.now(),
    });
}

async function cancelAutoConfig(chatId, notify = true) {
    const pending = pendingAutoConfigs.get(Number(chatId));
    if (!pending) return false;
    pendingAutoConfigs.delete(Number(chatId));
    if (pending.promptMessageId) await bot.deleteMessage(chatId, pending.promptMessageId).catch(() => {});
    if (notify) await sendPlain(chatId, '已取消自动剧情设置。');
    return true;
}

async function startAutoSession(chatId, rawSettings) {
    if (activeRequest || autoSession) {
        await sendPlain(chatId, '当前已有生成或自动剧情任务在运行，请先等待或停止。');
        return false;
    }
    if (!await isTavernHttpReady()) {
        await sendPlain(chatId, '酒馆目前处于关闭状态，请先使用 /wake 唤醒。');
        return false;
    }
    if (!isBrowserReady()) {
        await sendPlain(chatId, '酒馆浏览器尚未连接，请稍后重试。');
        return false;
    }
    let settings;
    try {
        settings = normalizeAutoSettings(rawSettings);
    } catch (error) {
        await sendPlain(chatId, `自动剧情设置无效：${error.message}`);
        return false;
    }

    const sessionId = `auto-${Date.now()}-${shortId()}`;
    autoSession = {
        id: sessionId,
        chatId: Number(chatId),
        settings,
        status: '启动中',
        roundsCompleted: 0,
        totalChars: 0,
        transcript: [],
        createdAt: Date.now(),
    };
    activeRequest = { requestId: sessionId, chatId: Number(chatId), kind: 'auto', startedAt: Date.now() };
    startTyping(chatId);
    const sent = sendToBrowser({ type: 'auto_start', sessionId, chatId: Number(chatId), settings });
    if (!sent) {
        finishRequest();
        autoSession = null;
        await sendPlain(chatId, '酒馆浏览器刚刚断开，自动剧情未启动。');
        return false;
    }
    autoSession.status = '运行中';
    await sendTrackedMessage(chatId, `自动剧情已启动\n${autoSettingsText(settings)}`, { reply_markup: autoControlMarkup() });
    return true;
}

async function controlAutoSession(chatId, action) {
    if (!autoSession || Number(autoSession.chatId) !== Number(chatId)) {
        if (action === 'status') await sendPlain(chatId, '当前没有自动剧情任务。');
        else await sendPlain(chatId, '当前没有可控制的自动剧情任务。');
        return false;
    }
    if (action === 'status') {
        await sendTrackedMessage(
            chatId,
            `自动剧情：${autoSession.status}\n已完成：${autoSession.roundsCompleted}/${autoSession.settings.rounds} 轮\n累计字数：${autoSession.totalChars}${autoSession.settings.totalChars ? `/${autoSession.settings.totalChars}` : ''}\n\n${autoSettingsText(autoSession.settings)}`,
            { reply_markup: autoControlMarkup() },
        );
        return true;
    }
    if (!sendToBrowser({ type: 'auto_control', sessionId: autoSession.id, chatId: Number(chatId), action })) {
        await sendPlain(chatId, '酒馆浏览器尚未连接，控制指令未送达。');
        return false;
    }
    if (action === 'pause') {
        autoSession.status = '将在本轮完成后暂停';
        await sendPlain(chatId, '已请求暂停；当前轮完成后会进入暂停状态。');
    } else if (action === 'resume') {
        autoSession.status = '运行中';
        startTyping(chatId);
        await sendPlain(chatId, '自动剧情已继续。');
    } else if (action === 'stop') {
        autoSession.status = '正在停止';
        await sendPlain(chatId, '已请求停止；系统会在安全位置结束，避免留下半轮对话。');
    }
    return true;
}

async function setStreamingMode(chatId, enabled = null) {
    if (enabled === null) {
        const current = streamingRepliesEnabled() ? '流式显示' : '稳定显示';
        await sendTrackedMessage(chatId, `当前回复显示：${current}\n\n稳定显示只在生成完成后发送一次全文，可避免同一条消息不断变长引起 Telegram 页面自动下滑。`, {
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ 稳定显示', callback_data: 'stream:off' },
                    { text: '🌊 流式显示', callback_data: 'stream:on' },
                ], [{ text: '‹ 返回主菜单', callback_data: 'act:menu' }]],
            },
        });
        return;
    }
    setStreamingReplies(enabled);
    await sendPlain(chatId, enabled
        ? '已切换为流式显示。回复会不断编辑增长，部分 Telegram 客户端可能自动下滑。'
        : '已切换为稳定显示。生成期间显示“正在输入”，完成后一次性发送全文。');
}

function autoTurnText(turn) {
    const icon = turn.role === 'user' ? '👤' : '🤖';
    const label = turn.role === 'user' ? '自动扮演' : '角色回复';
    const name = turn.speaker ? ` · ${turn.speaker}` : '';
    return `${icon} ${label}${name}\n\n${String(turn.text || '').trim() || '（空消息）'}`;
}

async function handleAutoState(data) {
    if (!autoSession || String(data.sessionId) !== autoSession.id || Number(data.chatId) !== Number(autoSession.chatId)) return;
    autoSession.status = String(data.statusText || data.status || autoSession.status);
    autoSession.roundsCompleted = Number(data.roundsCompleted) || 0;
    autoSession.totalChars = Number(data.totalChars) || 0;
    if (data.status === 'paused') stopTypingOnly();
    if (data.status === 'running') startTyping(autoSession.chatId);
}

async function handleAutoTurn(data) {
    if (!autoSession || String(data.sessionId) !== autoSession.id || Number(data.chatId) !== Number(autoSession.chatId)) return;
    const turn = {
        role: data.role === 'user' ? 'user' : 'assistant',
        speaker: String(data.speaker || ''),
        text: String(data.text || ''),
    };
    autoSession.transcript.push(turn);
    autoSession.roundsCompleted = Number(data.roundsCompleted) || autoSession.roundsCompleted;
    autoSession.totalChars = Number(data.totalChars) || autoSession.totalChars;
    autoSession.status = '运行中';
    if (autoSession.settings.delivery === 'live') {
        await sendPlain(autoSession.chatId, autoTurnText(turn));
    }
}

async function handleAutoFinished(data) {
    if (!autoSession || String(data.sessionId) !== autoSession.id || Number(data.chatId) !== Number(autoSession.chatId)) return;
    const session = autoSession;
    session.roundsCompleted = Number(data.roundsCompleted) || session.roundsCompleted;
    session.totalChars = Number(data.totalChars) || session.totalChars;
    if (Array.isArray(data.transcript) && data.transcript.length > session.transcript.length) {
        session.transcript = data.transcript.map(turn => ({
            role: turn?.role === 'user' ? 'user' : 'assistant',
            speaker: String(turn?.speaker || ''),
            text: String(turn?.text || ''),
        }));
    }
    finishRequest();
    autoSession = null;

    if (session.settings.delivery === 'final' && session.transcript.length > 0) {
        await sendPlain(session.chatId, `自动剧情内容汇总 · ${session.roundsCompleted} 轮`);
        for (const turn of session.transcript) await sendPlain(session.chatId, autoTurnText(turn));
    }

    const reason = String(data.reason || 'completed');
    const reasonText = reason === 'stopped'
        ? '已按要求停止'
        : reason === 'total_chars'
            ? '已达到总字数目标'
            : reason === 'failed'
                ? '因错误结束'
                : '已完成设定轮数';
    const errorSuffix = data.error ? `\n错误：${data.error}` : '';
    await sendTrackedMessage(
        session.chatId,
        `自动剧情${reasonText}。\n完成 ${session.roundsCompleted}/${session.settings.rounds} 轮 · 共 ${session.totalChars} 字。所有内容已写入当前酒馆对话。${errorSuffix}`,
        { reply_markup: mainMenuMarkup() },
    );
}

function mainMenuMarkup() {
    return {
        inline_keyboard: [
            [
                { text: '🎭 选择角色', callback_data: 'act:characters' },
                { text: '💬 已有对话', callback_data: 'act:chats' },
            ],
            [
                { text: '🧠 选择模型', callback_data: 'act:models' },
                { text: '🎛️ 选择预设', callback_data: 'act:presets' },
            ],
            [
                { text: '✨ 新建对话', callback_data: 'act:new' },
                { text: '📚 选择世界书', callback_data: 'act:worlds' },
            ],
            [
                { text: '🎬 自动跑剧情', callback_data: 'act:auto' },
                { text: '📖 回复显示', callback_data: 'act:stream' },
            ],
            [
                { text: '▶️ 唤醒酒馆', callback_data: 'act:tavern_start' },
                { text: '⏹️ 关闭酒馆', callback_data: 'act:tavern_stop' },
            ],
            [{ text: '📡 当前状态', callback_data: 'act:status' }],
            [
                { text: '📜 历史预览', callback_data: 'act:history' },
                { text: '🧹 清理近48小时', callback_data: 'act:clear' },
            ],
            [{ text: '⚠️ 彻底清屏（全部历史）', callback_data: 'act:clear_all' }],
        ],
    };
}

async function sendMainMenu(chatId, title = 'SillyTavern 控制菜单') {
    return sendTrackedMessage(chatId, title, { reply_markup: mainMenuMarkup() });
}

async function waitForBrowserConnection(timeoutMs, minimumVersion = browserConnectionVersion) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (isBrowserReady() && browserConnectionVersion >= minimumVersion) return true;
        await delay(1_000);
    }
    return isBrowserReady() && browserConnectionVersion >= minimumVersion;
}

async function handleTavernStart(chatId) {
    await sendPlain(chatId, '正在唤醒酒馆，请稍候…');
    try {
        const previousBrowserConnectionVersion = browserConnectionVersion;
        const result = await runTavernControl('start');
        if (result.busy) {
            await sendPlain(chatId, '另一个启动或关闭操作正在进行，请稍候。');
        } else if (!result.ready) {
            await sendPlain(chatId, '已发出启动命令，但酒馆在 45 秒内没有就绪。请查看服务日志。');
        } else {
            const browserReady = await waitForBrowserConnection(
                20_000,
                result.changed ? previousBrowserConnectionVersion + 1 : previousBrowserConnectionVersion,
            );
            const prefix = result.changed ? '酒馆已成功启动。' : '酒馆已经在运行。';
            await sendPlain(chatId, browserReady ? `${prefix}\nTelegram 桥接已连接，可以开始聊天。` : `${prefix}\n浏览器桥接仍在连接，请稍后再试。`);
        }
    } catch (error) {
        log(`SillyTavern start failed: ${error.message}`);
        await sendPlain(chatId, '唤醒酒馆失败。后台服务未正确加载，请查看服务日志。');
    }
}

async function sendTavernStopConfirmation(chatId) {
    await sendTrackedMessage(chatId, '确定要关闭酒馆吗？Telegram 机器人会继续在线，之后可再次唤醒。', {
        reply_markup: {
            inline_keyboard: [[
                { text: '确认关闭', callback_data: 'act:tavern_stop_confirm' },
                { text: '取消', callback_data: 'act:menu' },
            ]],
        },
    });
}

async function handleTavernStop(chatId) {
    if (activeRequest) {
        await sendPlain(chatId, '当前仍在生成回复，请等待生成结束后再关闭酒馆。');
        return;
    }
    await sendPlain(chatId, '正在关闭酒馆，请稍候…');
    try {
        const result = await runTavernControl('stop');
        if (result.busy) {
            await sendPlain(chatId, '另一个启动或关闭操作正在进行，请稍候。');
        } else if (!result.stopped) {
            await sendPlain(chatId, '已发出关闭命令，但酒馆在 30 秒内仍未完全退出。');
        } else {
            await sendPlain(chatId, result.changed ? '酒馆已关闭。需要时点击“唤醒酒馆”即可重新启动。' : '酒馆本来就是关闭状态。');
        }
    } catch (error) {
        log(`SillyTavern stop failed: ${error.message}`);
        await sendPlain(chatId, '关闭酒馆失败。请查看服务日志。');
    }
}

function renderMenu(session, requestedPage = 0) {
    const totalPages = Math.max(1, Math.ceil(session.items.length / session.pageSize));
    const page = Math.min(Math.max(Number(requestedPage) || 0, 0), totalPages - 1);
    session.page = page;
    const start = page * session.pageSize;
    const rows = session.items.slice(start, start + session.pageSize).map((item, offset) => {
        const index = start + offset;
        const row = [{
            text: truncateLabel(item.label, session.kind === 'chats' ? 52 : 58),
            callback_data: `sel:${session.id}:${index}`,
        }];
        if (session.kind === 'chats') {
            row.push({ text: '🗑', callback_data: `chatdel:${session.id}:${index}` });
        }
        return row;
    });

    if (totalPages > 1) {
        const navigation = [];
        if (page > 0) navigation.push({ text: '‹ 上一页', callback_data: `pg:${session.id}:${page - 1}` });
        navigation.push({ text: `${page + 1}/${totalPages}`, callback_data: `noop:${session.id}` });
        if (page < totalPages - 1) navigation.push({ text: '下一页 ›', callback_data: `pg:${session.id}:${page + 1}` });
        rows.push(navigation);
    }
    rows.push([{ text: '‹ 返回主菜单', callback_data: 'act:menu' }]);

    const empty = session.items.length === 0 ? '\n没有可选择的项目。' : `\n共 ${session.items.length} 项`;
    return {
        text: `${session.title}${empty}`,
        reply_markup: { inline_keyboard: rows },
    };
}

async function presentMenu(chatId, kind, title, rawItems) {
    const items = Array.isArray(rawItems)
        ? rawItems.filter(item => item && item.value !== undefined && item.label)
        : [];
    const id = shortId();
    const session = {
        id,
        kind,
        title: String(title || '请选择'),
        items,
        chatId: Number(chatId),
        page: 0,
        pageSize: 8,
        createdAt: Date.now(),
    };
    menuSessions.set(id, session);
    const rendered = renderMenu(session, 0);
    await sendTrackedMessage(chatId, rendered.text, { reply_markup: rendered.reply_markup });
}

async function beginChatDeleteConfirmation(chatId, menuMessageId, session, item) {
    const id = shortId();
    const characterName = String(item.characterName || '').trim()
        || String(item.label || '').split(' · ')[0].replace(/^✓\s*/u, '')
        || '未知角色';
    const chatName = String(item.chatName || item.value?.chatName || '未知对话');
    const currentWarning = item.isCurrent ? '\n\n这是当前正在使用的对话；删除后会自动为该角色新建空白对话。' : '';
    const message = await sendTrackedMessage(
        chatId,
        `确定永久删除这个酒馆对话吗？\n\n角色：${characterName}\n对话：${chatName}${currentWarning}\n\n此操作无法撤销。`,
        {
            reply_markup: {
                inline_keyboard: [[
                    { text: '确认永久删除', callback_data: `chatdelok:${id}` },
                    { text: '取消', callback_data: `chatdelno:${id}` },
                ]],
            },
        },
    );
    chatDeleteConfirmations.set(id, {
        id,
        chatId: Number(chatId),
        menuMessageId: Number(menuMessageId),
        confirmationMessageId: Number(message.message_id),
        sessionId: session.id,
        value: item.value,
        label: item.label,
        createdAt: Date.now(),
    });
}

async function confirmChatDeletion(callbackId, confirmationId) {
    const confirmation = chatDeleteConfirmations.get(confirmationId);
    if (!confirmation) {
        await bot.answerCallbackQuery(callbackId, { text: '删除确认已过期，请重新打开“已有对话”', show_alert: true }).catch(() => {});
        return;
    }
    if (activeRequest) {
        await bot.answerCallbackQuery(callbackId, { text: '正在生成回复，暂时不能删除', show_alert: true }).catch(() => {});
        return;
    }
    const requestId = shortId();
    pendingChatDeletions.set(requestId, { ...confirmation, requestId });
    chatDeleteConfirmations.delete(confirmationId);
    const sent = sendToBrowser({
        type: 'chat_delete',
        requestId,
        chatId: confirmation.chatId,
        value: confirmation.value,
    });
    if (!sent) {
        pendingChatDeletions.delete(requestId);
        await bot.answerCallbackQuery(callbackId, { text: '酒馆浏览器尚未连接', show_alert: true }).catch(() => {});
        return;
    }
    await bot.answerCallbackQuery(callbackId, { text: '正在删除…' }).catch(() => {});
    await bot.editMessageText(`正在删除：${truncateLabel(confirmation.label, 120)}…`, {
        chat_id: confirmation.chatId,
        message_id: confirmation.confirmationMessageId,
    }).catch(error => log(`chat deletion progress edit failed: ${error.message}`));
}

async function handleChatDeleteResult(data) {
    const pending = pendingChatDeletions.get(String(data.requestId));
    if (!pending || Number(pending.chatId) !== Number(data.chatId)) return;
    pendingChatDeletions.delete(String(data.requestId));
    const session = menuSessions.get(pending.sessionId);
    let refreshed = null;
    if (data.ok && session && Number(session.chatId) === Number(pending.chatId) && data.menu) {
        session.title = String(data.menu.title || session.title);
        session.items = Array.isArray(data.menu.items) ? data.menu.items : [];
        refreshed = renderMenu(session, session.page);
        await bot.editMessageText(refreshed.text, {
            chat_id: pending.chatId,
            message_id: pending.menuMessageId,
            reply_markup: refreshed.reply_markup,
        }).catch(error => log(`chat menu refresh after deletion failed: ${error.message}`));
    }
    const text = data.ok ? `✅ ${data.text}` : `❌ 删除失败：${data.text}`;
    const replyMarkup = { inline_keyboard: [[
        { text: '💬 返回已有对话', callback_data: 'act:chats' },
        { text: '‹ 返回主菜单', callback_data: 'act:menu' },
    ]] };
    await bot.editMessageText(text, {
        chat_id: pending.chatId,
        message_id: pending.confirmationMessageId,
        reply_markup: replyMarkup,
    }).catch(async error => {
        log(`chat deletion result edit failed: ${error.message}`);
        await sendPlain(pending.chatId, text);
    });
}

async function requestMenu(kind, chatId) {
    if (activeRequest) {
        await sendPlain(chatId, '上一条消息仍在生成，请稍后再切换。');
        return;
    }
    if (!await isTavernHttpReady()) {
        await sendPlain(chatId, '酒馆目前处于关闭状态，请先使用 /wake 唤醒。');
        return;
    }
    if (!sendToBrowser({ type: 'menu_request', kind, chatId })) {
        await sendPlain(chatId, '酒馆浏览器尚未连接。');
    }
}

function historyMarkup(session) {
    const row = [];
    if (session.page < session.totalPages - 1) {
        row.push({ text: '‹ 更早记录', callback_data: `hist:${session.id}:${session.page + 1}` });
    }
    row.push({ text: `${session.page + 1}/${session.totalPages}`, callback_data: `noop:${session.id}` });
    if (session.page > 0) {
        row.push({ text: '更新记录 ›', callback_data: `hist:${session.id}:${session.page - 1}` });
    }
    return { inline_keyboard: [row, [{ text: '‹ 返回主菜单', callback_data: 'act:menu' }]] };
}

function historyText(data) {
    return `${data.title}\n\n本页显示 ${Array.isArray(data.messages) ? data.messages.length : 0} 条完整消息\n共 ${data.messageCount} 条消息 · 第 ${data.page + 1}/${data.totalPages} 页`;
}

async function requestHistory(chatId, page = 0, sessionId = null, messageId = null) {
    if (activeRequest) {
        await sendPlain(chatId, '上一条消息仍在生成，请稍后查看历史。');
        return;
    }
    if (!await isTavernHttpReady()) {
        await sendPlain(chatId, '酒馆目前处于关闭状态，请先使用 /wake 唤醒。');
        return;
    }
    const requestId = shortId();
    pendingHistoryRequests.set(requestId, {
        chatId: Number(chatId),
        sessionId,
        messageId,
        createdAt: Date.now(),
    });
    if (!sendToBrowser({ type: 'history_request', requestId, chatId, page, pageSize: 6 })) {
        pendingHistoryRequests.delete(requestId);
        await sendPlain(chatId, '酒馆浏览器尚未连接。');
    }
}

async function handleHistoryResponse(data) {
    const pending = pendingHistoryRequests.get(data.requestId);
    if (!pending || Number(pending.chatId) !== Number(data.chatId)) return;
    pendingHistoryRequests.delete(data.requestId);

    let session = pending.sessionId ? historySessions.get(pending.sessionId) : null;
    if (!session) {
        session = {
            id: shortId(),
            chatId: Number(data.chatId),
            messageId: null,
            page: Number(data.page) || 0,
            totalPages: Number(data.totalPages) || 1,
            previewMessageIds: [],
            previewActionIds: [],
            createdAt: Date.now(),
        };
        historySessions.set(session.id, session);
    } else {
        session.page = Number(data.page) || 0;
        session.totalPages = Number(data.totalPages) || 1;
        session.createdAt = Date.now();
    }

    if (pending.messageId) {
        for (const actionId of session.previewActionIds || []) {
            consumeReplyAction(replyActions.get(actionId));
        }
        const oldIds = [...new Set([...(session.previewMessageIds || []), Number(pending.messageId)])]
            .filter(Number.isSafeInteger)
            .sort((a, b) => a - b);
        if (oldIds.length) {
            await bot.deleteMessages(data.chatId, oldIds).catch(async () => {
                for (const messageId of oldIds) await bot.deleteMessage(data.chatId, messageId).catch(() => {});
            });
        }
    }

    const previewMessageIds = [];
    const previewActionIds = [];
    const historyMessages = Array.isArray(data.messages) ? data.messages : [];
    if (historyMessages.length === 0) {
        const sent = await sendPlain(data.chatId, '（当前对话没有历史消息）');
        previewMessageIds.push(...sent.map(message => message.message_id));
    } else {
        for (const item of historyMessages) {
            const text = `${item.speaker || '消息'}\n${String(item.text || '（空消息）')}`;
            if (item.target) {
                const action = await sendAiReply(data.chatId, text, item.target);
                previewMessageIds.push(...action.telegramMessageIds);
                previewActionIds.push(action.id);
            } else {
                const sent = await sendPlain(data.chatId, text);
                previewMessageIds.push(...sent.map(message => message.message_id));
            }
        }
    }

    session.previewMessageIds = previewMessageIds;
    session.previewActionIds = previewActionIds;
    const message = await sendTrackedMessage(data.chatId, historyText(data), { reply_markup: historyMarkup(session) });
    session.messageId = message.message_id;
}

async function deleteTelegramBatchResilient(chatId, ids) {
    if (ids.length === 0) return { processed: 0, skipped: 0 };
    try {
        await bot.deleteMessages(chatId, ids);
        return { processed: ids.length, skipped: 0 };
    } catch (error) {
        if (ids.length === 1) {
            log(`clear skipped message ${ids[0]}: ${error.message}`);
            return { processed: 0, skipped: 1 };
        }
        const midpoint = Math.ceil(ids.length / 2);
        const left = await deleteTelegramBatchResilient(chatId, ids.slice(0, midpoint));
        const right = await deleteTelegramBatchResilient(chatId, ids.slice(midpoint));
        return {
            processed: left.processed + right.processed,
            skipped: left.skipped + right.skipped,
        };
    }
}

async function clearTelegramScreen(chatId) {
    const chatKey = Number(chatId);
    if (clearingChats.has(chatKey)) {
        await sendPlain(chatId, '近 48 小时消息清理正在进行，请勿重复点击。');
        return;
    }
    clearingChats.add(chatKey);
    try {
        const cutoff = Date.now() - TELEGRAM_DELETE_WINDOW_MS + TELEGRAM_DELETE_SAFETY_MS;
        const tracked = (Array.isArray(state.telegramMessageIds) ? state.telegramMessageIds : [])
            .filter(item => Number(item.chatId) === chatKey)
            .filter(item => !Number(item.recordedAt) || Number(item.recordedAt) >= cutoff)
            .map(item => Number(item.messageId));
        const ids = [...new Set(tracked)]
            .filter(Number.isSafeInteger)
            .filter(id => id > 0)
            .sort((a, b) => b - a);

        let result = { processed: 0, skipped: 0 };
        for (let offset = 0; offset < ids.length; offset += 100) {
            const chunk = ids.slice(offset, offset + 100);
            const chunkResult = await deleteTelegramBatchResilient(chatId, chunk);
            result = {
                processed: result.processed + chunkResult.processed,
                skipped: result.skipped + chunkResult.skipped,
            };
        }
        forgetMessageIds(chatId, ids);
        for (const action of [...replyActions.values()]) {
            if (Number(action.chatId) === chatKey) consumeReplyAction(action);
        }
        pendingTrimByChat.delete(chatKey);
        const suffix = result.skipped > 0 ? `\n另有 ${result.skipped} 条消息受 Telegram 限制，无法删除。` : '';
        await sendTrackedMessage(
            chatId,
            `已清理机器人记录的近 48 小时消息（处理 ${result.processed} 条）。Telegram 禁止机器人删除超过 48 小时的消息；酒馆角色、会话和上下文均未删除。${suffix}`,
            { reply_markup: mainMenuMarkup() },
        );
    } finally {
        clearingChats.delete(chatKey);
    }
}

function completeClearConfirmationMarkup() {
    return {
        inline_keyboard: [[
            { text: '确认永久删除全部历史', callback_data: 'act:clear_all_confirm' },
            { text: '取消', callback_data: 'act:clear_all_cancel' },
        ]],
    };
}

async function sendCompleteClearConfirmation(chatId, messageId = null) {
    const text = '⚠️ 彻底清屏会使用你的个人 Telegram 账号，永久删除你与当前机器人的全部私聊历史，包括超过 48 小时的消息。\n\n此操作不可恢复，但不会删除酒馆中的角色卡、对话、世界书或上下文。';
    const options = { reply_markup: completeClearConfirmationMarkup() };
    if (messageId) {
        await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
    } else {
        await sendTrackedMessage(chatId, text, options);
    }
}

function parseMtprotoResult(stdout) {
    const lines = String(stdout || '').split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const result = JSON.parse(lines[index]);
            if (result && typeof result === 'object') return result;
        } catch {
            // Ignore non-JSON diagnostic output and continue backwards.
        }
    }
    throw new Error('MTProto 清理工具没有返回有效结果');
}

function resetTelegramChatTracking(chatId) {
    const chatKey = Number(chatId);
    state.telegramMessageIds = (Array.isArray(state.telegramMessageIds) ? state.telegramMessageIds : [])
        .filter(item => Number(item.chatId) !== chatKey);
    persistState();
    for (const action of [...replyActions.values()]) {
        if (Number(action.chatId) === chatKey) consumeReplyAction(action);
    }
    pendingTrimByChat.delete(chatKey);
    pendingAutoConfigs.delete(chatKey);
    for (const [id, session] of menuSessions) {
        if (Number(session.chatId) === chatKey) menuSessions.delete(id);
    }
    for (const [id, session] of historySessions) {
        if (Number(session.chatId) === chatKey) historySessions.delete(id);
    }
}

async function clearCompleteTelegramHistory(chatId) {
    const chatKey = Number(chatId);
    if (clearingChats.has(chatKey)) {
        await sendPlain(chatId, '另一个清屏操作正在进行，请勿重复点击。');
        return;
    }
    if (activeRequest) {
        await sendPlain(chatId, '当前仍在生成回复，请等待结束后再彻底清屏。');
        return;
    }
    if (!botUsername || !fs.existsSync(MTPROTO_CONFIG_PATH) || !fs.existsSync(MTPROTO_CLEAR_SCRIPT_PATH)
        || !fs.existsSync(MTPROTO_PYTHON_PATH)) {
        await sendPlain(chatId, '彻底清屏尚未完成本机配置，普通清屏仍可使用。');
        return;
    }

    clearingChats.add(chatKey);
    try {
        const { stdout } = await execFileAsync(MTPROTO_PYTHON_PATH, [
            MTPROTO_CLEAR_SCRIPT_PATH,
            '--config', MTPROTO_CONFIG_PATH,
            '--peer', `@${botUsername}`,
        ], { timeout: 120_000, maxBuffer: 1024 * 1024 });
        const result = parseMtprotoResult(stdout);
        if (!result.ok) throw new Error(result.message || result.code || 'MTProto 清理失败');
        resetTelegramChatTracking(chatId);
        await sendTrackedMessage(
            chatId,
            `已彻底清除你与当前机器人的全部 Telegram 私聊历史（服务器确认删除 ${Number(result.deletedCount) || 0} 条，剩余 0 条）。酒馆角色、会话、世界书和上下文均未删除。`,
            { reply_markup: mainMenuMarkup() },
        );
        log(`Complete Telegram history cleared peer=@${botUsername} deleted=${Number(result.deletedCount) || 0} remaining=0`);
    } catch (error) {
        let detail = error.message;
        try {
            const result = parseMtprotoResult(error.stdout);
            detail = result.message || result.code || detail;
        } catch {
            // Keep the process error when the helper produced no structured output.
        }
        log(`complete Telegram clear failed: ${detail}`);
        await sendTrackedMessage(chatId, `彻底清屏失败：${detail}`, { reply_markup: mainMenuMarkup() });
    } finally {
        clearingChats.delete(chatKey);
    }
}

function isBrowserReady() {
    return browserClient && browserClient.readyState === WebSocket.OPEN && browserClient.authenticated;
}

function stopTypingOnly() {
    if (typingTimer) clearInterval(typingTimer);
    typingTimer = null;
}

function stopGenerationIndicators() {
    stopTypingOnly();
    if (generationTimer) clearTimeout(generationTimer);
    generationTimer = null;
}

function finishRequest() {
    stopGenerationIndicators();
    activeRequest = null;
}

function startTyping(chatId) {
    stopTypingOnly();
    const tick = () => bot.sendChatAction(chatId, 'typing').catch(() => {});
    void tick();
    typingTimer = setInterval(tick, 4_000);
}

function sendToBrowser(payload) {
    if (!isBrowserReady()) return false;
    browserClient.send(JSON.stringify(payload));
    return true;
}

function broadcastToBrowserClients(payload, except = null) {
    const encoded = JSON.stringify(payload);
    let delivered = 0;
    for (const client of wss.clients) {
        if (client === except || !client.authenticated || client.readyState !== WebSocket.OPEN) continue;
        client.send(encoded);
        delivered += 1;
    }
    return delivered;
}

function hasPendingMutationForAction(actionId) {
    return [...pendingMutations.values()].some(item => item.action?.id === actionId);
}

function startMessageMutation({ chatId, operation, action = null, marker = null, promptMessageId = null, inputMessageId = null }) {
    if (!isBrowserReady()) return false;
    const requestId = shortId();
    pendingMutations.set(requestId, {
        requestId,
        chatId: Number(chatId),
        operation,
        action,
        promptMessageId: Number(promptMessageId) || null,
        inputMessageId: Number(inputMessageId) || null,
        createdAt: Date.now(),
    });
    const sent = sendToBrowser({
        type: 'message_mutation',
        requestId,
        chatId: Number(chatId),
        operation,
        target: action?.target || null,
        marker,
    });
    if (!sent) pendingMutations.delete(requestId);
    return sent;
}

async function handleMessageMutationResult(data) {
    const pending = pendingMutations.get(data.requestId);
    if (!pending || Number(pending.chatId) !== Number(data.chatId)) return;
    pendingMutations.delete(data.requestId);

    const cleanupIds = [pending.promptMessageId, pending.inputMessageId].filter(Number.isSafeInteger);
    if (cleanupIds.length) await deleteTelegramMessageIds(pending.chatId, cleanupIds);

    if (!data.ok) {
        if (pending.operation === 'trim' && data.code === 'marker_ambiguous' && pending.action) {
            await beginTrimSession(pending.chatId, pending.action, {
                occurrenceCount: Number(data.occurrenceCount) || 2,
            });
            return;
        }
        await sendPlain(pending.chatId, `操作未执行：${data.text || '酒馆拒绝了这次修改'}`);
        return;
    }

    if (pending.operation === 'delete') {
        if (pending.action) {
            await deleteTelegramMessageIds(pending.chatId, pending.action.telegramMessageIds);
            consumeReplyAction(pending.action);
        }
        await sendPlain(pending.chatId, '已同步撤回酒馆中的最后一条助手回复；你的上一条提问仍然保留。');
        return;
    }

    if (pending.operation === 'trim') {
        await sendAiReply(pending.chatId, data.text, data.target);
        if (pending.action) {
            await deleteTelegramMessageIds(pending.chatId, pending.action.telegramMessageIds);
            consumeReplyAction(pending.action);
        }
    }
}

async function beginTrimSession(chatId, action, { occurrenceCount = 0 } = {}) {
    const existing = pendingTrimByChat.get(Number(chatId));
    if (existing?.promptMessageId) {
        await bot.deleteMessage(chatId, existing.promptMessageId).catch(() => {});
    }
    const promptText = occurrenceCount > 1
        ? `刚才选择的文字在最新助手回复中出现了 ${occurrenceCount} 次，因此没有修改酒馆记录。\n\n请回复这条提示，复制更长的“想保留部分的末尾文字”，直到它能唯一定位。发送 /cancel 取消。`
        : '请回复这条提示，粘贴“你想保留部分的最后几个字”（建议 5–20 字）。\n\n我会保留回复开头到这段文字为止，并删掉后面全部内容。发送 /cancel 取消。';
    const prompt = await sendTrackedMessage(
        chatId,
        promptText,
        {
            reply_markup: {
                force_reply: true,
                input_field_placeholder: '粘贴最后想保留的几个字',
                selective: true,
            },
        },
    );
    pendingTrimByChat.set(Number(chatId), {
        action,
        promptMessageId: Number(prompt.message_id),
        createdAt: Date.now(),
    });
}

async function cancelTrimSession(chatId, notify = true) {
    const pending = pendingTrimByChat.get(Number(chatId));
    if (!pending) return false;
    pendingTrimByChat.delete(Number(chatId));
    if (pending.promptMessageId) {
        await bot.deleteMessage(chatId, pending.promptMessageId).catch(() => {});
    }
    if (notify) await sendPlain(chatId, '已取消截断操作。');
    return true;
}

const bot = new TelegramBot(config.telegramToken);

const wss = new WebSocketServer({ host: '127.0.0.1', port: Number(config.listenPort || 2333) });

wss.on('listening', () => log(`Bridge listening on 127.0.0.1:${config.listenPort || 2333}`));
wss.on('connection', socket => {
    socket.authenticated = false;
    socket.isAlive = true;

    const authTimer = setTimeout(() => {
        if (!socket.authenticated) socket.close(1008, 'Authentication required');
    }, 5_000);

    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('message', async raw => {
        let data;
        try {
            data = JSON.parse(raw.toString('utf8'));
        } catch {
            socket.close(1003, 'Invalid JSON');
            return;
        }

        if (!socket.authenticated) {
            if (data.type !== 'hello' || data.secret !== config.bridgeSecret) {
                socket.close(1008, 'Authentication failed');
                return;
            }
            clearTimeout(authTimer);
            socket.authenticated = true;
            socket.capabilities = new Set(Array.isArray(data.capabilities) ? data.capabilities.map(String) : []);
            socket.controllerPriority = Number(data.controllerPriority) || 0;
            socket.clientMode = String(data.clientMode || 'legacy');
            const selected = shouldSelectBrowserClient(socket);
            if (selected) {
                browserClient = socket;
                browserConnectionVersion += 1;
            }
            socket.send(JSON.stringify({ type: 'hello_ack' }));
            log(`SillyTavern browser connected mode=${JSON.stringify(socket.clientMode)} priority=${socket.controllerPriority} capabilities=${JSON.stringify([...socket.capabilities])} selected=${selected}`);
            return;
        }

        if (data.type === 'generation_started' && data.chatId && data.requestId && streamingRepliesEnabled()) {
            beginGenerationStream(data);
            return;
        }

        if (data.type === 'worlds_changed') {
            const worlds = [...new Set((Array.isArray(data.worlds) ? data.worlds : [])
                .filter(value => typeof value === 'string' && value.trim())
                .map(value => value.trim()))].slice(0, 200);
            if (socket === browserClient && browserStatus) browserStatus.worlds = worlds;
            const delivered = broadcastToBrowserClients({ type: 'world_sync', worlds }, socket);
            log(`World selection synchronized from ${JSON.stringify(socket.clientMode)} worlds=${JSON.stringify(worlds)} peers=${delivered}`);
            return;
        }

        if (data.type === 'generation_progress' && data.chatId && data.requestId) {
            if (streamingRepliesEnabled()) handleGenerationProgress(data);
            return;
        }

        if (data.type === 'auto_state' && data.chatId && data.sessionId) {
            await handleAutoState(data).catch(error => log(`auto state failed: ${error.message}`));
            return;
        }

        if (data.type === 'auto_turn' && data.chatId && data.sessionId) {
            await handleAutoTurn(data).catch(error => log(`auto turn delivery failed: ${error.message}`));
            return;
        }

        if (data.type === 'auto_finished' && data.chatId && data.sessionId) {
            await handleAutoFinished(data).catch(error => log(`auto finish delivery failed: ${error.message}`));
            return;
        }

        if (data.type === 'generation_context' && data.chatId && data.requestId) {
            if (activeRequest?.requestId === String(data.requestId)) {
                log(`Generation context: character=${JSON.stringify(data.character)} chat=${JSON.stringify(data.conversation)} historyMessages=${Number(data.historyMessages) || 0}`);
            }
            return;
        }

        if (data.type === 'status') {
            browserStatus = data;
            if (!data.chatId) {
                log(`Browser status: character=${JSON.stringify(data.character)} chat=${JSON.stringify(data.chat)} messages=${Number(data.chatLength) || 0} model=${JSON.stringify(data.model)} worlds=${JSON.stringify(data.worlds || [])} worldCount=${Number(data.worldCount) || 0}`);
            }
            if (data.chatId) {
                const worlds = Array.isArray(data.worlds) && data.worlds.length > 0
                    ? `${data.worlds.slice(0, 5).join('、')}${data.worlds.length > 5 ? ` 等 ${data.worlds.length} 本` : ''}`
                    : '未启用';
                const autoText = autoSession ? `\n自动剧情：${autoSession.status}（${autoSession.roundsCompleted}/${autoSession.settings.rounds} 轮）` : '';
                const displayText = streamingRepliesEnabled() ? '流式显示' : '稳定显示';
                const statusText = `酒馆已连接\n角色：${data.character}\n对话：${data.chat}\n模型：${data.model}\n预设：${data.preset || '未选择'}\n世界书：${worlds}\n接口：${data.source}\n消息数：${data.chatLength}\n状态：${data.busy ? '生成中' : '空闲'}\n回复显示：${displayText}${autoText}`;
                await sendPlain(data.chatId, statusText).catch(error => log(`status reply failed: ${error.message}`));
            }
            return;
        }

        if (data.type === 'menu_response' && data.chatId) {
            await presentMenu(data.chatId, data.kind, data.title, data.items)
                .catch(error => log(`menu reply failed: ${error.message}`));
            return;
        }

        if (data.type === 'menu_error' && data.chatId) {
            await sendPlain(data.chatId, `无法打开菜单：${data.text}`)
                .catch(error => log(`menu error reply failed: ${error.message}`));
            return;
        }

        if (data.type === 'selection_result' && data.chatId && data.requestId) {
            const pending = pendingSelections.get(data.requestId);
            if (!pending || Number(pending.chatId) !== Number(data.chatId)) return;
            pendingSelections.delete(data.requestId);
            log(`Selection result kind=${JSON.stringify(pending.kind)} ok=${Boolean(data.ok)} text=${JSON.stringify(data.text)}`);
            const text = data.ok ? `✅ ${data.text}` : `❌ ${data.text}`;
            if (data.ok && pending.kind === 'worlds' && data.menu) {
                const session = menuSessions.get(pending.sessionId);
                if (session && Number(session.chatId) === Number(pending.chatId)) {
                    session.title = String(data.menu.title || '选择世界书（可连续多选）');
                    session.items = Array.isArray(data.menu.items) ? data.menu.items : [];
                    const rendered = renderMenu(session, session.page);
                    await bot.editMessageText(rendered.text, {
                        chat_id: pending.chatId,
                        message_id: pending.messageId,
                        reply_markup: rendered.reply_markup,
                    }).catch(async error => {
                        log(`world menu refresh failed: ${error.message}`);
                        await sendPlain(pending.chatId, text);
                    });
                    return;
                }
            }
            const resultMarkup = pending.kind === 'worlds'
                ? { inline_keyboard: [[
                    { text: '📚 继续选择世界书', callback_data: 'act:worlds' },
                    { text: '‹ 返回主菜单', callback_data: 'act:menu' },
                ]] }
                : { inline_keyboard: [[{ text: '‹ 返回主菜单', callback_data: 'act:menu' }]] };
            await bot.editMessageText(text, {
                chat_id: pending.chatId,
                message_id: pending.messageId,
                reply_markup: resultMarkup,
            }).catch(async error => {
                log(`selection result edit failed: ${error.message}`);
                await sendPlain(pending.chatId, text);
            });
            if (data.ok && pending.kind === 'chats') {
                await requestHistory(pending.chatId, 0);
            }
            return;
        }

        if (data.type === 'history_response' && data.chatId && data.requestId) {
            await handleHistoryResponse(data).catch(error => log(`history response failed: ${error.message}`));
            return;
        }

        if (data.type === 'history_error' && data.chatId && data.requestId) {
            const pending = pendingHistoryRequests.get(data.requestId);
            if (pending) {
                pendingHistoryRequests.delete(data.requestId);
                await sendPlain(data.chatId, `无法读取历史：${data.text}`);
            }
            return;
        }

        if (data.type === 'message_mutation_result' && data.chatId && data.requestId) {
            await handleMessageMutationResult(data)
                .catch(error => log(`message mutation result failed: ${error.message}`));
            return;
        }

        if (data.type === 'chat_delete_result' && data.chatId && data.requestId) {
            await handleChatDeleteResult(data)
                .catch(error => log(`chat deletion result failed: ${error.message}`));
            return;
        }

        if (!data.chatId || (activeRequest && Number(data.chatId) !== Number(activeRequest.chatId))) return;
        if (['ai_reply', 'client_error'].includes(data.type) && data.requestId
            && (!activeRequest || activeRequest.requestId !== String(data.requestId))) return;

        if (['ai_reply', 'client_error', 'command_reply'].includes(data.type)) {
            if (data.type !== 'command_reply') finishRequest();
            const sender = data.type === 'ai_reply'
                ? finalizeGenerationStream(data)
                : data.type === 'client_error' && data.requestId
                    ? replaceGenerationStreamWithMessage(data)
                    : sendPlain(data.chatId, data.text);
            await sender.catch(error => log(`Telegram reply failed: ${error.message}`));
        }
    });

    socket.on('close', () => {
        clearTimeout(authTimer);
        if (browserClient === socket) {
            browserClient = null;
            browserStatus = null;
            if (activeRequest) {
                const { chatId, requestId, kind } = activeRequest;
                finishRequest();
                if (kind === 'auto') {
                    autoSession = null;
                    void sendPlain(chatId, '酒馆浏览器连接中断，自动剧情已经停止。已完成的内容仍保存在酒馆中。')
                        .catch(error => log(`auto disconnect reply failed: ${error.message}`));
                } else {
                    void replaceGenerationStreamWithMessage({
                        requestId,
                        chatId,
                        text: '酒馆浏览器连接中断，本次生成未能返回。请稍后重试。',
                    }).catch(error => log(`disconnect reply failed: ${error.message}`));
                }
            }
            log('SillyTavern browser disconnected');
        }
    });
});

const heartbeat = setInterval(() => {
    const cutoff = Date.now() - (15 * 60 * 1_000);
    for (const [id, session] of menuSessions) {
        if (session.createdAt < cutoff) menuSessions.delete(id);
    }
    for (const [id, pending] of pendingSelections) {
        if (pending.createdAt < cutoff) pendingSelections.delete(id);
    }
    for (const [id, session] of historySessions) {
        if (session.createdAt < cutoff) historySessions.delete(id);
    }
    for (const [id, pending] of pendingHistoryRequests) {
        if (pending.createdAt < cutoff) pendingHistoryRequests.delete(id);
    }
    const replyActionCutoff = Date.now() - REPLY_ACTION_TTL_MS;
    for (const [id, action] of replyActions) {
        if (action.createdAt < replyActionCutoff) consumeReplyAction(action);
    }
    const trimCutoff = Date.now() - TRIM_SESSION_TTL_MS;
    for (const [chatId, pending] of pendingTrimByChat) {
        if (pending.createdAt < trimCutoff) {
            pendingTrimByChat.delete(chatId);
            if (pending.promptMessageId) void bot.deleteMessage(chatId, pending.promptMessageId).catch(() => {});
        }
    }
    for (const [id, pending] of pendingMutations) {
        if (pending.createdAt < cutoff) pendingMutations.delete(id);
    }
    for (const [id, confirmation] of chatDeleteConfirmations) {
        if (confirmation.createdAt < cutoff) chatDeleteConfirmations.delete(id);
    }
    for (const [id, pending] of pendingChatDeletions) {
        if (pending.createdAt < cutoff) pendingChatDeletions.delete(id);
    }
    const autoConfigCutoff = Date.now() - AUTO_CONFIG_TTL_MS;
    for (const [chatId, pending] of pendingAutoConfigs) {
        if (pending.createdAt < autoConfigCutoff) {
            pendingAutoConfigs.delete(chatId);
            if (pending.promptMessageId) void bot.deleteMessage(chatId, pending.promptMessageId).catch(() => {});
        }
    }
    const streamCutoff = Date.now() - MAX_GENERATION_MS - 60_000;
    for (const [id, stream] of generationStreams) {
        if (stream.createdAt < streamCutoff) {
            closeGenerationStream(stream);
            generationStreams.delete(id);
        }
    }
    for (const socket of wss.clients) {
        if (!socket.isAlive) {
            socket.terminate();
            continue;
        }
        socket.isAlive = false;
        socket.ping();
    }
}, 30_000);

function isAllowedMessage(msg) {
    return msg.chat?.type === 'private' && allowedUserId && Number(msg.from?.id) === Number(allowedUserId);
}

bot.on('message', async msg => {
    const chatId = msg.chat?.id;
    const text = msg.text?.trim();
    if (!chatId || !text || msg.chat?.type !== 'private') return;

    if (!allowedUserId) {
        const pairMatch = text.match(/^\/(?:start|pair)(?:@\w+)?\s+([A-Za-z0-9_-]+)$/);
        if (pairMatch && config.pairingCode && pairMatch[1] === String(config.pairingCode)) {
            persistAllowedUser(msg.from.id);
            await sendPlain(chatId, '配对成功。现在直接发送文字即可与酒馆中的当前角色聊天。');
            log('Telegram owner paired');
        } else {
            await sendPlain(chatId, '机器人尚未配对。请使用安装时提供的一次性配对命令。');
        }
        return;
    }

    if (!isAllowedMessage(msg)) return;
    recordMessageId(chatId, msg.message_id, Number(msg.date) * 1_000);

    const commandMatch = text.match(/^\/([a-zA-Z]+)(?:@\w+)?(?:\s|$)/);
    const command = commandMatch?.[1]?.toLowerCase();
    const commandArgs = commandMatch ? text.slice(commandMatch[0].length).trim() : '';
    if (command === 'cancel') {
        const cancelledTrim = await cancelTrimSession(chatId, false);
        const cancelledAuto = await cancelAutoConfig(chatId, false);
        if (cancelledTrim || cancelledAuto) await sendPlain(chatId, '已取消当前待填写操作。');
        else await sendPlain(chatId, '当前没有待取消的操作。');
        return;
    }

    const pendingTrim = pendingTrimByChat.get(Number(chatId));
    if (pendingTrim && Number(msg.reply_to_message?.message_id) === Number(pendingTrim.promptMessageId)) {
        if (activeRequest) {
            await sendPlain(chatId, '正在生成回复，暂时不能截断历史消息。');
            return;
        }
        if (hasPendingMutationForAction(pendingTrim.action.id)) {
            await sendPlain(chatId, '这条回复的另一个修改正在进行，请稍候。');
            return;
        }
        pendingTrimByChat.delete(Number(chatId));
        const marker = text.replace(/^保留到[:：]\s*/, '').trim();
        if (!marker) {
            await sendPlain(chatId, '截断位置不能为空，请重新点击“截断后半段”。');
            return;
        }
        const sent = startMessageMutation({
            chatId,
            operation: 'trim',
            action: pendingTrim.action,
            marker,
            promptMessageId: pendingTrim.promptMessageId,
            inputMessageId: msg.message_id,
        });
        if (!sent) {
            await deleteTelegramMessageIds(chatId, [pendingTrim.promptMessageId, msg.message_id]);
            await sendPlain(chatId, '酒馆浏览器尚未连接，未修改历史消息。');
        }
        return;
    }

    const pendingAutoConfig = pendingAutoConfigs.get(Number(chatId));
    if (pendingAutoConfig && Number(msg.reply_to_message?.message_id) === Number(pendingAutoConfig.promptMessageId)) {
        pendingAutoConfigs.delete(Number(chatId));
        try {
            const settings = parseAutoConfigText(text);
            await startAutoSession(chatId, settings);
        } catch (error) {
            await sendPlain(chatId, `自动剧情设置无效：${error.message}`);
            await beginAutoConfig(chatId);
        }
        return;
    }

    if (command === 'start' || command === 'help') {
        await sendPlain(chatId, '直接发送文字即可聊天。每条助手回复下方都有“撤回”和“截断”按钮。\n/menu 打开控制菜单\n/auto 自动跑剧情\n/autopause 暂停自动剧情\n/autoresume 继续自动剧情\n/autostop 停止自动剧情\n/autostatus 查看自动剧情进度\n/stream 设置稳定或流式显示\n/wake 唤醒酒馆\n/stop 关闭酒馆（需要确认）\n/characters 选择角色\n/chats 从全部角色中选择已有对话\n/models 选择模型\n/worlds 选择世界书（可多选）\n/history 分页查看当前会话历史\n/undo 撤回酒馆当前会话的最后一条助手回复\n/new 新建当前角色的聊天\n/clear 清理机器人记录的近 48 小时消息（Telegram 禁止机器人删除更早消息）\n/status 查看连接状态');
        await sendMainMenu(chatId);
        return;
    }
    if (command === 'menu') {
        await sendMainMenu(chatId);
        return;
    }
    if (command === 'characters') {
        await requestMenu('characters', chatId);
        return;
    }
    if (command === 'chats') {
        await requestMenu('chats', chatId);
        return;
    }
    if (command === 'models') {
        await requestMenu('models', chatId);
        return;
    }
    if (command === 'worlds') {
        await requestMenu('worlds', chatId);
        return;
    }
    if (command === 'auto') {
        if (!commandArgs) await sendAutoMenu(chatId);
        else {
            try {
                await startAutoSession(chatId, parseAutoConfigText(commandArgs));
            } catch (error) {
                await sendPlain(chatId, `自动剧情设置无效：${error.message}`);
            }
        }
        return;
    }
    if (command === 'autopause') {
        await controlAutoSession(chatId, 'pause');
        return;
    }
    if (command === 'autoresume') {
        await controlAutoSession(chatId, 'resume');
        return;
    }
    if (command === 'autostop') {
        await controlAutoSession(chatId, 'stop');
        return;
    }
    if (command === 'autostatus') {
        await controlAutoSession(chatId, 'status');
        return;
    }
    if (command === 'stream') {
        if (/^(?:on|开|开启|流式)$/iu.test(commandArgs)) await setStreamingMode(chatId, true);
        else if (/^(?:off|关|关闭|稳定)$/iu.test(commandArgs)) await setStreamingMode(chatId, false);
        else await setStreamingMode(chatId, null);
        return;
    }
    if (command === 'history') {
        await requestHistory(chatId, 0);
        return;
    }
    if (command === 'wake') {
        await handleTavernStart(chatId);
        return;
    }
    if (command === 'stop') {
        await sendTavernStopConfirmation(chatId);
        return;
    }
    if (command === 'undo') {
        if (!await isTavernHttpReady()) {
            await sendPlain(chatId, '酒馆目前处于关闭状态，请先使用 /wake 唤醒。');
            return;
        }
        if (activeRequest) {
            await sendPlain(chatId, '正在生成回复，暂时不能撤回。');
            return;
        }
        const action = getLatestReplyAction(chatId);
        if (action && hasPendingMutationForAction(action.id)) {
            await sendPlain(chatId, '这条回复的修改正在进行，请稍候。');
            return;
        }
        if (!startMessageMutation({ chatId, operation: 'delete', action })) {
            await sendPlain(chatId, '酒馆浏览器尚未连接。');
        }
        return;
    }
    if (command === 'clear') {
        await clearTelegramScreen(chatId);
        return;
    }
    if (command === 'clearall') {
        await sendCompleteClearConfirmation(chatId);
        return;
    }
    if (command === 'status') {
        const ready = await isTavernHttpReady();
        if (!ready) {
            await sendPlain(chatId, 'Telegram 机器人在线，酒馆目前处于关闭状态。');
        } else if (!sendToBrowser({ type: 'status_request', chatId })) {
            await sendPlain(chatId, 'Telegram 机器人在线，酒馆服务已启动，但浏览器桥接尚未连接。');
        }
        return;
    }
    if (command === 'new') {
        if (!await isTavernHttpReady()) {
            await sendPlain(chatId, '酒馆目前处于关闭状态，请先使用 /wake 唤醒。');
        } else if (activeRequest) {
            await sendPlain(chatId, '上一条消息仍在生成，请稍后再试。');
        } else if (!sendToBrowser({ type: 'new_chat', chatId })) {
            await sendPlain(chatId, '酒馆浏览器尚未连接。');
        }
        return;
    }
    if (text.startsWith('/')) {
        await sendPlain(chatId, '未知命令。发送 /help 查看可用命令。');
        return;
    }
    if (activeRequest) {
        await sendPlain(chatId, '上一条消息仍在生成，请稍后再发。');
        return;
    }
    if (!await isTavernHttpReady()) {
        await sendPlain(chatId, '酒馆目前处于关闭状态，请先使用 /wake 唤醒。');
        return;
    }
    if (!isBrowserReady()) {
        await sendPlain(chatId, '酒馆浏览器尚未连接，请稍后重试。');
        return;
    }

    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    activeRequest = { requestId, chatId, startedAt: Date.now() };
    startTyping(chatId);
    generationTimer = setTimeout(() => {
        if (!activeRequest || activeRequest.requestId !== requestId) return;
        finishRequest();
        void replaceGenerationStreamWithMessage({
            requestId,
            chatId,
            text: '本次生成等待时间过长，已停止等待；酒馆页面可能仍在生成。',
        }).catch(error => log(`generation timeout reply failed: ${error.message}`));
    }, MAX_GENERATION_MS);

    if (!sendToBrowser({ type: 'user_message', requestId, chatId, text })) {
        finishRequest();
        await sendPlain(chatId, '酒馆浏览器刚刚断开，请重试。');
    }
});

bot.on('callback_query', async query => {
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const userId = query.from?.id;
    const callbackId = query.id;
    const data = String(query.data || '');

    if (!chatId || !messageId || Number(userId) !== Number(allowedUserId) || Number(chatId) !== Number(allowedUserId)) {
        if (callbackId) await bot.answerCallbackQuery(callbackId, { text: '无权使用此菜单', show_alert: true }).catch(() => {});
        return;
    }
    recordMessageId(chatId, messageId, Number(query.message?.date) * 1_000);

    if (data.startsWith('rev:')) {
        const [, operation, actionId] = data.split(':');
        const action = replyActions.get(actionId);
        if (!action || Number(action.chatId) !== Number(chatId)) {
            await bot.answerCallbackQuery(callbackId, { text: '这个操作已过期，可使用 /undo 撤回当前最后一条回复', show_alert: true }).catch(() => {});
            return;
        }
        if (!await isTavernHttpReady()) {
            await bot.answerCallbackQuery(callbackId, { text: '酒馆已关闭，请先唤醒', show_alert: true }).catch(() => {});
            return;
        }
        if (activeRequest) {
            await bot.answerCallbackQuery(callbackId, { text: '正在生成回复，请稍候', show_alert: true }).catch(() => {});
            return;
        }
        if (hasPendingMutationForAction(action.id)) {
            await bot.answerCallbackQuery(callbackId, { text: '这条回复的修改已在进行中', show_alert: true }).catch(() => {});
            return;
        }
        if (operation === 'undo') {
            if (!startMessageMutation({ chatId, operation: 'delete', action })) {
                await bot.answerCallbackQuery(callbackId, { text: '酒馆浏览器尚未连接', show_alert: true }).catch(() => {});
                return;
            }
            await bot.answerCallbackQuery(callbackId, { text: '正在同步撤回…' }).catch(() => {});
            return;
        }
        if (operation === 'trim') {
            await bot.answerCallbackQuery(callbackId, { text: '请按提示发送截断位置' }).catch(() => {});
            await beginTrimSession(chatId, action);
            return;
        }
        await bot.answerCallbackQuery(callbackId, { text: '未知操作', show_alert: true }).catch(() => {});
        return;
    }

    if (data.startsWith('auto:')) {
        const [, action, value] = data.split(':');
        await bot.answerCallbackQuery(callbackId).catch(() => {});
        if (action === 'preset') {
            await startAutoSession(chatId, {
                rounds: Number(value) || 5,
                perMessageChars: 0,
                totalChars: 0,
                delivery: 'live',
                outline: '',
            });
        } else if (action === 'custom') {
            if (activeRequest || autoSession) await sendPlain(chatId, '请先停止或等待当前任务结束，再配置新的自动剧情。');
            else await beginAutoConfig(chatId);
        } else if (['pause', 'resume', 'stop', 'status'].includes(action)) {
            await controlAutoSession(chatId, action);
        }
        return;
    }

    if (data.startsWith('stream:')) {
        const enabled = data.slice('stream:'.length) === 'on';
        await bot.answerCallbackQuery(callbackId).catch(() => {});
        await setStreamingMode(chatId, enabled);
        return;
    }

    if (data.startsWith('act:')) {
        const action = data.slice(4);
        await bot.answerCallbackQuery(callbackId).catch(() => {});
        if (action === 'menu') {
            await sendMainMenu(chatId);
        } else if (['characters', 'chats', 'models', 'presets', 'worlds'].includes(action)) {
            await requestMenu(action, chatId);
        } else if (action === 'auto') {
            await sendAutoMenu(chatId);
        } else if (action === 'stream') {
            await setStreamingMode(chatId, null);
        } else if (action === 'status') {
            const ready = await isTavernHttpReady();
            if (!ready) {
                await sendPlain(chatId, '酒馆目前处于关闭状态。');
            } else if (!sendToBrowser({ type: 'status_request', chatId })) {
                await sendPlain(chatId, '酒馆服务已启动，但浏览器桥接尚未连接。');
            }
        } else if (action === 'tavern_start') {
            await handleTavernStart(chatId);
        } else if (action === 'tavern_stop') {
            await sendTavernStopConfirmation(chatId);
        } else if (action === 'tavern_stop_confirm') {
            await handleTavernStop(chatId);
        } else if (action === 'history') {
            await requestHistory(chatId, 0);
        } else if (action === 'new') {
            if (!await isTavernHttpReady()) await sendPlain(chatId, '酒馆目前处于关闭状态，请先唤醒。');
            else if (activeRequest) await sendPlain(chatId, '上一条消息仍在生成，请稍后再试。');
            else if (!sendToBrowser({ type: 'new_chat', chatId })) await sendPlain(chatId, '酒馆浏览器尚未连接。');
        } else if (action === 'clear' || action === 'clear_confirm') {
            await clearTelegramScreen(chatId);
        } else if (action === 'clear_all') {
            await sendCompleteClearConfirmation(chatId, messageId);
        } else if (action === 'clear_all_cancel') {
            await bot.editMessageText('已取消彻底清屏，历史消息没有改变。', {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: mainMenuMarkup(),
            }).catch(error => log(`complete clear cancellation edit failed: ${error.message}`));
        } else if (action === 'clear_all_confirm') {
            await clearCompleteTelegramHistory(chatId);
        }
        return;
    }

    if (data.startsWith('noop:')) {
        await bot.answerCallbackQuery(callbackId).catch(() => {});
        return;
    }

    if (data.startsWith('pg:')) {
        const [, sessionId, pageText] = data.split(':');
        const session = menuSessions.get(sessionId);
        if (!session || Number(session.chatId) !== Number(chatId)) {
            await bot.answerCallbackQuery(callbackId, { text: '菜单已过期，请重新打开', show_alert: true }).catch(() => {});
            return;
        }
        const rendered = renderMenu(session, Number(pageText));
        await bot.answerCallbackQuery(callbackId).catch(() => {});
        await bot.editMessageText(rendered.text, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: rendered.reply_markup,
        }).catch(error => {
            if (!error.message.includes('message is not modified')) log(`menu page edit failed: ${error.message}`);
        });
        return;
    }

    if (data.startsWith('hist:')) {
        const [, sessionId, pageText] = data.split(':');
        const session = historySessions.get(sessionId);
        if (!session || Number(session.chatId) !== Number(chatId)) {
            await bot.answerCallbackQuery(callbackId, { text: '历史预览已过期，请重新打开', show_alert: true }).catch(() => {});
            return;
        }
        await bot.answerCallbackQuery(callbackId, { text: '正在读取…' }).catch(() => {});
        await requestHistory(chatId, Number(pageText), sessionId, messageId);
        return;
    }

    if (data.startsWith('chatdel:')) {
        const [, sessionId, indexText] = data.split(':');
        const session = menuSessions.get(sessionId);
        const index = Number(indexText);
        const item = session?.items?.[index];
        if (!session || session.kind !== 'chats' || Number(session.chatId) !== Number(chatId)
            || !Number.isInteger(index) || !item) {
            await bot.answerCallbackQuery(callbackId, { text: '对话列表已过期，请重新打开', show_alert: true }).catch(() => {});
            return;
        }
        if (activeRequest) {
            await bot.answerCallbackQuery(callbackId, { text: '正在生成回复，暂时不能删除', show_alert: true }).catch(() => {});
            return;
        }
        await bot.answerCallbackQuery(callbackId, { text: '请确认删除' }).catch(() => {});
        await beginChatDeleteConfirmation(chatId, messageId, session, item);
        return;
    }

    if (data.startsWith('chatdelok:')) {
        await confirmChatDeletion(callbackId, data.slice('chatdelok:'.length));
        return;
    }

    if (data.startsWith('chatdelno:')) {
        const confirmationId = data.slice('chatdelno:'.length);
        const confirmation = chatDeleteConfirmations.get(confirmationId);
        chatDeleteConfirmations.delete(confirmationId);
        await bot.answerCallbackQuery(callbackId, { text: '已取消' }).catch(() => {});
        await bot.editMessageText('已取消删除，对话没有改变。', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [[
                { text: '💬 返回已有对话', callback_data: 'act:chats' },
                { text: '‹ 返回主菜单', callback_data: 'act:menu' },
            ]] },
        }).catch(error => log(`chat deletion cancel edit failed: ${error.message}`));
        if (!confirmation) log(`chat deletion cancellation expired id=${JSON.stringify(confirmationId)}`);
        return;
    }

    if (data.startsWith('sel:')) {
        const [, sessionId, indexText] = data.split(':');
        const session = menuSessions.get(sessionId);
        const index = Number(indexText);
        const item = session?.items?.[index];
        if (!session || Number(session.chatId) !== Number(chatId) || !Number.isInteger(index) || !item) {
            await bot.answerCallbackQuery(callbackId, { text: '菜单已过期，请重新打开', show_alert: true }).catch(() => {});
            return;
        }
        if (activeRequest) {
            await bot.answerCallbackQuery(callbackId, { text: '正在生成回复，请稍后切换', show_alert: true }).catch(() => {});
            return;
        }
        const requestId = shortId();
        pendingSelections.set(requestId, {
            chatId,
            messageId,
            kind: session.kind,
            sessionId: session.id,
            createdAt: Date.now(),
        });
        const sent = sendToBrowser({
            type: 'menu_select',
            requestId,
            kind: session.kind,
            value: item.value,
            chatId,
        });
        if (!sent) {
            pendingSelections.delete(requestId);
            await bot.answerCallbackQuery(callbackId, { text: '酒馆浏览器尚未连接', show_alert: true }).catch(() => {});
            return;
        }
        await bot.answerCallbackQuery(callbackId, { text: session.kind === 'worlds' ? '正在更新世界书…' : '正在切换…' }).catch(() => {});
        if (session.kind !== 'worlds') {
            await bot.editMessageText(`${session.title}\n\n正在切换：${truncateLabel(item.label)}…`, {
                chat_id: chatId,
                message_id: messageId,
            }).catch(error => log(`selection progress edit failed: ${error.message}`));
        }
    }
});

bot.on('polling_error', error => log(`Telegram polling error: ${error.message}`));

async function start() {
    const me = await bot.getMe();
    botUsername = String(me.username || '');
    await bot.deleteWebhook({ drop_pending_updates: true });
    await bot.setMyCommands([
        { command: 'menu', description: '打开酒馆控制菜单' },
        { command: 'auto', description: '配置并启动自动剧情' },
        { command: 'autopause', description: '暂停自动剧情' },
        { command: 'autoresume', description: '继续自动剧情' },
        { command: 'autostop', description: '停止自动剧情' },
        { command: 'autostatus', description: '查看自动剧情进度' },
        { command: 'stream', description: '设置回复显示方式' },
        { command: 'wake', description: '唤醒酒馆' },
        { command: 'stop', description: '关闭酒馆' },
        { command: 'characters', description: '选择角色' },
        { command: 'chats', description: '从全部角色选择已有对话' },
        { command: 'models', description: '选择模型' },
        { command: 'worlds', description: '选择世界书（可多选）' },
        { command: 'history', description: '分页查看当前会话历史' },
        { command: 'undo', description: '撤回酒馆中最后一条助手回复' },
        { command: 'new', description: '新建当前角色的聊天' },
        { command: 'clear', description: '清理近48小时消息' },
        { command: 'clearall', description: '彻底清除全部私聊历史' },
        { command: 'status', description: '查看酒馆连接状态' },
        { command: 'help', description: '查看使用说明' },
    ]);
    log(`Telegram bot @${me.username} started`);
    void bot.startPolling();
}

async function shutdown(signal) {
    log(`Stopping after ${signal}`);
    clearInterval(heartbeat);
    stopGenerationIndicators();
    for (const stream of generationStreams.values()) closeGenerationStream(stream);
    await bot.stopPolling().catch(() => {});
    wss.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

start().catch(error => fail(`Telegram startup failed: ${error.message}`));
