import {
    doNewChat,
    deleteCharacterChatByName,
    Generate,
    getPastCharacterChats,
    openCharacterChat,
    selectCharacterById,
    sendMessageAsUser,
    setExternalAbortController,
    syncMesToSwipe,
} from '../../../../script.js';
import { yaml } from '../../../../lib.js';
import { model_list } from '../../../openai.js';
import { allowScopedScripts } from '../../regex/engine.js';
import {
    getWorldInfoSettings,
    selected_world_info,
    updateWorldInfoSettings,
    world_names,
} from '../../../world-info.js';
import { BRIDGE_SECRET, BRIDGE_URL } from './bridge-config.js';

const MODULE_NAME = 'SillyTavern-Telegram-Personal';
const MAX_RECONNECT_DELAY_MS = 30_000;
const GENERATION_RETRY_DELAYS_MS = [3_000, 8_000];
const GENERATION_PROGRESS_INTERVAL_MS = 250;
const CONVERSATION_READY_TIMEOUT_MS = 30_000;
const NO_THINKING_BASE_MODEL = 'deepseek-v4-flash-0731';
const NO_THINKING_VARIANT_ID = '__telegram_variant__:deepseek-v4-flash-0731:no-thinking';
const NO_THINKING_VARIANT_LABEL = 'deepseek-v4-flash-0731 · 非推理';
const THINKING_BACKUP_STORAGE_KEY = 'st-telegram-safe:no-thinking-backup';
const CONVERSATION_STORAGE_KEY = 'st-telegram-safe:last-conversation';
const BRIDGE_CAPABILITIES = ['worlds-v1', 'auto-story-v1', 'chat-delete-v1'];
const FRONTEND_RENDER_TIMEOUT_MS = 8_000;
const IS_DEDICATED_CONTROLLER = new URLSearchParams(window.location.search).get('stTelegramController') === 'dedicated'
    || navigator.webdriver;

let socket = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let generationBusy = false;
let authenticated = false;
let autoRun = null;
let currentGenerationAbortController = null;

function normalizePromptText(value) {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) {
        return value
            .map(item => normalizePromptText(item))
            .filter(Boolean)
            .join('\n');
    }
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value === 'object') {
        for (const key of ['content', 'text', 'prompt', 'value']) {
            if (key in value) return normalizePromptText(value[key]);
        }
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    return String(value);
}

function normalizeCurrentPromptFields(context) {
    const character = context.characters?.[context.characterId];
    if (!character) return [];

    const normalized = [];
    const normalizeField = (target, field, label) => {
        if (!target || target[field] === undefined || typeof target[field] === 'string') return;
        const originalType = Array.isArray(target[field]) ? 'array' : typeof target[field];
        target[field] = normalizePromptText(target[field]);
        normalized.push(`${label}(${originalType})`);
    };

    const promptFields = [
        'system_prompt',
        'post_history_instructions',
        'description',
        'personality',
        'scenario',
        'mes_example',
        'creator_notes',
    ];
    for (const field of promptFields) {
        normalizeField(character, field, `character.${field}`);
        normalizeField(character.data, field, `character.data.${field}`);
    }
    normalizeField(character.data?.extensions?.depth_prompt, 'prompt', 'character.data.extensions.depth_prompt.prompt');
    normalizeField(context.chatMetadata, 'system_prompt', 'chatMetadata.system_prompt');
    normalizeField(context.chatMetadata, 'scenario', 'chatMetadata.scenario');

    if (normalized.length > 0) {
        console.warn(`[${MODULE_NAME}] normalized non-string prompt fields: ${normalized.join(', ')}`);
    }
    return normalized;
}

function prepareCharacterFrontendRendering(context) {
    if (!IS_DEDICATED_CONTROLLER) return;
    const character = context.characters?.[context.characterId];
    const scripts = character?.data?.extensions?.regex_scripts;
    if (!character || !Array.isArray(scripts) || scripts.length === 0) return;

    // The dedicated Telegram controller mirrors the rendering the owner has chosen
    // to use in SillyTavern. It runs in its own local-only browser profile.
    allowScopedScripts(character);
    for (const script of scripts) {
        if (typeof script?.replaceString !== 'string') continue;
        // Some cards ship full HTML in an unlabelled fence. Tavern Helper only
        // recognizes it as a frontend when the fence is explicitly marked html.
        script.replaceString = script.replaceString.replace(
            /^```\s*(?=<!doctype\s+html|<html\b)/iu,
            '```html\n',
        );
    }
}

function frontendIndicators(rawText) {
    const text = String(rawText || '');
    const indicators = [];
    const checks = [
        ['html-fence', /```(?:html|htm|css|javascript|js)\b/iu],
        ['html-document', /<!doctype\s+html|<html\b/iu],
        ['active-html', /<(?:style|script|iframe|canvas|svg)\b/iu],
        ['frontend-placeholder', /<StatusPlaceHolderImpl\s*\/>|<开局>/iu],
    ];
    for (const [name, expression] of checks) {
        if (expression.test(text)) indicators.push(name);
    }
    return indicators;
}

function cleanTelegramNarrative(input) {
    let text = String(input || '').replace(/\r\n/g, '\n');

    // Variable/state protocols are intended for SillyTavern extensions, not for
    // display in Telegram. The end tag is optional so partial streaming output is
    // cleaned as soon as a block begins.
    for (const tag of ['UpdateVariable', 'Analysis', 'JSONPatch']) {
        const expression = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?(?:<\\/${tag}>|$)`, 'giu');
        text = text.replace(expression, '');
    }

    text = text
        .replace(/```(?:html|htm|css|javascript|js|xml|svg)\b[\s\S]*?(?:```|$)/giu, '')
        .replace(/```\s*(?=<!doctype\s+html|<html\b)[\s\S]*?(?:```|$)/giu, '')
        .replace(/<!doctype\s+html[\s\S]*?(?:<\/html>|$)/giu, '')
        .replace(/<(?:style|script)\b[^>]*>[\s\S]*?(?:<\/(?:style|script)>|$)/giu, '')
        .replace(/<iframe\b[^>]*>[\s\S]*?(?:<\/iframe>|$)/giu, '')
        .replace(/<StatusPlaceHolderImpl\s*\/>|<开局>/giu, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return text;
}

function visibleFrontendElements(root) {
    if (!root) return [];
    return [...root.querySelectorAll('iframe, canvas, .TH-render')]
        .filter(element => {
            if (element.classList?.contains('TH-render') && element.querySelector('iframe, canvas')) return false;
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width >= 180 && rect.height >= 80 && style.display !== 'none' && style.visibility !== 'hidden';
        });
}

