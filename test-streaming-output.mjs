import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const browserSource = fs.readFileSync(process.argv[2], 'utf8');
const bridgeSource = fs.readFileSync(process.argv[3], 'utf8');

const GENERATION_PROGRESS_INTERVAL_MS = 20;
const browserPayloads = [];
const listeners = new Map();
const eventSource = {
    on(name, listener) { listeners.set(name, listener); },
    removeListener(name, listener) {
        if (listeners.get(name) === listener) listeners.delete(name);
    },
};
const SillyTavern = {
    getContext: () => ({
        eventTypes: { STREAM_TOKEN_RECEIVED: 'stream_token_received' },
        eventSource,
    }),
};
const window = { setTimeout };
const send = payload => {
    browserPayloads.push(payload);
    return true;
};
const cleanTelegramNarrative = input => String(input || '');
const reporterStart = browserSource.indexOf('function createGenerationProgressReporter');
const reporterEnd = browserSource.indexOf('\n\nasync function generateWithProviderRetry', reporterStart);
if (reporterStart < 0 || reporterEnd < 0) throw new Error('Unable to extract progress reporter');
eval(`${browserSource.slice(reporterStart, reporterEnd)}\n`
    + 'globalThis.progressReporterTestApi = { createGenerationProgressReporter };');
const { createGenerationProgressReporter } = globalThis.progressReporterTestApi;

const reporter = createGenerationProgressReporter({ requestId: 'browser-1', chatId: 1 });
listeners.get('stream_token_received')('第一段');
await delay(5);
listeners.get('stream_token_received')('第一段第二段');
listeners.get('stream_token_received')('第一段第二段第三段');
await delay(35);
if (browserPayloads.length !== 2 || browserPayloads[0].text !== '第一段'
    || browserPayloads[1].text !== '第一段第二段第三段') {
    throw new Error(`Browser progress was not throttled/coalesced correctly: ${JSON.stringify(browserPayloads)}`);
}
reporter.stop();
if (listeners.has('stream_token_received')) throw new Error('Progress listener was not removed');

const MAX_TELEGRAM_CODEPOINTS = 3_800;
const STREAM_EDIT_INTERVAL_MS = 10;
const generationStreams = new Map();
let activeRequest = { requestId: 'bridge-1', chatId: 1 };
let nextMessageId = 100;
const bridgeEvents = [];
const log = message => bridgeEvents.push(`log:${message}`);
const bot = {
    async editMessageText(text, options) {
        bridgeEvents.push(`stream-edit:${options.message_id}:${text}`);
    },
};
async function sendTrackedMessage(_chatId, text) {
    const messageId = nextMessageId++;
    bridgeEvents.push(`stream-send:${messageId}:${text}`);
    return { message_id: messageId };
}
async function deleteTelegramMessageIds(_chatId, ids) {
    bridgeEvents.push(`delete-preview:${ids.join(',')}`);
}
async function sendAiReply(_chatId, text) {
    bridgeEvents.push(`final-send:${text}`);
    return { id: 'final-action' };
}
async function sendPlain(_chatId, text) {
    bridgeEvents.push(`plain-send:${text}`);
    return [];
}
const bridgeHelpersStart = bridgeSource.indexOf('function fixedTelegramStreamChunks');
const bridgeHelpersEnd = bridgeSource.indexOf('\n\nfunction consumeReplyAction', bridgeHelpersStart);
if (bridgeHelpersStart < 0 || bridgeHelpersEnd < 0) throw new Error('Unable to extract bridge stream helpers');
eval(`${bridgeSource.slice(bridgeHelpersStart, bridgeHelpersEnd)}\n`
    + 'globalThis.bridgeStreamTestApi = { fixedTelegramStreamChunks, beginGenerationStream, handleGenerationProgress, finalizeGenerationStream, replaceGenerationStreamWithMessage };');
const {
    fixedTelegramStreamChunks,
    beginGenerationStream,
    handleGenerationProgress,
    finalizeGenerationStream,
    replaceGenerationStreamWithMessage,
} = globalThis.bridgeStreamTestApi;

const longText = '🙂'.repeat(MAX_TELEGRAM_CODEPOINTS + 1);
const longChunks = fixedTelegramStreamChunks(longText);
if (longChunks.length !== 2 || longChunks.map(chunk => Array.from(chunk).length).join(',') !== '3800,1') {
    throw new Error('Unicode-safe Telegram stream chunking failed');
}

beginGenerationStream({ requestId: 'bridge-1', chatId: 1 });
handleGenerationProgress({ requestId: 'bridge-1', chatId: 1, text: '第一段' });
await delay(25);
handleGenerationProgress({ requestId: 'bridge-1', chatId: 1, text: '第一段第二段' });
await delay(25);
await finalizeGenerationStream({ requestId: 'bridge-1', chatId: 1, text: '第一段第二段第三段', target: {} });
const finalIndex = bridgeEvents.findIndex(event => event.startsWith('final-send:'));
const deleteIndex = bridgeEvents.findIndex(event => event.startsWith('delete-preview:'));
if (!bridgeEvents.some(event => event.startsWith('stream-send:'))
    || !bridgeEvents.some(event => event.startsWith('stream-edit:'))
    || finalIndex < 0 || deleteIndex < 0 || finalIndex > deleteIndex) {
    throw new Error(`Bridge streaming/finalization order failed: ${JSON.stringify(bridgeEvents)}`);
}

activeRequest = { requestId: 'bridge-2', chatId: 1 };
beginGenerationStream({ requestId: 'bridge-2', chatId: 1 });
handleGenerationProgress({ requestId: 'bridge-2', chatId: 1, text: '部分回复' });
await delay(25);
await replaceGenerationStreamWithMessage({ requestId: 'bridge-2', chatId: 1, text: '生成失败' });
const plainIndex = bridgeEvents.findIndex(event => event === 'plain-send:生成失败');
const lastDeleteIndex = bridgeEvents.map((event, index) => event.startsWith('delete-preview:') ? index : -1)
    .filter(index => index >= 0).at(-1);
if (plainIndex < 0 || lastDeleteIndex < plainIndex) {
    throw new Error('Error message must be sent before the partial stream is removed');
}

console.log('streaming_output_tests=9');
