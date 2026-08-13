import fs from 'node:fs';

const bridgeSource = fs.readFileSync(process.argv[2], 'utf8');
const browserSource = fs.readFileSync(process.argv[3], 'utf8');

function truncateLabel(input, max = 58) {
    const points = Array.from(String(input || '未命名'));
    return points.length > max ? `${points.slice(0, max - 1).join('')}…` : points.join('');
}

const renderStart = bridgeSource.indexOf('function renderMenu');
const renderEnd = bridgeSource.indexOf('\n\nasync function presentMenu', renderStart);
if (renderStart < 0 || renderEnd < 0) throw new Error('Unable to extract Telegram menu renderer');
eval(`${bridgeSource.slice(renderStart, renderEnd)}\n`
    + 'globalThis.chatDeleteMenuTestApi = { renderMenu };');
const { renderMenu } = globalThis.chatDeleteMenuTestApi;

const chatMenu = renderMenu({
    id: 'chat-session',
    kind: 'chats',
    items: [{ label: '角色甲 · 对话一', value: { characterIndex: 0, chatName: '对话一' } }],
    pageSize: 8,
}, 0);
if (chatMenu.reply_markup.inline_keyboard[0].length !== 2
    || chatMenu.reply_markup.inline_keyboard[0][1].callback_data !== 'chatdel:chat-session:0') {
    throw new Error('Existing-chat menu did not render a dedicated delete button');
}
const characterMenu = renderMenu({
    id: 'character-session',
    kind: 'characters',
    items: [{ label: '角色甲', value: 0 }],
    pageSize: 8,
}, 0);
if (characterMenu.reply_markup.inline_keyboard[0].length !== 1) {
    throw new Error('Delete button leaked into a non-chat menu');
}

const chatLists = new Map([
    [0, [
        { file_name: '当前对话.jsonl', chat_items: 4, last_mes: '2026-08-13T01:00:00Z' },
        { file_name: '旧对话.jsonl', chat_items: 2, last_mes: '2026-08-12T01:00:00Z' },
    ]],
    [1, [{ file_name: '角色乙对话.jsonl', chat_items: 3, last_mes: '2026-08-11T01:00:00Z' }]],
]);
const context = {
    characters: [{ name: '角色甲' }, { name: '角色乙' }],
    characterId: 0,
    chatId: '当前对话',
    getCurrentChatId() { return this.chatId; },
};
const SillyTavern = { getContext: () => context };
const getPastCharacterChats = async characterIndex => structuredClone(chatLists.get(Number(characterIndex)) || []);
let newChatDeletes = 0;
async function doNewChat({ deleteCurrentChat }) {
    if (!deleteCurrentChat) throw new Error('Current chat deletion did not request replacement chat creation');
    newChatDeletes += 1;
    chatLists.set(0, chatLists.get(0).filter(item => !item.file_name.startsWith('当前对话.')));
    chatLists.get(0).push({ file_name: '新对话.jsonl', chat_items: 1, last_mes: '2026-08-13T02:00:00Z' });
    context.chatId = '新对话';
}
async function deleteCharacterChatByName(characterIndex, chatName) {
    const index = Number(characterIndex);
    chatLists.set(index, chatLists.get(index).filter(item => item.file_name.replace(/\.jsonl$/iu, '') !== chatName));
}
function rememberCurrentConversation() {}
const generationBusy = false;
const MODULE_NAME = 'chat-delete-test';
const sent = [];
const send = payload => sent.push(payload);
const originalConsoleError = console.error;
console.error = () => {};

const menuDataStart = browserSource.indexOf('async function buildChatMenuData');
const menuDataEnd = browserSource.indexOf('\n\nasync function handleMenuRequest', menuDataStart);
const deleteStart = browserSource.indexOf('async function handleChatDelete');
const deleteEnd = browserSource.indexOf('\n\nfunction narrativeCharCount', deleteStart);
if ([menuDataStart, menuDataEnd, deleteStart, deleteEnd].some(index => index < 0)) {
    throw new Error('Unable to extract browser chat deletion helpers');
}
eval(`${browserSource.slice(menuDataStart, menuDataEnd)}\n${browserSource.slice(deleteStart, deleteEnd)}\n`
    + 'globalThis.chatDeleteBrowserTestApi = { buildChatMenuData, handleChatDelete };');
const { buildChatMenuData, handleChatDelete } = globalThis.chatDeleteBrowserTestApi;

const initialMenu = await buildChatMenuData();
if (initialMenu.items.length !== 3 || !initialMenu.items.some(item => item.isCurrent && item.chatName === '当前对话')) {
    throw new Error(`Chat menu metadata is incomplete: ${JSON.stringify(initialMenu)}`);
}

await handleChatDelete({ requestId: 'non-current', chatId: 1, value: { characterIndex: 1, chatName: '角色乙对话' } });
const nonCurrent = sent.at(-1);
if (!nonCurrent.ok || chatLists.get(1).length !== 0 || nonCurrent.menu.items.some(item => item.chatName === '角色乙对话')) {
    throw new Error(`Non-current chat deletion failed: ${JSON.stringify(nonCurrent)}`);
}

await handleChatDelete({ requestId: 'current', chatId: 1, value: { characterIndex: 0, chatName: '当前对话' } });
const current = sent.at(-1);
if (!current.ok || newChatDeletes !== 1 || context.chatId !== '新对话' || !current.text.includes('新建空白对话')) {
    throw new Error(`Current chat deletion did not safely replace the active chat: ${JSON.stringify(current)}`);
}

await handleChatDelete({ requestId: 'missing', chatId: 1, value: { characterIndex: 0, chatName: '不存在' } });
if (sent.at(-1).ok !== false || !sent.at(-1).text.includes('不存在')) {
    throw new Error('Missing chat deletion was not rejected');
}
console.error = originalConsoleError;

console.log('chat_delete_tests=10');