async function prepareReplyPresentation(snapshot, requestId) {
    const rawText = String(snapshot?.message?.mes ?? '');
    const indicators = frontendIndicators(rawText);
    const hasTechnicalProtocol = /<(?:UpdateVariable|Analysis|JSONPatch)\b/iu.test(rawText);
    if (indicators.length === 0 && !hasTechnicalProtocol) {
        return { text: snapshot.text, frontend: null };
    }

    if (indicators.length > 0 && typeof window.TavernHelper?.refreshOneMessage === 'function') {
        try {
            await window.TavernHelper.refreshOneMessage(snapshot.index);
        } catch (error) {
            console.warn(`[${MODULE_NAME}] frontend refresh failed`, error);
        }
    }

    const deadline = Date.now() + FRONTEND_RENDER_TIMEOUT_MS;
    let elements = [];
    let stableSignature = '';
    let stableRounds = 0;
    while (indicators.length > 0 && Date.now() < deadline) {
        const root = document.querySelector(`#chat .mes[mesid="${snapshot.index}"] .mes_text`);
        elements = visibleFrontendElements(root);
        const signature = elements
            .map(element => {
                const rect = element.getBoundingClientRect();
                return `${element.tagName}:${Math.round(rect.width)}x${Math.round(rect.height)}`;
            })
            .join('|');
        if (signature && signature === stableSignature) stableRounds += 1;
        else stableRounds = 0;
        stableSignature = signature;
        if (elements.length > 0 && stableRounds >= 2) break;
        await new Promise(resolve => setTimeout(resolve, 300));
    }

    const visualIds = elements.slice(0, 3).map((element, index) => {
        const visualId = `${requestId}-${snapshot.index}-${index}`.replace(/[^a-zA-Z0-9_-]/g, '');
        element.dataset.telegramVisualId = visualId;
        return visualId;
    });
    const cleaned = cleanTelegramNarrative(rawText);
    return {
        text: cleaned || (visualIds.length > 0 ? '（前端界面见下图）' : '（已隐藏前端代码）'),
        frontend: visualIds.length > 0 ? {
            messageIndex: snapshot.index,
            fingerprint: snapshot.target?.fingerprint || '',
            visualIds,
            indicators,
        } : null,
    };
}

function setStatus(text, color = '') {
    const status = document.getElementById('telegram_personal_status');
    if (!status) return;
    status.textContent = text;
    status.style.color = color;
}

function send(payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN || !authenticated) return false;
    socket.send(JSON.stringify(payload));
    return true;
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(1_000 * (2 ** reconnectAttempt), MAX_RECONNECT_DELAY_MS);
    reconnectAttempt += 1;
    setStatus(`桥接服务未连接，${Math.ceil(delay / 1000)} 秒后重试…`, 'orange');
    reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, delay);
}

function closeSocket() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    authenticated = false;
    if (socket) {
        socket.onclose = null;
        socket.close();
        socket = null;
    }
}

function getCurrentStatus() {
    const context = SillyTavern.getContext();
    const character = context.characters?.[context.characterId]?.name
        ?? context.groups?.find(group => String(group.id) === String(context.groupId))?.name
        ?? '未选择角色';
    return {
        character,
        chat: context.chatId || '未选择对话',
        model: context.getChatCompletionModel?.() || '未知',
        source: context.chatCompletionSettings?.chat_completion_source || context.mainApi || '未知',
        worlds: Array.isArray(selected_world_info) ? [...selected_world_info] : [],
        worldCount: Array.isArray(world_names) ? world_names.length : 0,
        chatLength: Array.isArray(context.chat) ? context.chat.length : 0,
        busy: generationBusy,
    };
}

function normalizeChatName(value) {
    return String(value || '').replace(/\.jsonl$/iu, '').trim();
}

function worldMenuData(feedback = '') {
    const names = Array.isArray(world_names) ? world_names : [];
    const active = new Set(Array.isArray(selected_world_info) ? selected_world_info : []);
    const items = names.filter(Boolean).map(name => ({
        value: { action: 'toggle', name },
        label: `${active.has(name) ? '✅' : '⬜️'} ${name}`,
    }));
    if (active.size > 0) {
        items.unshift({
            value: { action: 'clear' },
            label: '🚫 取消全部已选世界书',
        });
    }
    const activeNames = names.filter(name => name && active.has(name));
    const activeSummary = activeNames.length > 0
        ? `：${activeNames.slice(0, 5).join('、')}${activeNames.length > 5 ? ` 等 ${activeNames.length} 本` : ''}`
        : '';
    return {
        title: `${feedback ? `${feedback}\n\n` : ''}选择世界书（可连续多选）\n已启用 ${activeNames.length} 本${activeSummary}`,
        items,
    };
}

