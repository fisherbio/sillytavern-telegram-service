import fs from 'node:fs';

const source = fs.readFileSync(process.argv[2], 'utf8');
const MODULE_NAME = 'conversation-recovery-test';
const CONVERSATION_STORAGE_KEY = 'st-telegram-safe:last-conversation';
const CONVERSATION_READY_TIMEOUT_MS = 100;
const storage = new Map();
const localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
};

const chatLists = {
    0: [{ file_name: '较早对话.jsonl', last_mes: '2026-08-06T10:00:00Z' }],
    1: [{ file_name: '最近对话.jsonl', last_mes: '2026-08-07T10:00:00Z' }],
};
let reloadCount = 0;
let selected = [];
let opened = [];
const context = {
    characters: [
        { name: '角色甲', avatar: 'a.png' },
        { name: '角色乙', avatar: 'b.png' },
    ],
    characterId: undefined,
    groupId: null,
    chatId: '',
    chat: [{ mes: '临时消息1' }, { mes: '临时消息2' }],
    getCurrentChatId() { return this.chatId; },
    async reloadCurrentChat() {
        reloadCount += 1;
        if (this.characterId !== undefined && this.chatId) {
            this.chat = Array.from({ length: this.chatId === '最近对话' ? 52 : 10 }, (_unused, index) => ({ mes: String(index) }));
        }
    },
};
const SillyTavern = { getContext: () => context };
async function getPastCharacterChats(characterIndex) {
    return chatLists[characterIndex] || [];
}
async function selectCharacterById(characterIndex) {
    selected.push(characterIndex);
    context.characterId = characterIndex;
}
async function openCharacterChat(chatName) {
    opened.push(chatName);
    context.chatId = chatName;
    context.chat = Array.from({ length: chatName === '最近对话' ? 52 : 10 }, (_unused, index) => ({ mes: String(index) }));
}

const helperStart = source.indexOf('function normalizeChatName');
const helperEnd = source.indexOf('\n\nfunction isRetryableGenerationError', helperStart);
if (helperStart < 0 || helperEnd < 0) throw new Error('Unable to extract conversation recovery helpers');
eval(`${source.slice(helperStart, helperEnd)}\n`
    + 'globalThis.conversationRecoveryTestApi = { readRememberedConversation, syncCurrentChatFromServer };');
const { readRememberedConversation, syncCurrentChatFromServer } = globalThis.conversationRecoveryTestApi;

let restored = await syncCurrentChatFromServer();
if (restored.characterId !== 1 || restored.chatId !== '最近对话' || restored.chat.length !== 52) {
    throw new Error('Neutral browser did not recover the most recently used persisted conversation');
}
if (selected.join(',') !== '1' || opened.join(',') !== '最近对话') {
    throw new Error(`Unexpected initial recovery operations: ${JSON.stringify({ selected, opened })}`);
}
const remembered = readRememberedConversation();
if (remembered?.characterName !== '角色乙' || remembered?.chatName !== '最近对话') {
    throw new Error(`Recovered conversation was not remembered: ${JSON.stringify(remembered)}`);
}

context.characterId = undefined;
context.chatId = '';
context.chat = [{ mes: '另一个临时消息' }];
chatLists[0][0].last_mes = '2026-08-08T10:00:00Z';
restored = await syncCurrentChatFromServer();
if (restored.characterId !== 1 || restored.chatId !== '最近对话') {
    throw new Error('Remembered Telegram conversation was not preferred after browser restart');
}

const reloadsBefore = reloadCount;
restored = await syncCurrentChatFromServer();
if (reloadCount !== reloadsBefore + 1 || restored.chat.length !== 52) {
    throw new Error('Valid persisted conversation was not reloaded from the server before generation');
}

context.characterId = 0;
context.chatId = '新对话';
context.chat = [];
localStorage.setItem(CONVERSATION_STORAGE_KEY, JSON.stringify({
    characterIndex: 0,
    characterName: '角色甲',
    characterAvatar: 'a.png',
    chatName: '新对话',
    allowUnsaved: true,
}));
const reloadsBeforeEmptyChat = reloadCount;
const opensBeforeEmptyChat = opened.length;
restored = await syncCurrentChatFromServer();
if (restored.characterId !== 0 || restored.chatId !== '新对话' || restored.chat.length !== 0) {
    throw new Error('New unsaved chat was not accepted before its first message');
}
if (reloadCount !== reloadsBeforeEmptyChat || opened.length !== opensBeforeEmptyChat) {
    throw new Error('New unsaved chat incorrectly triggered persisted conversation recovery');
}

console.log('conversation_recovery_tests=11');
