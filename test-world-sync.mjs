import fs from 'node:fs';

const browserSource = fs.readFileSync(process.argv[2], 'utf8');
const bridgeSource = fs.readFileSync(process.argv[3], 'utf8');
const start = browserSource.indexOf('function normalizeWorldSelection');
const end = browserSource.indexOf('\n\nfunction applyLocalWorldSelection', start);
if (start < 0 || end < 0) throw new Error('Unable to extract world synchronization helpers');

eval(`${browserSource.slice(start, end)}\nglobalThis.worldSyncTestApi = { normalizeWorldSelection, selectedWorldsFromSettingsPayload };`);
const { normalizeWorldSelection, selectedWorldsFromSettingsPayload } = globalThis.worldSyncTestApi;
const names = ['Alpha', 'Beta', 'Gamma'];

const normalized = normalizeWorldSelection(['Beta', 'Missing', 'Beta', '', 'Alpha'], names);
if (JSON.stringify(normalized) !== JSON.stringify(['Beta', 'Alpha'])) throw new Error('World normalization failed');

const modern = selectedWorldsFromSettingsPayload({
    settings: JSON.stringify({ world_info_settings: { world_info: { globalSelect: ['Gamma', 'Missing'] } } }),
}, names);
if (JSON.stringify(modern) !== JSON.stringify(['Gamma'])) throw new Error('Modern settings parsing failed');

const legacy = selectedWorldsFromSettingsPayload({
    settings: { world_info_settings: { world_info: ['Alpha', 'Beta'] } },
}, names);
if (JSON.stringify(legacy) !== JSON.stringify(['Alpha', 'Beta'])) throw new Error('Legacy settings parsing failed');

const empty = selectedWorldsFromSettingsPayload({
    settings: JSON.stringify({ world_info_settings: { world_info: { globalSelect: [] } } }),
}, names);
if (!Array.isArray(empty) || empty.length !== 0) throw new Error('Empty selection parsing failed');

if (selectedWorldsFromSettingsPayload({ settings: '{}' }, names) !== null) throw new Error('Missing settings should not erase selection');
if (!browserSource.includes("type: 'worlds_changed'")) throw new Error('Browser does not announce world changes');
if (!browserSource.includes("data.type === 'world_sync'")) throw new Error('Browser does not receive world synchronization');
if (!browserSource.includes('Date.now() - lastExternalWorldSyncAt < 3_000')) throw new Error('Fresh peer state can be overwritten by stale server settings');
if (!bridgeSource.includes("data.type === 'worlds_changed'")) throw new Error('Bridge does not relay world changes');
if (!bridgeSource.includes("type: 'world_sync'")) throw new Error('Bridge world relay payload is missing');

console.log('world_sync_tests=10');