function sameStringSet(left, right) {
    const a = [...new Set(left.map(String))].sort();
    const b = [...new Set(right.map(String))].sort();
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function applyWorldSelection(value) {
    const names = Array.isArray(world_names) ? world_names : [];
    const active = new Set(Array.isArray(selected_world_info) ? selected_world_info : []);
    const action = String(value?.action || 'toggle');
    let text;
    if (action === 'clear') {
        const count = active.size;
        active.clear();
        text = count > 0 ? `✅ 已取消全部世界书（${count} 本）` : '当前没有已启用的世界书';
    } else {
        const name = String(value?.name || '');
        if (!names.includes(name)) throw new Error('世界书不存在或已经被删除');
        const wasActive = active.has(name);
        if (wasActive) active.delete(name);
        else active.add(name);
        text = wasActive ? `✅ 已停用：${name}` : `✅ 已启用：${name}`;
    }

    const next = names.filter(name => name && active.has(name));
    const selectedIndexes = names
        .map((name, index) => name && active.has(name) ? String(index) : null)
        .filter(index => index !== null);
    $('#world_info').val(selectedIndexes).trigger('change.select2');
    updateWorldInfoSettings(getWorldInfoSettings(), next);
    await new Promise(resolve => setTimeout(resolve, 350));
    const actual = Array.isArray(selected_world_info) ? [...selected_world_info] : [];
    if (!sameStringSet(actual, next)) {
        throw new Error(`世界书状态校验失败（预期 ${next.length} 本，实际 ${actual.length} 本）`);
    }
    return { text, menu: worldMenuData(text) };
}

function readRememberedConversation() {
    try {
        const value = JSON.parse(localStorage.getItem(CONVERSATION_STORAGE_KEY) || 'null');
        return value && typeof value === 'object' && normalizeChatName(value.chatName) ? value : null;
    } catch {
        return null;
    }
}

function rememberCurrentConversation(context, { allowUnsaved = false } = {}) {
    const characterIndex = Number(context.characterId);
    const character = context.characters?.[characterIndex];
    const chatName = normalizeChatName(context.getCurrentChatId?.() || context.chatId);
    if (!Number.isInteger(characterIndex) || !character || !chatName) return false;
    localStorage.setItem(CONVERSATION_STORAGE_KEY, JSON.stringify({
        characterIndex,
        characterName: String(character.name || ''),
        characterAvatar: String(character.avatar || ''),
        chatName,
        allowUnsaved: Boolean(allowUnsaved),
        rememberedAt: new Date().toISOString(),
    }));
    return true;
}

function resolveRememberedCharacterIndex(context, remembered) {
    const exactIndex = Number(remembered?.characterIndex);
    if (Number.isInteger(exactIndex) && context.characters?.[exactIndex]) {
        const character = context.characters[exactIndex];
        if ((!remembered.characterAvatar || character.avatar === remembered.characterAvatar)
            && (!remembered.characterName || character.name === remembered.characterName)) return exactIndex;
    }
    return context.characters?.findIndex(character => character
        && ((remembered?.characterAvatar && character.avatar === remembered.characterAvatar)
            || (remembered?.characterName && character.name === remembered.characterName))) ?? -1;
}

async function openPersistedConversation(candidate) {
    let context = SillyTavern.getContext();
    const characterIndex = resolveRememberedCharacterIndex(context, candidate);
    if (!Number.isInteger(characterIndex) || characterIndex < 0) throw new Error('上次使用的角色已经不存在');
    const chats = await getPastCharacterChats(characterIndex);
    const chatName = normalizeChatName(candidate?.chatName);
    const exists = chats.some(chat => normalizeChatName(chat.file_name) === chatName);
    if (!exists) throw new Error('上次使用的对话已经不存在');
    if (String(context.characterId) !== String(characterIndex)) {
        await selectCharacterById(characterIndex, { switchMenu: false });
    }
    await openCharacterChat(chatName);
    context = SillyTavern.getContext();
    if (normalizeChatName(context.getCurrentChatId?.() || context.chatId) !== chatName
        || !Array.isArray(context.chat) || context.chat.length === 0) {
        throw new Error('恢复对话后没有读到聊天记录');
    }
    rememberCurrentConversation(context);
    return context;
}

async function findMostRecentPersistedConversation(context) {
    const characters = Array.isArray(context.characters) ? context.characters : [];
    const chatLists = await Promise.all(characters.map(async (character, characterIndex) => ({
        character,
        characterIndex,
        chats: character ? await getPastCharacterChats(characterIndex) : [],
    })));
    const candidates = chatLists.flatMap(item => item.chats.map(chat => ({
        characterIndex: item.characterIndex,
        characterName: String(item.character?.name || ''),
        characterAvatar: String(item.character?.avatar || ''),
        chatName: normalizeChatName(chat.file_name),
        lastMessageAt: new Date(chat.last_mes || 0).getTime() || 0,
    }))).filter(item => item.chatName)
        .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    return candidates[0] || null;
}

async function waitForConversationCatalog() {
    const deadline = Date.now() + CONVERSATION_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const context = SillyTavern.getContext();
        if (Array.isArray(context.characters) && context.characters.length > 0
            && typeof context.reloadCurrentChat === 'function') return context;
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('等待酒馆角色和会话目录初始化超时');
}

async function syncCurrentChatFromServer() {
    let context = await waitForConversationCatalog();
    if (typeof context.reloadCurrentChat !== 'function') {
        throw new Error('当前酒馆版本不支持重新加载会话');
    }

    const currentChatName = normalizeChatName(context.getCurrentChatId?.() || context.chatId);
    const currentCharacterIndex = Number(context.characterId);
    const currentCharacter = Number.isInteger(currentCharacterIndex) ? context.characters?.[currentCharacterIndex] : null;
    const remembered = readRememberedConversation();

    if (context.groupId !== undefined && context.groupId !== null && currentChatName) {
        await context.reloadCurrentChat();
        context = SillyTavern.getContext();
        if (Array.isArray(context.chat) && context.chat.length > 0) return context;
    }

    if (currentCharacter && currentChatName) {
        const rememberedCurrent = remembered
            && resolveRememberedCharacterIndex(context, remembered) === currentCharacterIndex
            && normalizeChatName(remembered.chatName) === currentChatName;
        if (rememberedCurrent && remembered.allowUnsaved && Array.isArray(context.chat) && context.chat.length > 0) {
            return context;
        }
        const chats = await getPastCharacterChats(currentCharacterIndex);
        const exists = chats.some(chat => normalizeChatName(chat.file_name) === currentChatName);
        if (exists) {
            await context.reloadCurrentChat();
            context = SillyTavern.getContext();
            if (Array.isArray(context.chat) && context.chat.length > 0) {
                rememberCurrentConversation(context);
                return context;
            }
        }
    }

    if (remembered && !remembered.allowUnsaved) {
        try {
            return await openPersistedConversation(remembered);
        } catch (error) {
            console.warn(`[${MODULE_NAME}] remembered conversation restore failed`, error);
            localStorage.removeItem(CONVERSATION_STORAGE_KEY);
        }
    }

    const mostRecent = await findMostRecentPersistedConversation(context);
    if (!mostRecent) throw new Error('专用浏览器没有选中有效对话，服务器上也没有可恢复的聊天记录');
    return openPersistedConversation(mostRecent);
}

function isRetryableGenerationError(error) {
    let serialized = '';
    try {
        serialized = JSON.stringify(error);
    } catch {
        serialized = String(error || '');
    }
    const text = [error?.message, error?.error?.message, error?.code, error?.status, serialized]
        .filter(Boolean)
        .join(' ');
    return /(?:\b503\b|SERVICE_BUSY|LITELLM_UNAVAILABLE|Service Unavailable|服务繁忙|模型服务暂时不可用)/iu.test(text);
}

function parseCustomIncludeBody(input) {
    const text = String(input || '').trim();
    if (!text) return {};
    const parsed = yaml.parse(text);
    if (Array.isArray(parsed)) {
        return parsed.reduce((result, item) => {
            if (item && typeof item === 'object' && !Array.isArray(item)) Object.assign(result, item);
            return result;
        }, {});
    }
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('自定义请求体必须是 YAML/JSON 对象');
    }
    return structuredClone(parsed);
}

function isNoThinkingBody(input) {
    try {
        return parseCustomIncludeBody(input)?.thinking?.type === 'disabled';
    } catch {
        return false;
    }
}

function readThinkingBackup() {
    try {
        const value = JSON.parse(localStorage.getItem(THINKING_BACKUP_STORAGE_KEY) || 'null');
        return value && typeof value === 'object' ? value : null;
    } catch {
        return null;
    }
}

function setNoThinkingVariant(settings, enabled) {
    const body = parseCustomIncludeBody(settings.custom_include_body);
    if (enabled) {
        if (!readThinkingBackup()) {
            const hadThinking = Object.hasOwn(body, 'thinking');
            localStorage.setItem(THINKING_BACKUP_STORAGE_KEY, JSON.stringify({
                hadThinking,
                value: hadThinking ? body.thinking : null,
            }));
        }
        body.thinking = { type: 'disabled' };
    } else {
        const backup = readThinkingBackup();
        if (backup?.hadThinking) body.thinking = backup.value;
        else delete body.thinking;
        localStorage.removeItem(THINKING_BACKUP_STORAGE_KEY);
    }
    settings.custom_include_body = Object.keys(body).length > 0 ? yaml.stringify(body) : '';
    $('#custom_include_body').val(settings.custom_include_body).trigger('input');
}

function createGenerationProgressReporter(data) {
    const context = SillyTavern.getContext();
    const eventName = context.eventTypes?.STREAM_TOKEN_RECEIVED;
    const eventSource = context.eventSource;
    if (!eventName || typeof eventSource?.on !== 'function' || typeof eventSource?.removeListener !== 'function') {
        return { flush() {}, stop() {} };
    }

    let latestText = '';
    let lastSentText = '';
    let lastSentAt = 0;
    let timer = null;
    let stopped = false;

    const flush = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        const visibleText = cleanTelegramNarrative(latestText);
        if (stopped || !visibleText || visibleText === lastSentText) return;
        if (send({
            type: 'generation_progress',
            requestId: data.requestId,
            chatId: data.chatId,
            text: visibleText,
        })) {
            lastSentText = visibleText;
            lastSentAt = Date.now();
        }
    };

    const onToken = text => {
        latestText = String(text || '');
        if (!latestText || latestText === lastSentText || timer) return;
        const wait = Math.max(0, GENERATION_PROGRESS_INTERVAL_MS - (Date.now() - lastSentAt));
        timer = window.setTimeout(flush, wait);
    };

    eventSource.on(eventName, onToken);
    return {
        flush,
        stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
            timer = null;
            eventSource.removeListener(eventName, onToken);
        },
    };
}

