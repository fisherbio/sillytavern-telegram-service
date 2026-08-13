import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const logPath = process.argv[2] || path.join(os.homedir(), 'SillyTavern/data/migration-server.log');
const descriptor = fs.openSync(logPath, 'r');
const stats = fs.fstatSync(descriptor);
const readBytes = Math.min(stats.size, 20_000_000);
const buffer = Buffer.alloc(readBytes);
fs.readSync(descriptor, buffer, 0, readBytes, stats.size - readBytes);
fs.closeSync(descriptor);
const text = buffer.toString('utf8');
const position = text.lastIndexOf('Chat Completion request: {');
const segment = position >= 0 ? text.slice(position) : '';
const roles = [...segment.matchAll(/\brole: ['"]([^'"]+)['"]/gu)].map(match => match[1]);
const models = [...segment.matchAll(/\bmodel: ['"]([^'"]+)['"]/gu)].map(match => match[1]);
const roleCounts = Object.fromEntries([...new Set(roles)].map(role => [role, roles.filter(value => value === role).length]));
console.log(JSON.stringify({
    logModifiedAt: stats.mtime.toISOString(),
    lastRequestFound: position >= 0,
    segmentChars: segment.length,
    roleCounts,
    roleSequence: roles,
    model: models.at(-1) || null,
    streamFinished: segment.includes('Streaming request finished'),
    saveMentions: [...segment.matchAll(/save(?:-append)?/giu)].length,
    integrityMentions: [...segment.matchAll(/integrity/giu)].length,
}));
