import fs from 'node:fs';

const browserSource = fs.readFileSync(process.argv[2], 'utf8');
const bridgeSource = fs.readFileSync(process.argv[3], 'utf8');
const helperStart = browserSource.indexOf('function extendMarkerEndThroughMarkdown');
const helperEnd = browserSource.indexOf('\n\nasync function handleMessageMutation', helperStart);
if (helperStart < 0 || helperEnd < 0) throw new Error('Unable to extract trim helpers');

eval(`${browserSource.slice(helperStart, helperEnd)}\n`
    + 'globalThis.trimTestApi = { findMarkerMatches, retainMessagePrefix };');
const { findMarkerMatches, retainMessagePrefix } = globalThis.trimTestApi;

const original = '第一段必须保留。\n第二段也要保留到这里。\n从这里开始全部删除。';
const marker = '也要保留到这里。';
const matches = findMarkerMatches(original, marker);
if (matches.length !== 1) throw new Error(`Expected one marker match, got ${matches.length}`);
const retained = retainMessagePrefix(original, matches[0]);
if (retained !== '第一段必须保留。\n第二段也要保留到这里。') {
    throw new Error(`Retained prefix is incorrect: ${JSON.stringify(retained)}`);
}
if (!original.startsWith(retained) || retained.includes('从这里开始全部删除')) {
    throw new Error('Retained content is not the exact original prefix');
}

const duplicates = findMarkerMatches('保留这里，稍后再次保留这里，最后删除。', '保留这里');
if (duplicates.length !== 2) throw new Error('Duplicate marker detection regressed');

const markdownOriginal = '前半段 **保留到这里** 后半段删除';
const markdownMatch = findMarkerMatches(markdownOriginal, '保留到这里');
if (retainMessagePrefix(markdownOriginal, markdownMatch[0]) !== '前半段 **保留到这里**') {
    throw new Error('Markdown closing delimiter was not retained');
}

const trimResultStart = bridgeSource.indexOf("if (pending.operation === 'trim')", bridgeSource.indexOf('async function handleMessageMutationResult'));
const trimResultEnd = bridgeSource.indexOf('\n    }', trimResultStart);
const trimResultBranch = bridgeSource.slice(trimResultStart, trimResultEnd);
const replacementIndex = trimResultBranch.indexOf('await sendAiReply');
const deletionIndex = trimResultBranch.indexOf('await deleteTelegramMessageIds');
if (replacementIndex < 0 || deletionIndex < 0 || replacementIndex > deletionIndex) {
    throw new Error('Telegram replacement must be sent before the original reply is deleted');
}

const pendingMutations = new Map();
const mutationEvents = [];
let failReplacement = false;
async function sendAiReply() {
    mutationEvents.push('send-replacement');
    if (failReplacement) throw new Error('simulated Telegram failure');
}
async function deleteTelegramMessageIds() {
    mutationEvents.push('delete-original');
}
function consumeReplyAction() {
    mutationEvents.push('consume-original-action');
}
async function beginTrimSession() {}
async function sendPlain() {}
const mutationStart = bridgeSource.indexOf('async function handleMessageMutationResult');
const mutationEnd = bridgeSource.indexOf('\n\nasync function beginTrimSession', mutationStart);
if (mutationStart < 0 || mutationEnd < 0) throw new Error('Unable to extract mutation result handler');
eval(`${bridgeSource.slice(mutationStart, mutationEnd)}\n`
    + 'globalThis.trimResultTestApi = { handleMessageMutationResult };');
const { handleMessageMutationResult } = globalThis.trimResultTestApi;

pendingMutations.set('success', {
    requestId: 'success', chatId: 1, operation: 'trim', action: { id: 'old', telegramMessageIds: [10] },
});
await handleMessageMutationResult({ requestId: 'success', chatId: 1, ok: true, text: retained, target: {} });
if (mutationEvents.join(',') !== 'send-replacement,delete-original,consume-original-action') {
    throw new Error(`Unexpected successful replacement order: ${mutationEvents.join(',')}`);
}

mutationEvents.length = 0;
failReplacement = true;
pendingMutations.set('failure', {
    requestId: 'failure', chatId: 1, operation: 'trim', action: { id: 'old', telegramMessageIds: [10] },
});
await handleMessageMutationResult({ requestId: 'failure', chatId: 1, ok: true, text: retained, target: {} }).catch(() => {});
if (mutationEvents.join(',') !== 'send-replacement') {
    throw new Error(`Original reply was deleted after replacement failure: ${mutationEvents.join(',')}`);
}

console.log('trim_prefix_tests=8');
