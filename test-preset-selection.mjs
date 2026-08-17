import fs from 'node:fs';

const browserSource = fs.readFileSync(process.argv[2], 'utf8');
const bridgeSource = fs.readFileSync(process.argv[3], 'utf8');

const presetNames = ['创作预设', '简洁预设', '长篇预设'];
let selectedPreset = '简洁预设';
const presetManager = {
    getAllPresets: () => [...presetNames],
    getSelectedPresetName: () => selectedPreset,
    findPreset: name => presetNames.includes(name) ? name : undefined,
    selectPreset: value => { selectedPreset = value; },
};
const getPresetManager = () => presetManager;
const context = { mainApi: 'openai' };
const SillyTavern = { getContext: () => context };
const MODULE_NAME = 'preset-selection-test';
let generationBusy = false;
const sent = [];
const send = payload => sent.push(payload);
const getCurrentStatus = () => ({ preset: selectedPreset });

const statusStart = browserSource.indexOf('function currentPresetName');
const statusEnd = browserSource.indexOf('\n\nfunction getCurrentStatus', statusStart);
const menuStart = browserSource.indexOf('function presetMenuItems');
const menuEnd = browserSource.indexOf('\n\nfunction buildHistoryPage', menuStart);
const selectionStart = browserSource.indexOf('async function handleMenuSelection');
const selectionEnd = browserSource.indexOf('\n\nfunction narrativeCharCount', selectionStart);
if ([statusStart, statusEnd, menuStart, menuEnd, selectionStart, selectionEnd].some(value => value < 0)) {
    throw new Error('Unable to extract preset selection implementation');
}

eval(`${browserSource.slice(statusStart, statusEnd)}\n${browserSource.slice(menuStart, menuEnd)}\n${browserSource.slice(selectionStart, selectionEnd)}\n`
    + 'globalThis.presetTestApi = { currentPresetName, presetMenuItems, handleMenuSelection };');
const { currentPresetName, presetMenuItems, handleMenuSelection } = globalThis.presetTestApi;

if (currentPresetName() !== '简洁预设') throw new Error('Current preset name was not read');
let menu = presetMenuItems();
if (menu.api !== 'openai' || menu.current !== '简洁预设' || menu.items.length !== 3) {
    throw new Error(`Preset menu metadata is incorrect: ${JSON.stringify(menu)}`);
}
if (!menu.items.find(item => item.value === '简洁预设')?.label.startsWith('✓ ')) {
    throw new Error('Current preset is not marked');
}

await handleMenuSelection({ kind: 'presets', value: '长篇预设', requestId: 'p1', chatId: 1 });
if (selectedPreset !== '长篇预设') throw new Error('Preset was not selected');
if (!sent.some(item => item.type === 'selection_result' && item.ok && item.text === '已切换预设：长篇预设')) {
    throw new Error(`Successful preset selection was not reported: ${JSON.stringify(sent)}`);
}
menu = presetMenuItems();
if (!menu.items.find(item => item.value === '长篇预设')?.label.startsWith('✓ ')) {
    throw new Error('Selected preset marker did not refresh');
}

const originalConsoleError = console.error;
console.error = () => {};
try {
    await handleMenuSelection({ kind: 'presets', value: '已删除预设', requestId: 'p2', chatId: 1 });
} finally {
    console.error = originalConsoleError;
}
if (!sent.some(item => item.type === 'selection_result' && !item.ok && item.text.includes('不在当前可用列表'))) {
    throw new Error('Stale preset selection was not rejected');
}

for (const expected of [
    "callback_data: 'act:presets'",
    "['characters', 'chats', 'models', 'presets', 'worlds']",
    "data.kind === 'presets'",
    '预设：${data.preset',
]) {
    if (!bridgeSource.includes(expected) && !browserSource.includes(expected)) {
        throw new Error(`Preset integration is missing: ${expected}`);
    }
}

console.log('preset_selection_tests=12');