async function generateWithProviderRetry(data, type = 'normal', options = {}) {
    for (let attempt = 0; ; attempt += 1) {
        if (autoRun?.stopRequested) throw new Error('自动剧情已停止');
        const abortController = new AbortController();
        currentGenerationAbortController = abortController;
        try {
            setExternalAbortController(abortController);
            return await Generate(type, { ...options, signal: abortController.signal });
        } catch (error) {
            const retryDelay = GENERATION_RETRY_DELAYS_MS[attempt];
            if (autoRun?.stopRequested) throw error;
            if (!isRetryableGenerationError(error) || retryDelay === undefined) throw error;
            send({
                type: 'command_reply',
                requestId: data.requestId,
                chatId: data.chatId,
                text: `上游模型暂时繁忙，${Math.round(retryDelay / 1_000)} 秒后自动重试（${attempt + 1}/${GENERATION_RETRY_DELAYS_MS.length}）。不会重复写入你的消息。`,
            });
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        } finally {
            if (currentGenerationAbortController === abortController) currentGenerationAbortController = null;
        }
    }
}

function stableMessageFingerprint(message) {
    const input = JSON.stringify([
        Boolean(message?.is_user),
        Boolean(message?.is_system),
        String(message?.name || ''),
        String(message?.mes ?? ''),
        String(message?.send_date || ''),
    ]);
    let hash = 0x811c9dc5;
    for (let index = 0; index < input.length; index += 1) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}

function currentConversationIdentity(context = SillyTavern.getContext()) {
    return {
        chatId: String(context.getCurrentChatId?.() || context.chatId || ''),
        characterId: context.characterId === undefined ? null : String(context.characterId),
        groupId: context.groupId === undefined || context.groupId === null ? null : String(context.groupId),
    };
}

function makeMessageTarget(context, messageIndex, message) {
    return {
        ...currentConversationIdentity(context),
        messageIndex,
        fingerprint: stableMessageFingerprint(message),
    };
}

function latestAssistantSnapshot() {
    const context = SillyTavern.getContext();
    if (!Array.isArray(context.chat)) return null;

    for (let index = context.chat.length - 1; index >= 0; index -= 1) {
        const message = context.chat[index];
        if (!message || message.is_user || message.is_system) continue;
        const rendered = document.querySelector(`#chat .mes[mesid="${index}"] .mes_text`);
        const renderedText = rendered?.innerText?.replace(/\u00a0/g, ' ').trim();
        const text = renderedText || String(message.mes ?? '').trim();
        return {
            context,
            index,
            message,
            text,
            target: makeMessageTarget(context, index, message),
        };
    }
    return null;
}

function validateMutationTarget(target) {
    const context = SillyTavern.getContext();
    if (!Array.isArray(context.chat) || context.chat.length === 0) {
        throw new Error('当前对话没有可修改的消息');
    }
    const index = context.chat.length - 1;
    const message = context.chat[index];
    if (!message || message.is_user || message.is_system) {
        throw new Error('当前对话的最后一条不是助手回复');
    }
    if (context.chat.length <= 1) {
        throw new Error('不会撤回角色的初始问候语');
    }
    if (!target) return { context, index, message };

    const identity = currentConversationIdentity(context);
    const sameConversation = String(target.chatId || '') === identity.chatId
        && String(target.characterId ?? '') === String(identity.characterId ?? '')
        && String(target.groupId ?? '') === String(identity.groupId ?? '');
    if (!sameConversation) {
        throw new Error('你已切换角色或对话；请先切回原对话再操作');
    }
    if (Number(target.messageIndex) !== index) {
        throw new Error('这条回复已不是当前会话的最后一条，为避免误删已拒绝操作');
    }
    if (String(target.fingerprint || '') !== stableMessageFingerprint(message)) {
        throw new Error('这条酒馆消息已被修改，请使用最新回复下的按钮');
    }
    return { context, index, message };
}

