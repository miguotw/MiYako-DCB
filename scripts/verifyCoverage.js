'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TEST_DIRECTORY = path.join(PROJECT_ROOT, 'test');
const ALL_TESTS = fs.readdirSync(TEST_DIRECTORY)
    .filter(name => name.endsWith('.test.js'))
    .sort()
    .map(name => path.join('test', name));

function runCoverageGate({ label, includes, tests = ALL_TESTS, thresholds }) {
    const args = [
        '--experimental-test-coverage',
        ...includes.map(pattern => `--test-coverage-include=${pattern}`),
        ...Object.entries(thresholds).map(([metric, value]) => `--test-coverage-${metric}=${value}`),
        '--require', './test/setupConfig.js',
        '--test',
        ...tests
    ];
    const result = spawnSync(process.execPath, args, {
        cwd: PROJECT_ROOT,
        env: process.env,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024
    });
    if (result.status !== 0) {
        process.stdout.write(result.stdout || '');
        process.stderr.write(result.stderr || '');
        if (result.error) process.stderr.write(`${result.error.stack || result.error.message}\n`);
        if (!result.error && !result.stdout && !result.stderr) {
            process.stderr.write(`coverage child status=${result.status} signal=${result.signal || 'none'}\n`);
        }
        throw new Error(`Coverage gate 未通過：${label}`);
    }
    process.stdout.write(`✓ ${label}\n`);
}

function main() {
    runCoverageGate({
        label: '全部 production：line 80%、function 80%、branch 70%',
        includes: ['index.js', 'core/**/*.js', 'src/**/*.js', 'util/**/*.js', 'scripts/**/*.js'],
        thresholds: { lines: 80, functions: 80, branches: 70 }
    });
    const coreGates = [
        ['config', 'core/config.js', ['test/config.test.js']],
        ['Router', 'core/router.js', ['test/router.test.js', 'test/manifest.test.js']],
        ['Reply', 'core/Reply.js', ['test/reply.test.js']],
        ['JSON repository', 'core/jsonRepository.js', ['test/jsonRepository.test.js']]
    ];
    for (const [label, file, tests] of coreGates) {
        runCoverageGate({
            label: `${label}：line 90%`,
            includes: [file],
            tests,
            thresholds: { lines: 90 }
        });
    }
}

if (require.main === module) {
    try { main(); }
    catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { main, runCoverageGate };
