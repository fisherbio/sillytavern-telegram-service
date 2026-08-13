'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = path.join(process.env.HOME, 'Library/Application Support/SillyTavernTelegramChrome');
const TARGET = 'http://127.0.0.1:8000/?stTelegramController=dedicated';
let child = null;
let stopping = false;

function log(message) {
    process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

function waitForSillyTavern() {
    return new Promise(resolve => {
        const attempt = () => {
            const request = http.get(TARGET, response => {
                response.resume();
                if (response.statusCode >= 200 && response.statusCode < 500) resolve();
                else setTimeout(attempt, 2_000);
            });
            request.setTimeout(2_000, () => request.destroy());
            request.on('error', () => setTimeout(attempt, 2_000));
        };
        attempt();
    });
}

async function run() {
    await waitForSillyTavern();
    if (stopping) return;
    log('Starting dedicated headless SillyTavern browser');
    child = spawn(CHROME, [
        '--headless=new',
        `--user-data-dir=${PROFILE}`,
        '--no-first-run',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-breakpad',
        '--disable-component-update',
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=9223',
        '--window-size=1280,1600',
        TARGET,
    ], { stdio: 'inherit' });

    child.once('exit', (code, signal) => {
        child = null;
        log(`Headless browser exited code=${code} signal=${signal}`);
        if (!stopping) setTimeout(() => void run(), 3_000);
    });
}

function stop() {
    stopping = true;
    if (child) child.kill('SIGTERM');
    else process.exit(0);
    setTimeout(() => process.exit(0), 5_000).unref();
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
void run();
