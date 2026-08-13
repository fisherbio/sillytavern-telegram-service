import fs from 'node:fs';

const bridgeSource = fs.readFileSync(process.argv[2], 'utf8');
const browserSource = fs.readFileSync(process.argv[3], 'utf8');

const AUTO_MAX_ROUNDS = 30;
const AUTO_MAX_PER_MESSAGE_CHARS = 4_000;
const AUTO_MAX_TOTAL_CHARS = 120_000;
const bridgeStart = bridgeSource.indexOf('function countNarrativeChars');
const bridgeEnd = bridgeSource.indexOf('\n\nfunction autoSettingsText', bridgeStart);
if (bridgeStart < 0 || bridgeEnd < 0) throw new Error('Unable to extract auto story configuration helpers');
eval(`${bridgeSource.slice(bridgeStart, bridgeEnd)}\n`
    + 'globalThis.autoBridgeTestApi = { countNarrativeChars, normalizeAutoSettings, parseAutoConfigText };');

const { countNarrativeChars, normalizeAutoSettings, parseAutoConfigText } = globalThis.autoBridgeTestApi;
const defaults = parseAutoConfigText('在雨夜的旧车站重逢，先克制后坦白。');
if (defaults.rounds !== 10 || defaults.perMessageChars !== 500 || defaults.outline !== '在雨夜的旧车站重逢，先克制后坦白。') {
    throw new Error(`Plain outline defaults failed: ${JSON.stringify(defaults)}`);
}

const custom = parseAutoConfigText([
    '轮数: 7',
    '单条字数: 650',
    '总字数: 7000',
    '推送: 结束后汇总',
    '大纲:',
    '第一幕相遇',
    '第二幕解决误会',
].join('\n'));
if (custom.rounds !== 7 || custom.perMessageChars !== 650 || custom.totalChars !== 7000
    || custom.delivery !== 'final' || custom.outline !== '第一幕相遇\n第二幕解决误会') {
    throw new Error(`Structured auto config parsing failed: ${JSON.stringify(custom)}`);
}

for (const invalid of [
    { rounds: 0 },
    { rounds: 31 },
    { perMessageChars: 49 },
    { totalChars: 121_000 },
]) {
    let rejected = false;
    try {
        normalizeAutoSettings(invalid);
    } catch {
        rejected = true;
    }
    if (!rejected) throw new Error(`Invalid auto settings were accepted: ${JSON.stringify(invalid)}`);
}
if (countNarrativeChars('你 好\n🙂') !== 3) throw new Error('Narrative character counting is not whitespace/Unicode safe');

const browserStart = browserSource.indexOf('function narrativeCharCount');
const browserEnd = browserSource.indexOf('\n\nfunction sendAutoState', browserStart);
if (browserStart < 0 || browserEnd < 0) throw new Error('Unable to extract auto story prompt helpers');
eval(`${browserSource.slice(browserStart, browserEnd)}\n`
    + 'globalThis.autoBrowserTestApi = { narrativeCharCount, buildAutoUserPrompt, buildAutoCharacterPrompt };');
const { narrativeCharCount, buildAutoUserPrompt, buildAutoCharacterPrompt } = globalThis.autoBrowserTestApi;
const promptSettings = { rounds: 7, perMessageChars: 650, outline: '在旧车站重逢' };
const userPrompt = buildAutoUserPrompt(promptSettings, 3);
const characterPrompt = buildAutoCharacterPrompt(promptSettings, 3);
if (!userPrompt.includes('{{user}}') || !userPrompt.includes('第 3/7 轮') || !userPrompt.includes('650')
    || !userPrompt.includes('在旧车站重逢') || !characterPrompt.includes('{{char}}')) {
    throw new Error('Auto story prompts lost persona, round, length, or outline constraints');
}
if (narrativeCharCount('甲 乙\n🙂') !== 3) throw new Error('Browser character counting is not whitespace/Unicode safe');

console.log('auto_story_tests=13');
