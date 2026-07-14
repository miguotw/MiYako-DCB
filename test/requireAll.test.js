'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const axios = require('axios');
const discord = require('discord.js');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PRODUCTION_ROOTS = ['core', 'src', 'util', 'scripts'];

function listJavaScriptFiles(directory) {
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...listJavaScriptFiles(target));
        else if (entry.isFile() && entry.name.endsWith('.js')) files.push(target);
    }
    return files;
}

test('所有 production modules 可在無本機 config 與無外部連線下安全載入', () => {
    const calls = { login: 0, rest: 0, http: 0 };
    const originalLogin = discord.Client.prototype.login;
    const originalPut = discord.REST.prototype.put;
    const originalAdapter = axios.defaults.adapter;
    discord.Client.prototype.login = async () => { calls.login += 1; throw new Error('smoke test 禁止登入 Discord'); };
    discord.REST.prototype.put = async () => { calls.rest += 1; throw new Error('smoke test 禁止發布指令'); };
    axios.defaults.adapter = async () => { calls.http += 1; throw new Error('smoke test 禁止外部 HTTP'); };

    try {
        const files = [
            path.join(PROJECT_ROOT, 'index.js'),
            ...PRODUCTION_ROOTS.flatMap(root => listJavaScriptFiles(path.join(PROJECT_ROOT, root)))
        ].sort();
        assert.ok(files.length >= 80, 'smoke test 應涵蓋完整 production module 集合');
        for (const file of files) {
            const exported = require(file);
            assert.notEqual(exported, undefined, `${path.relative(PROJECT_ROOT, file)} 必須可被 require`);
        }
        assert.deepEqual(calls, { login: 0, rest: 0, http: 0 });
    } finally {
        discord.Client.prototype.login = originalLogin;
        discord.REST.prototype.put = originalPut;
        axios.defaults.adapter = originalAdapter;
    }
});
