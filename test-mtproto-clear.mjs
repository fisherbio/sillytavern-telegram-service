import fs from 'node:fs';

const source = fs.readFileSync(process.argv[2], 'utf8');
const helperSource = fs.readFileSync(process.argv[3], 'utf8');
const parserStart = source.indexOf('function parseMtprotoResult');
const parserEnd = source.indexOf('\n\nfunction resetTelegramChatTracking', parserStart);
if (parserStart < 0 || parserEnd < 0) throw new Error('Unable to extract MTProto result parser');

eval(`${source.slice(parserStart, parserEnd)}\nglobalThis.mtprotoTestApi = { parseMtprotoResult };`);
const { parseMtprotoResult } = globalThis.mtprotoTestApi;

const parsed = parseMtprotoResult('diagnostic\n{"ok":true,"peer":"@example"}\n');
if (!parsed.ok || parsed.peer !== '@example') throw new Error('Latest JSON result was not parsed');

let rejected = false;
try { parseMtprotoResult('diagnostic only'); } catch { rejected = true; }
if (!rejected) throw new Error('Invalid MTProto output was accepted');
if (!source.includes("callback_data: 'act:clear_all_confirm'")) throw new Error('Permanent clear confirmation is missing');
if (!source.includes("callback_data: 'act:clear_all_cancel'")) throw new Error('Permanent clear cancellation is missing');
if (!source.includes('execFileAsync(MTPROTO_PYTHON_PATH')) throw new Error('MTProto tool is not executed safely');
if (!source.includes("'--peer', `@${botUsername}`")) throw new Error('Permanent clear is not fixed to the current bot');
if (!source.includes('resetTelegramChatTracking(chatId)')) throw new Error('Telegram tracking is not reset after permanent clear');
if (!source.includes('酒馆角色、会话、世界书和上下文均未删除')) throw new Error('Data-scope confirmation is missing');
if (!helperSource.includes('client.delete_messages(entity, message_ids, revoke=True)')) throw new Error('Messages are not revoked in explicit batches');
if (!helperSource.includes('MessageActionHistoryClear')) throw new Error('Telegram history-clear service markers are not recognized');
if (!helperSource.includes('if not is_history_clear_marker(message)')) throw new Error('History-clear service markers are not excluded from deletion');
if (!helperSource.includes('remaining_count = sum(1 for message in remaining if not is_history_clear_marker(message))')) throw new Error('Server-side verification is missing');
if (!helperSource.includes('"remainingCount": 0')) throw new Error('Verified zero remainder is not reported');
if (helperSource.includes('client.delete_dialog(')) throw new Error('Full clear must not hide the empty bot dialog');

console.log('mtproto_clear_tests=14');