function extendMarkerEndThroughMarkdown(text, initialEnd) {
    let end = initialEnd;
    const trailing = text.slice(end);
    const markdownCloser = trailing.match(/^(?:(?:\*\*|__|~~|`{1,3}|\*|_)+|\]\([^\n)]{0,500}\))/u);
    if (markdownCloser) end += markdownCloser[0].length;
    return end;
}

function findMarkerMatches(text, marker) {
    const exactMatches = [];
    let searchFrom = 0;
    while (searchFrom <= text.length - marker.length) {
        const start = text.indexOf(marker, searchFrom);
        if (start < 0) break;
        exactMatches.push({
            start,
            end: extendMarkerEndThroughMarkdown(text, start + marker.length),
        });
        searchFrom = start + 1;
    }
    if (exactMatches.length > 0) return exactMatches;

    const escapedParts = marker.trim().split(/\s+/).filter(Boolean)
        .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (escapedParts.length === 0) return [];
    const expression = new RegExp(escapedParts.join('\\s*'), 'gu');
    return [...text.matchAll(expression)].map(match => ({
        start: match.index,
        end: extendMarkerEndThroughMarkdown(text, match.index + match[0].length),
    }));
}

function retainMessagePrefix(original, match) {
    const cutEnd = Number(match?.end);
    if (!Number.isSafeInteger(cutEnd) || cutEnd <= 0 || cutEnd > original.length) {
        throw new Error('截断位置无效，请重新选择');
    }
    const retained = original.slice(0, cutEnd).trimEnd();
    if (!retained) throw new Error('不能把助手回复截断为空');
    if (retained === original.trimEnd()) throw new Error('你选择的位置已经在回复末尾，没有可删除的后续内容');
    return retained;
}

async function handleMessageMutation(data) {
    if (generationBusy) {
        send({
            type: 'message_mutation_result',
            requestId: data.requestId,
            chatId: data.chatId,
            ok: false,
            text: '正在生成回复，暂时不能修改历史消息',
        });
        return;
    }

    try {
        await syncCurrentChatFromServer();
        const { context, index, message } = validateMutationTarget(data.target || null);
        if (data.operation === 'delete') {
            await context.deleteMessage(index, undefined, false);
            await context.saveChat();
            send({
                type: 'message_mutation_result',
                requestId: data.requestId,
                chatId: data.chatId,
                operation: data.operation,
                ok: true,
                text: '已从酒馆中删除最后一条助手回复',
            });
            return;
        }

        if (data.operation === 'trim') {
            const marker = String(data.marker || '').trim();
            if (!marker) throw new Error('截断位置不能为空');
            const original = String(message.mes ?? '');
            const matches = findMarkerMatches(original, marker);
            if (matches.length === 0) throw new Error('在酒馆原文中没有找到这段文字；请复制原回复中连续的 5–20 个字');
            if (matches.length > 1) {
                send({
                    type: 'message_mutation_result',
                    requestId: data.requestId,
                    chatId: data.chatId,
                    operation: data.operation,
                    ok: false,
                    code: 'marker_ambiguous',
                    occurrenceCount: matches.length,
                    text: `这段文字在最新助手回复中出现了 ${matches.length} 次`,
                });
                return;
            }
            const retained = retainMessagePrefix(original, matches[0]);

            message.mes = retained;
            if (typeof message.extra?.display_text === 'string') message.extra.display_text = retained;
            context.chatMetadata.tainted = true;
            syncMesToSwipe(index);
            await context.eventSource.emit(context.eventTypes.MESSAGE_EDITED, index);
            context.updateMessageBlock(index, message);
            await context.eventSource.emit(context.eventTypes.MESSAGE_UPDATED, index);
            await context.saveChat();

            send({
                type: 'message_mutation_result',
                requestId: data.requestId,
                chatId: data.chatId,
                operation: data.operation,
                ok: true,
                text: retained,
                target: makeMessageTarget(context, index, message),
            });
            return;
        }

        throw new Error('未知的消息修改类型');
    } catch (error) {
        console.error(`[${MODULE_NAME}] message mutation failed`, error);
        send({
            type: 'message_mutation_result',
            requestId: data.requestId,
            chatId: data.chatId,
            operation: data.operation,
            ok: false,
            text: error?.message || '修改酒馆历史失败',
        });
    }
}

function modelSpec(source) {
    const specs = {
        openai: ['openai_model', '#model_openai_select'],
        claude: ['claude_model', '#model_claude_select'],
        openrouter: ['openrouter_model', '#model_openrouter_select'],
        ai21: ['ai21_model', '#model_ai21_select'],
        makersuite: ['google_model', '#model_google_select'],
        vertexai: ['vertexai_model', '#model_vertexai_select'],
        mistralai: ['mistralai_model', '#model_mistralai_select'],
        custom: ['custom_model', '#model_custom_select'],
        cohere: ['cohere_model', '#model_cohere_select'],
        perplexity: ['perplexity_model', '#model_perplexity_select'],
        groq: ['groq_model', '#model_groq_select'],
        electronhub: ['electronhub_model', '#model_electronhub_select'],
        chutes: ['chutes_model', '#model_chutes_select'],
        nanogpt: ['nanogpt_model', '#model_nanogpt_select'],
        deepseek: ['deepseek_model', '#model_deepseek_select'],
        aimlapi: ['aimlapi_model', '#model_aimlapi_select'],
        xai: ['xai_model', '#model_xai_select'],
        pollinations: ['pollinations_model', '#model_pollinations_select'],
        moonshot: ['moonshot_model', '#model_moonshot_select'],
        fireworks: ['fireworks_model', '#model_fireworks_select'],
        cometapi: ['cometapi_model', '#model_cometapi_select'],
        azure_openai: ['azure_openai_model', '#azure_openai_model'],
        zai: ['zai_model', '#model_zai_select'],
        siliconflow: ['siliconflow_model', '#model_siliconflow_select'],
        workers_ai: ['workers_ai_model', '#model_workers_ai_select'],
        minimax: ['minimax_model', '#model_minimax_select'],
    };
    return specs[source] || null;
}

function modelMenuItems() {
    const context = SillyTavern.getContext();
    if (context.mainApi !== 'openai') {
        throw new Error(`当前主接口是 ${context.mainApi}；Telegram 模型菜单目前只支持 Chat Completion 接口`);
    }

    const source = context.chatCompletionSettings?.chat_completion_source;
    const current = context.getChatCompletionModel?.() || '';
    const spec = modelSpec(source);
    const seen = new Set();
    const items = [];
    const add = (value, label = value) => {
        value = String(value || '').trim();
        if (!value || seen.has(value)) return;
        seen.add(value);
        items.push({ value, label: `${value === current ? '✓ ' : ''}${String(label || value)}` });
    };

    if (Array.isArray(model_list)) {
        model_list.forEach(model => add(model?.id, model?.name || model?.id));
    }
    if (spec) {
        $(spec[1]).find('option').each((_index, option) => add(option.value, option.textContent));
    }
    add(current, current);

    const noThinkingSelected = source === 'custom'
        && current === NO_THINKING_BASE_MODEL
        && isNoThinkingBody(context.chatCompletionSettings?.custom_include_body);
    if (source === 'custom') {
        if (!seen.has(NO_THINKING_BASE_MODEL)) add(NO_THINKING_BASE_MODEL, NO_THINKING_BASE_MODEL);
        const baseIndex = items.findIndex(item => item.value === NO_THINKING_BASE_MODEL);
        if (baseIndex >= 0) {
            if (noThinkingSelected) items[baseIndex].label = items[baseIndex].label.replace(/^✓\s+/u, '');
            items.splice(baseIndex + 1, 0, {
                value: NO_THINKING_VARIANT_ID,
                label: `${noThinkingSelected ? '✓ ' : ''}${NO_THINKING_VARIANT_LABEL}`,
            });
        }
    }

    return { source, current: noThinkingSelected ? NO_THINKING_VARIANT_LABEL : current, items };
}

function buildHistoryPage(requestedPage = 0, pageSize = 6) {
    const context = SillyTavern.getContext();
    const messages = Array.isArray(context.chat)
        ? context.chat
            .map((message, index) => ({ message, index }))
            .filter(item => item.message && !item.message.is_system)
        : [];
    const totalPages = Math.max(1, Math.ceil(messages.length / pageSize));
    const page = Math.min(Math.max(Number(requestedPage) || 0, 0), totalPages - 1);
    const end = Math.max(0, messages.length - (page * pageSize));
    const start = Math.max(0, end - pageSize);
    const selected = messages.slice(start, end);
    const historyMessages = selected.map(item => ({
        speaker: item.message.is_user
            ? `👤 ${item.message.name || context.name1 || '你'}`
            : `🤖 ${item.message.name || context.name2 || '角色'}`,
        text: String(item.message.mes || '（空消息）'),
        target: item.index === context.chat.length - 1
            && !item.message.is_user
            && context.chat.length > 1
            ? makeMessageTarget(context, item.index, item.message)
            : null,
    }));
    const character = context.characters?.[context.characterId]?.name || '未选择角色';
    return {
        title: `历史预览 · ${character}\n${context.chatId || '未选择对话'}`,
        messages: historyMessages,
        page,
        totalPages,
        messageCount: messages.length,
    };
}

async function handleHistoryRequest(data) {
    try {
        await syncCurrentChatFromServer();
        send({
            type: 'history_response',
            requestId: data.requestId,
            chatId: data.chatId,
            ...buildHistoryPage(data.page, data.pageSize || 6),
        });
    } catch (error) {
        send({ type: 'history_error', requestId: data.requestId, chatId: data.chatId, text: error?.message || '读取历史失败' });
    }
}

async function buildChatMenuData() {
    const context = SillyTavern.getContext();
    const characters = context.characters
        .map((character, index) => ({ character, index }))
        .filter(item => item.character?.name);
    const chatLists = await Promise.all(characters.map(async item => ({
        ...item,
        chats: await getPastCharacterChats(item.index),
    })));
    const currentChat = String(context.getCurrentChatId?.() || context.chatId || '').replace(/\.jsonl$/i, '');
    const items = chatLists.flatMap(item => item.chats.map(chat => {
        const chatName = String(chat.file_name || '').replace(/\.jsonl$/i, '');
        const isCurrent = String(item.index) === String(context.characterId) && chatName === currentChat;
        const count = Number(chat.chat_items || 0);
        return {
            value: { characterIndex: item.index, chatName },
            label: `${isCurrent ? '✓ ' : ''}${item.character.name} · ${chatName}${count ? ` (${count}条)` : ''}`,
            characterName: item.character.name,
            chatName,
            isCurrent,
            lastMessageAt: new Date(chat.last_mes || 0).getTime() || 0,
        };
    })).filter(item => item.value.chatName)
        .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    return { title: '选择或删除已有对话 · 全部角色', items };
}

async function handleMenuRequest(data) {
    const context = SillyTavern.getContext();
    try {
        if (data.kind === 'characters') {
            const items = context.characters
                .map((character, index) => ({ character, index }))
                .filter(item => item.character?.name)
                .map(item => ({
                    value: item.index,
                    label: `${String(item.index) === String(context.characterId) ? '✓ ' : ''}${item.character.name}`,
                }));
            send({ type: 'menu_response', kind: data.kind, chatId: data.chatId, title: '选择角色', items });
            return;
        }

        if (data.kind === 'chats') {
            const menu = await buildChatMenuData();
            send({
                type: 'menu_response',
                kind: data.kind,
                chatId: data.chatId,
                ...menu,
            });
            return;
        }

        if (data.kind === 'models') {
            const { source, current, items } = modelMenuItems();
            send({
                type: 'menu_response',
                kind: data.kind,
                chatId: data.chatId,
                title: `选择模型 · ${source}\n当前：${current}`,
                items,
            });
            return;
        }

        if (data.kind === 'worlds') {
            const menu = worldMenuData();
            send({
                type: 'menu_response',
                kind: data.kind,
                chatId: data.chatId,
                ...menu,
            });
            return;
        }

        throw new Error('未知菜单类型');
    } catch (error) {
        send({ type: 'menu_error', kind: data.kind, chatId: data.chatId, text: error?.message || '读取菜单失败' });
    }
}

async function handleMenuSelection(data) {
    if (generationBusy) {
        send({ type: 'selection_result', requestId: data.requestId, chatId: data.chatId, ok: false, text: '正在生成回复，暂时不能切换。' });
        return;
    }

    const context = SillyTavern.getContext();
    try {
        let text;
        if (data.kind === 'characters') {
            const index = Number(data.value);
            if (!Number.isInteger(index) || !context.characters?.[index]) throw new Error('角色不存在或已经被删除');
            await selectCharacterById(index, { switchMenu: false });
            text = `已切换角色：${context.characters[index].name}`;
        } else if (data.kind === 'chats') {
            const characterIndex = Number(data.value?.characterIndex);
            const chatName = String(data.value?.chatName || '').replace(/\.jsonl$/i, '');
            if (!Number.isInteger(characterIndex) || !context.characters?.[characterIndex]) throw new Error('会话所属角色不存在');
            if (!chatName) throw new Error('对话名称无效');
            const chats = await getPastCharacterChats(characterIndex);
            const exists = chats.some(chat => String(chat.file_name || '').replace(/\.jsonl$/i, '') === chatName);
            if (!exists) throw new Error('对话不存在或已经被删除');
            if (String(context.characterId) !== String(characterIndex)) {
                await selectCharacterById(characterIndex, { switchMenu: false });
            }
            await openCharacterChat(chatName);
            rememberCurrentConversation(SillyTavern.getContext());
            text = `已进入：${context.characters[characterIndex].name} · ${chatName}`;
        } else if (data.kind === 'models') {
            if (context.mainApi !== 'openai') throw new Error('当前接口不支持从 Telegram 切换模型');
            const source = context.chatCompletionSettings?.chat_completion_source;
            const spec = modelSpec(source);
            if (!spec) throw new Error(`暂不支持 ${source} 的模型切换`);
            const value = String(data.value || '').trim();
            const available = modelMenuItems().items.some(item => String(item.value) === value);
            if (!available) throw new Error('模型已经不在当前可用列表中');
            const noThinkingVariant = value === NO_THINKING_VARIANT_ID;
            const actualModel = noThinkingVariant ? NO_THINKING_BASE_MODEL : value;
            const leavingNoThinkingVariant = source === 'custom'
                && context.getChatCompletionModel?.() === NO_THINKING_BASE_MODEL
                && isNoThinkingBody(context.chatCompletionSettings.custom_include_body);
            context.chatCompletionSettings[spec[0]] = actualModel;
            if (source === 'custom') {
                if (noThinkingVariant) setNoThinkingVariant(context.chatCompletionSettings, true);
                else if (leavingNoThinkingVariant) setNoThinkingVariant(context.chatCompletionSettings, false);
                $('#custom_model_id').val(actualModel).trigger('input');
            }
            $(spec[1]).val(actualModel).trigger('change');
            context.saveSettingsDebounced();
            text = `已切换模型：${noThinkingVariant ? NO_THINKING_VARIANT_LABEL : actualModel}`;
        } else if (data.kind === 'worlds') {
            const result = await applyWorldSelection(data.value);
            text = result.text;
            await new Promise(resolve => setTimeout(resolve, 150));
            send({
                type: 'selection_result',
                requestId: data.requestId,
                kind: data.kind,
                chatId: data.chatId,
                ok: true,
                text,
                menu: result.menu,
                status: getCurrentStatus(),
            });
            return;
        } else {
            throw new Error('未知选择类型');
        }

        await new Promise(resolve => setTimeout(resolve, 150));
        send({ type: 'selection_result', requestId: data.requestId, kind: data.kind, chatId: data.chatId, ok: true, text, status: getCurrentStatus() });
    } catch (error) {
        console.error(`[${MODULE_NAME}] selection failed`, error);
        send({ type: 'selection_result', requestId: data.requestId, chatId: data.chatId, ok: false, text: error?.message || '切换失败' });
    }
}

async function handleChatDelete(data) {
    if (generationBusy) {
        send({
            type: 'chat_delete_result',
            requestId: data.requestId,
            chatId: data.chatId,
            ok: false,
            text: '正在生成回复，暂时不能删除对话。',
        });
        return;
    }

    const context = SillyTavern.getContext();
    try {
        const characterIndex = Number(data.value?.characterIndex);
        const chatName = String(data.value?.chatName || '').replace(/\.jsonl$/i, '');
        const character = context.characters?.[characterIndex];
        if (!Number.isInteger(characterIndex) || !character) throw new Error('会话所属角色不存在');
        if (!chatName) throw new Error('对话名称无效');

        const chats = await getPastCharacterChats(characterIndex);
        const exists = chats.some(chat => String(chat.file_name || '').replace(/\.jsonl$/i, '') === chatName);
        if (!exists) throw new Error('对话不存在或已经被删除');

        const currentChat = String(context.getCurrentChatId?.() || context.chatId || '').replace(/\.jsonl$/i, '');
        const isCurrent = String(context.characterId) === String(characterIndex) && currentChat === chatName;
        if (isCurrent) {
            await doNewChat({ deleteCurrentChat: true });
            rememberCurrentConversation(SillyTavern.getContext(), { allowUnsaved: true });
        } else {
            await deleteCharacterChatByName(String(characterIndex), chatName);
        }

        const remaining = await getPastCharacterChats(characterIndex);
        const stillExists = remaining.some(chat => String(chat.file_name || '').replace(/\.jsonl$/i, '') === chatName);
        if (stillExists) throw new Error('酒馆没有确认删除该对话');

        send({
            type: 'chat_delete_result',
            requestId: data.requestId,
            chatId: data.chatId,
            ok: true,
            text: `已删除：${character.name} · ${chatName}${isCurrent ? '；已为该角色新建空白对话' : ''}`,
            menu: await buildChatMenuData(),
        });
    } catch (error) {
        console.error(`[${MODULE_NAME}] chat deletion failed`, error);
        send({
            type: 'chat_delete_result',
            requestId: data.requestId,
            chatId: data.chatId,
            ok: false,
            text: error?.message || '删除对话失败',
        });
    }
}

function narrativeCharCount(input) {
    return Array.from(String(input || '').replace(/\s/gu, '')).length;
}

function clearSendTextarea() {
    const textarea = document.querySelector('#send_textarea');
    if (!textarea) return;
    textarea.value = '';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function autoOutlineInstruction(settings) {
    return settings.outline
        ? `\n剧情大纲与约束：\n${settings.outline}`
        : '\n没有额外大纲。自然遵循当前角色卡、用户人格、世界书和既有聊天上下文推进剧情。';
}

function autoLengthInstruction(settings) {
    return settings.perMessageChars > 0
        ? `本条正文尽量控制在约 ${settings.perMessageChars} 个中文字符；以叙事完整和自然为先，不要说明字数。`
        : '沿用当前角色卡和模型设置决定本条长度。';
}

function buildAutoUserPrompt(settings, roundNumber) {
    return [
        '这是自动剧情模式。请只扮演 {{user}}，生成 {{user}} 接下来的一条自然发言、动作或心理活动。',
        '不要替 {{char}} 说话，不要分析任务，不要提及自动模式、大纲、轮数或字数，也不要输出角色名前缀。',
        `当前计划为第 ${roundNumber}/${settings.rounds} 轮。${autoLengthInstruction(settings)}`,
        autoOutlineInstruction(settings),
    ].join('\n');
}

function buildAutoCharacterPrompt(settings, roundNumber) {
    return [
        '这是自动剧情模式。请只以 {{char}} 及角色卡允许的叙事视角自然回应刚才的 {{user}}。',
        '不要替 {{user}} 决定下一轮发言，不要分析任务，不要提及自动模式、大纲、轮数或字数。',
        `当前计划为第 ${roundNumber}/${settings.rounds} 轮。${autoLengthInstruction(settings)}`,
        autoOutlineInstruction(settings),
    ].join('\n');
}

function sendAutoState(status, statusText = '') {
    if (!autoRun) return;
    send({
        type: 'auto_state',
        sessionId: autoRun.sessionId,
        chatId: autoRun.chatId,
        status,
        statusText: statusText || status,
        roundsCompleted: autoRun.roundsCompleted,
        totalChars: autoRun.totalChars,
    });
}

async function waitForAutoResume() {
    let announced = false;
    while (autoRun?.pauseRequested && !autoRun.stopRequested) {
        autoRun.phase = 'paused';
        if (!announced) {
            sendAutoState('paused', '已暂停');
            announced = true;
        }
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    if (autoRun && !autoRun.stopRequested) {
        autoRun.phase = 'idle';
        if (announced) sendAutoState('running', '运行中');
    }
}

function handleAutoControl(data) {
    if (!autoRun || String(data.sessionId || '') !== autoRun.sessionId) return;
    const action = String(data.action || '');
    if (action === 'pause') {
        autoRun.pauseRequested = true;
    } else if (action === 'resume') {
        autoRun.pauseRequested = false;
    } else if (action === 'stop') {
        autoRun.stopRequested = true;
        autoRun.pauseRequested = false;
        // An impersonated user turn has not been written to history yet, so it is
        // safe to abort immediately. A character reply is allowed to finish to
        // avoid leaving a committed user turn without its matching response.
        if (autoRun.phase === 'impersonate') currentGenerationAbortController?.abort();
    }
}

async function handleAutoStart(data) {
    if (generationBusy || autoRun) {
        send({
            type: 'auto_finished',
            sessionId: data.sessionId,
            chatId: data.chatId,
            reason: 'failed',
            error: '酒馆当前正在生成，无法启动自动剧情',
            roundsCompleted: 0,
            totalChars: 0,
            transcript: [],
        });
        return;
    }

    const settings = {
        rounds: Math.min(Math.max(Number(data.settings?.rounds) || 10, 1), 30),
        perMessageChars: Math.min(Math.max(Number(data.settings?.perMessageChars) || 0, 0), 4_000),
        totalChars: Math.min(Math.max(Number(data.settings?.totalChars) || 0, 0), 120_000),
        delivery: data.settings?.delivery === 'final' ? 'final' : 'live',
        outline: String(data.settings?.outline || '').trim().slice(0, 12_000),
    };
    generationBusy = true;
    autoRun = {
        sessionId: String(data.sessionId),
        chatId: Number(data.chatId),
        settings,
        roundsCompleted: 0,
        totalChars: 0,
        transcript: [],
        pauseRequested: false,
        stopRequested: false,
        phase: 'starting',
    };
    let reason = 'completed';
    let errorText = '';

    try {
        const context = await syncCurrentChatFromServer();
        normalizeCurrentPromptFields(context);
        prepareCharacterFrontendRendering(context);
        sendAutoState('running', '运行中');

        const latestVisible = Array.isArray(context.chat)
            ? [...context.chat].reverse().find(message => message && !message.is_system)
            : null;
        let needsUserTurn = !latestVisible?.is_user;

        while (autoRun.roundsCompleted < settings.rounds && !autoRun.stopRequested) {
            await waitForAutoResume();
            if (autoRun.stopRequested) break;
            const roundNumber = autoRun.roundsCompleted + 1;

            if (needsUserTurn) {
                autoRun.phase = 'impersonate';
                const generated = await generateWithProviderRetry(data, 'impersonate', {
                    quiet_prompt: buildAutoUserPrompt(settings, roundNumber),
                    quietToLoud: true,
                });
                const userText = String(generated || '').trim();
                clearSendTextarea();
                if (autoRun.stopRequested) break;
                if (!userText) throw new Error('自动扮演用户时没有生成可用内容');
                await sendMessageAsUser(userText);
                const userTurn = {
                    role: 'user',
                    speaker: SillyTavern.getContext().name1 || '你',
                    text: userText,
                };
                autoRun.transcript.push(userTurn);
                autoRun.totalChars += narrativeCharCount(userText);
                send({
                    type: 'auto_turn',
                    sessionId: autoRun.sessionId,
                    chatId: autoRun.chatId,
                    ...userTurn,
                    roundsCompleted: autoRun.roundsCompleted,
                    totalChars: autoRun.totalChars,
                });
            }

            autoRun.phase = 'character';
            await generateWithProviderRetry(data, 'normal', {
                quiet_prompt: buildAutoCharacterPrompt(settings, roundNumber),
            });
            await new Promise(resolve => setTimeout(resolve, 150));
            const snapshot = latestAssistantSnapshot();
            if (!snapshot?.text) throw new Error('角色回复完成，但没有找到可发送的内容');
            const presentation = await prepareReplyPresentation(snapshot, `${autoRun.sessionId}-${roundNumber}`);
            rememberCurrentConversation(snapshot.context);
            const assistantTurn = {
                role: 'assistant',
                speaker: snapshot.message?.name || snapshot.context.name2 || '角色',
                text: presentation.text,
            };
            autoRun.transcript.push(assistantTurn);
            autoRun.totalChars += narrativeCharCount(presentation.text);
            autoRun.roundsCompleted += 1;
            needsUserTurn = true;
            send({
                type: 'auto_turn',
                sessionId: autoRun.sessionId,
                chatId: autoRun.chatId,
                ...assistantTurn,
                roundsCompleted: autoRun.roundsCompleted,
                totalChars: autoRun.totalChars,
                target: snapshot.target,
                frontend: presentation.frontend,
            });
            sendAutoState('running', '运行中');

            if (settings.totalChars > 0 && autoRun.totalChars >= settings.totalChars) {
                reason = 'total_chars';
                break;
            }
        }
        if (autoRun.stopRequested) reason = 'stopped';
    } catch (error) {
        if (autoRun?.stopRequested) reason = 'stopped';
        else {
            reason = 'failed';
            errorText = error?.message || '未知错误';
            console.error(`[${MODULE_NAME}] auto story failed`, error);
        }
    } finally {
        const finished = autoRun;
        autoRun = null;
        currentGenerationAbortController = null;
        generationBusy = false;
        clearSendTextarea();
        send({
            type: 'auto_finished',
            sessionId: finished?.sessionId || String(data.sessionId),
            chatId: finished?.chatId || Number(data.chatId),
            reason,
            error: errorText,
            roundsCompleted: finished?.roundsCompleted || 0,
            totalChars: finished?.totalChars || 0,
            transcript: finished?.transcript || [],
        });
    }
}

async function handleUserMessage(data) {
    if (generationBusy) {
        send({
            type: 'client_error',
            requestId: data.requestId,
            chatId: data.chatId,
            text: '上一条消息仍在生成，请稍后再发。',
        });
        return;
    }

    generationBusy = true;
    send({ type: 'generation_started', requestId: data.requestId, chatId: data.chatId });
    let progressReporter = null;

    try {
        const context = await syncCurrentChatFromServer();
        const normalizedPromptFields = normalizeCurrentPromptFields(context);
        prepareCharacterFrontendRendering(context);
        send({
            type: 'generation_context',
            requestId: data.requestId,
            chatId: data.chatId,
            character: context.characters?.[context.characterId]?.name || '未知角色',
            conversation: normalizeChatName(context.getCurrentChatId?.() || context.chatId),
            historyMessages: Array.isArray(context.chat) ? context.chat.length : 0,
            normalizedPromptFields,
        });
        await sendMessageAsUser(data.text);
        progressReporter = createGenerationProgressReporter(data);
        await generateWithProviderRetry(data);
        progressReporter.flush();
        await new Promise(resolve => setTimeout(resolve, 150));

        const snapshot = latestAssistantSnapshot();
        if (!snapshot?.text) throw new Error('生成完成，但没有找到可发送的助手回复');
        const presentation = await prepareReplyPresentation(snapshot, data.requestId);
        rememberCurrentConversation(snapshot.context);

        send({
            type: 'ai_reply',
            requestId: data.requestId,
            chatId: data.chatId,
            text: presentation.text,
            target: snapshot.target,
            frontend: presentation.frontend,
        });
    } catch (error) {
        console.error(`[${MODULE_NAME}] generation failed`, error);
        send({
            type: 'client_error',
            requestId: data.requestId,
            chatId: data.chatId,
            text: `酒馆生成失败：${error?.message || '未知错误'}`,
        });
    } finally {
        progressReporter?.stop();
        generationBusy = false;
    }
}

async function handleNewChat(data) {
    if (generationBusy) {
        send({ type: 'client_error', chatId: data.chatId, text: '正在生成回复，暂时不能新建聊天。' });
        return;
    }
    try {
        await doNewChat({ deleteCurrentChat: false });
        rememberCurrentConversation(SillyTavern.getContext(), { allowUnsaved: true });
        send({ type: 'command_reply', chatId: data.chatId, text: '已在当前角色下新建聊天。' });
    } catch (error) {
        send({ type: 'client_error', chatId: data.chatId, text: `新建聊天失败：${error?.message || '未知错误'}` });
    }
}

async function handleBridgeMessage(event) {
    let data;
    try {
        data = JSON.parse(event.data);
    } catch {
        return;
    }

    if (data.type === 'hello_ack') {
        authenticated = true;
        reconnectAttempt = 0;
        setStatus('已连接；Telegram 可用', 'green');
        send({ type: 'status', ...getCurrentStatus() });
        return;
    }

    if (!authenticated) return;
    if (data.type === 'user_message') await handleUserMessage(data);
    if (data.type === 'auto_start') await handleAutoStart(data);
    if (data.type === 'auto_control') handleAutoControl(data);
    if (data.type === 'new_chat') await handleNewChat(data);
    if (data.type === 'menu_request') await handleMenuRequest(data);
    if (data.type === 'menu_select') await handleMenuSelection(data);
    if (data.type === 'chat_delete') await handleChatDelete(data);
    if (data.type === 'history_request') await handleHistoryRequest(data);
    if (data.type === 'message_mutation') await handleMessageMutation(data);
    if (data.type === 'status_request') send({ type: 'status', chatId: data.chatId, ...getCurrentStatus() });
}

function connect() {
    if (socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(socket.readyState)) return;

    authenticated = false;
    setStatus('正在连接本机桥接服务…', 'orange');
    socket = new WebSocket(BRIDGE_URL);

    socket.onopen = () => {
        socket.send(JSON.stringify({
            type: 'hello',
            secret: BRIDGE_SECRET,
            capabilities: BRIDGE_CAPABILITIES,
            controllerPriority: IS_DEDICATED_CONTROLLER ? 100 : 10,
            clientMode: IS_DEDICATED_CONTROLLER ? 'dedicated-headless' : 'browser-tab',
        }));
    };
    socket.onmessage = event => void handleBridgeMessage(event);
    socket.onerror = () => setStatus('桥接连接错误', 'red');
    socket.onclose = () => {
        authenticated = false;
        socket = null;
        scheduleReconnect();
    };
}

jQuery(async () => {
    try {
        const settingsHtml = await $.get('/scripts/extensions/third-party/st-telegram-safe/settings.html');
        $('#extensions_settings').append(settingsHtml);
        $('#telegram_personal_reconnect').on('click', () => {
            closeSocket();
            reconnectAttempt = 0;
            connect();
        });
    } catch (error) {
        console.warn(`[${MODULE_NAME}] settings UI unavailable`, error);
    }
    try {
        await syncCurrentChatFromServer();
    } catch (error) {
        console.warn(`[${MODULE_NAME}] startup conversation recovery unavailable`, error);
    }
    connect();
});
