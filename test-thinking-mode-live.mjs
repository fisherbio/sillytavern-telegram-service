import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const sillyTavernRoot = process.env.SILLYTAVERN_ROOT || path.join(os.homedir(), 'SillyTavern');
const settingsPath = path.join(sillyTavernRoot, 'data/default-user/settings.json');
const secretsPath = path.join(sillyTavernRoot, 'data/default-user/secrets.json');
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).oai_settings;
const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
const activeSecret = secrets.api_key_custom?.find(item => item?.active)?.value;
if (!activeSecret) throw new Error('No active custom API key');

const endpoint = `${String(settings.custom_url).replace(/\/$/u, '')}/chat/completions`;
const model = 'deepseek-v4-flash-0731';
const prompt = '只回答最终数字，不要解释：一个水箱原来装了容量的三分之一；加入24升后，装到了容量的七分之五。水箱容量是多少升？';

function textFromValue(value) {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return '';
    return value.map(item => typeof item === 'string' ? item : String(item?.text || '')).join('');
}

async function runTrial(mode, sequence) {
    const requestBody = {
        model,
        messages: [
            { role: 'system', content: '遵守用户的输出格式，只给最终答案。' },
            { role: 'user', content: prompt },
        ],
        temperature: 0,
        max_tokens: 512,
        stream: true,
        stream_options: { include_usage: true },
    };
    if (mode !== 'default') requestBody.thinking = { type: mode };

    const started = performance.now();
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${activeSecret}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(120_000),
    });
    const headersMs = performance.now() - started;
    if (!response.ok) {
        const errorText = await response.text();
        return {
            sequence, mode, ok: false, status: response.status, headersMs: Math.round(headersMs),
            errorType: /thinking/iu.test(errorText) ? 'thinking-parameter-error' : 'upstream-error',
        };
    }

    let firstEventMs = null;
    let firstReasoningMs = null;
    let firstContentMs = null;
    let reasoning = '';
    let content = '';
    let usage = null;
    let finishReason = null;
    let buffer = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    const consumeData = line => {
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        let event;
        try {
            event = JSON.parse(payload);
        } catch {
            return;
        }
        const elapsed = performance.now() - started;
        if (firstEventMs === null) firstEventMs = elapsed;
        if (event.usage) usage = event.usage;
        const choice = event.choices?.[0];
        if (!choice) return;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta || choice.message || {};
        const reasoningPart = textFromValue(delta.reasoning_content)
            || textFromValue(delta.reasoning)
            || textFromValue(delta.thinking);
        const contentPart = textFromValue(delta.content);
        if (reasoningPart) {
            if (firstReasoningMs === null) firstReasoningMs = elapsed;
            reasoning += reasoningPart;
        }
        if (contentPart) {
            if (firstContentMs === null) firstContentMs = elapsed;
            content += contentPart;
        }
    };

    while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split(/\r?\n/u);
        buffer = lines.pop() || '';
        for (const line of lines) {
            if (line.startsWith('data:')) consumeData(line);
        }
        if (done) break;
    }
    if (buffer.startsWith('data:')) consumeData(buffer);

    const totalMs = performance.now() - started;
    const visibleThinkTag = /<think(?:>|\s)|<\/think>/iu.test(content);
    const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens
        ?? usage?.output_tokens_details?.reasoning_tokens
        ?? null;
    return {
        sequence,
        mode,
        ok: true,
        status: response.status,
        headersMs: Math.round(headersMs),
        firstEventMs: firstEventMs === null ? null : Math.round(firstEventMs),
        firstReasoningMs: firstReasoningMs === null ? null : Math.round(firstReasoningMs),
        firstContentMs: firstContentMs === null ? null : Math.round(firstContentMs),
        totalMs: Math.round(totalMs),
        reasoningChars: reasoning.length,
        reasoningTokens,
        contentChars: content.length,
        visibleThinkTag,
        finishReason,
        finalAnswer: content.replace(/<think>[\s\S]*?<\/think>/giu, '').trim().slice(-80),
        completionTokens: usage?.completion_tokens ?? usage?.output_tokens ?? null,
    };
}

const requestedOrder = process.argv.slice(2).filter(mode => ['default', 'disabled', 'enabled'].includes(mode));
const order = requestedOrder.length > 0
    ? requestedOrder
    : ['default', 'disabled', 'enabled', 'enabled', 'default', 'disabled', 'disabled', 'enabled', 'default'];
const results = [];
for (let index = 0; index < order.length; index += 1) {
    const result = await runTrial(order[index], index + 1).catch(error => ({
        sequence: index + 1,
        mode: order[index],
        ok: false,
        errorType: error?.name || 'request-error',
        errorMessage: String(error?.message || error).slice(0, 160),
    }));
    results.push(result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (index < order.length - 1) await delay(1_000);
}

const successful = results.filter(item => item.ok);
const summary = Object.fromEntries(['default', 'disabled', 'enabled'].map(mode => {
    const rows = successful.filter(item => item.mode === mode);
    const average = key => rows.length
        ? Math.round(rows.reduce((sum, item) => sum + (Number(item[key]) || 0), 0) / rows.length)
        : null;
    return [mode, {
        successful: rows.length,
        reasoningResponses: rows.filter(item => item.reasoningChars > 0 || item.reasoningTokens > 0 || item.visibleThinkTag).length,
        averageFirstContentMs: average('firstContentMs'),
        averageTotalMs: average('totalMs'),
        averageReasoningChars: average('reasoningChars'),
    }];
}));
process.stdout.write(`${JSON.stringify({ summary })}\n`);
