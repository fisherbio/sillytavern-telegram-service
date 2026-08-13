import fs from 'node:fs';
import yaml from 'yaml';

const source = fs.readFileSync(process.argv[2], 'utf8');
const NO_THINKING_BASE_MODEL = 'deepseek-v4-flash-0731';
const NO_THINKING_VARIANT_ID = '__telegram_variant__:deepseek-v4-flash-0731:no-thinking';
const NO_THINKING_VARIANT_LABEL = 'deepseek-v4-flash-0731 · 非推理';
const THINKING_BACKUP_STORAGE_KEY = 'st-telegram-safe:no-thinking-backup';
const storage = new Map();
const localStorage = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
};
const model_list = [
    { id: 'another-model', name: 'another-model' },
    { id: NO_THINKING_BASE_MODEL, name: NO_THINKING_BASE_MODEL },
];
const domValues = new Map();
function $(selector) {
    return {
        find: () => ({ each: () => {} }),
        val(value) {
            if (arguments.length) {
                domValues.set(selector, value);
                return this;
            }
            return domValues.get(selector);
        },
        trigger: () => {},
    };
}

const settings = {
    chat_completion_source: 'custom',
    custom_model: NO_THINKING_BASE_MODEL,
    custom_include_body: 'temperature: 0.5\n',
};
let saveCount = 0;
const context = {
    mainApi: 'openai',
    chatCompletionSettings: settings,
    getChatCompletionModel: () => settings.custom_model,
    saveSettingsDebounced: () => { saveCount += 1; },
};
const SillyTavern = { getContext: () => context };
const MODULE_NAME = 'virtual-model-test';
let generationBusy = false;
const sent = [];
const send = payload => sent.push(payload);
const getCurrentStatus = () => ({ model: settings.custom_model });

const helperStart = source.indexOf('function parseCustomIncludeBody');
const helperEnd = source.indexOf('\n\nasync function generateWithProviderRetry', helperStart);
const menuStart = source.indexOf('function modelSpec');
const menuEnd = source.indexOf('\n\nfunction buildHistoryPage', menuStart);
const selectionStart = source.indexOf('async function handleMenuSelection');
const selectionEnd = source.indexOf('\n\nfunction narrativeCharCount', selectionStart);
if ([helperStart, helperEnd, menuStart, menuEnd, selectionStart, selectionEnd].some(value => value < 0)) {
    throw new Error('Unable to extract virtual-model implementation');
}

eval(`${source.slice(helperStart, helperEnd)}\n${source.slice(menuStart, menuEnd)}\n${source.slice(selectionStart, selectionEnd)}\n`
    + 'globalThis.testApi = { parseCustomIncludeBody, setNoThinkingVariant, modelMenuItems, handleMenuSelection };');

const { parseCustomIncludeBody, setNoThinkingVariant, modelMenuItems, handleMenuSelection } = globalThis.testApi;

setNoThinkingVariant(settings, true);
let parsed = parseCustomIncludeBody(settings.custom_include_body);
if (parsed.temperature !== 0.5 || parsed.thinking?.type !== 'disabled') {
    throw new Error(`Enable variant failed: ${JSON.stringify(parsed)}`);
}
setNoThinkingVariant(settings, false);
parsed = parseCustomIncludeBody(settings.custom_include_body);
if (parsed.temperature !== 0.5 || Object.hasOwn(parsed, 'thinking')) {
    throw new Error(`Disable variant failed: ${JSON.stringify(parsed)}`);
}

settings.custom_include_body = 'temperature: 0.7\nthinking:\n  type: enabled\n  budget: 123\n';
setNoThinkingVariant(settings, true);
setNoThinkingVariant(settings, false);
parsed = parseCustomIncludeBody(settings.custom_include_body);
if (parsed.thinking?.type !== 'enabled' || parsed.thinking?.budget !== 123 || parsed.temperature !== 0.7) {
    throw new Error(`Thinking backup restore failed: ${JSON.stringify(parsed)}`);
}

settings.custom_include_body = 'temperature: 0.5\n';
let menu = modelMenuItems();
let baseIndex = menu.items.findIndex(item => item.value === NO_THINKING_BASE_MODEL);
if (baseIndex < 0 || menu.items[baseIndex + 1]?.value !== NO_THINKING_VARIANT_ID) {
    throw new Error('Virtual variant is not directly below the base model');
}
if (!menu.items[baseIndex].label.startsWith('✓ ') || menu.items[baseIndex + 1].label.startsWith('✓ ')) {
    throw new Error('Normal selection marker is incorrect');
}

await handleMenuSelection({ kind: 'models', value: NO_THINKING_VARIANT_ID, requestId: 'r1', chatId: 1 });
parsed = parseCustomIncludeBody(settings.custom_include_body);
if (settings.custom_model !== NO_THINKING_BASE_MODEL || parsed.thinking?.type !== 'disabled') {
    throw new Error(`Virtual selection failed: ${JSON.stringify({ settings, parsed })}`);
}
menu = modelMenuItems();
baseIndex = menu.items.findIndex(item => item.value === NO_THINKING_BASE_MODEL);
if (menu.items[baseIndex].label.startsWith('✓ ') || !menu.items[baseIndex + 1].label.startsWith('✓ ')) {
    throw new Error('Virtual selection marker is incorrect');
}

await handleMenuSelection({ kind: 'models', value: NO_THINKING_BASE_MODEL, requestId: 'r2', chatId: 1 });
parsed = parseCustomIncludeBody(settings.custom_include_body);
if (settings.custom_model !== NO_THINKING_BASE_MODEL || Object.hasOwn(parsed, 'thinking') || parsed.temperature !== 0.5) {
    throw new Error(`Normal selection restore failed: ${JSON.stringify({ settings, parsed })}`);
}
if (saveCount !== 2 || sent.filter(item => item.type === 'selection_result' && item.ok).length !== 2) {
    throw new Error(`Selection result/save mismatch: ${JSON.stringify({ saveCount, sent })}`);
}

settings.custom_model = 'another-model';
settings.custom_include_body = 'thinking:\n  type: enabled\n  budget: 456\n';
await handleMenuSelection({ kind: 'models', value: NO_THINKING_BASE_MODEL, requestId: 'r3', chatId: 1 });
parsed = parseCustomIncludeBody(settings.custom_include_body);
if (parsed.thinking?.type !== 'enabled' || parsed.thinking?.budget !== 456) {
    throw new Error(`Normal model switch changed an unrelated thinking setting: ${JSON.stringify(parsed)}`);
}

console.log('virtual_model_tests=11');
