'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadConfig } = require('../core/config');
const { createTwitchStreamFeature } = require('../src/modules/event/twitch_stream');

function twitchConfig() {
    const config = structuredClone(loadConfig());
    config.commands.stream.twitchClientId = 'client-id';
    config.commands.stream.twitchClientSecret = 'client-secret';
    return config;
}

test('205 個 Helix 參數固定拆成 100/100/5', async () => {
    const requests = [];
    const feature = createTwitchStreamFeature(twitchConfig(), {
        logTools: { sendLog() {} },
        httpClient: {
            post: async () => ({ data: { access_token: 'token', expires_in: 3600 } }),
            get: async url => { requests.push(url); return { data: { data: [] } }; }
        }
    });
    const values = Array.from({ length: 205 }, (_, index) => `login_${index}`);
    await feature._test.helixBatch({ twitchClientId: 'client-id', twitchClientSecret: 'secret' },
        'streams', 'user_login', values, new AbortController().signal);
    assert.equal(requests.length, 3);
    assert.deepEqual(requests.map(url => new URL(url).searchParams.getAll('user_login').length), [100, 100, 5]);
});

test('Helix 401 只重新取得 token 並重試一次', async () => {
    let tokenRequests = 0;
    let helixRequests = 0;
    const feature = createTwitchStreamFeature(twitchConfig(), {
        logTools: { sendLog() {} },
        httpClient: {
            post: async () => ({ data: { access_token: `token-${++tokenRequests}`, expires_in: 3600 } }),
            get: async () => {
                helixRequests += 1;
                if (helixRequests === 1) throw Object.assign(new Error('unauthorized'), { response: { status: 401 } });
                return { data: { data: [{ id: 'ok' }] } };
            }
        }
    });
    const result = await feature._test.helixBatch({ twitchClientId: 'client-id', twitchClientSecret: 'secret' },
        'users', 'login', ['target'], new AbortController().signal);
    assert.equal(tokenRequests, 2);
    assert.equal(helixRequests, 2);
    assert.equal(result[0].id, 'ok');
});

test('並行 Helix 工作共用同一個 OAuth token request', async () => {
    let tokenRequests = 0;
    let releaseToken;
    const tokenGate = new Promise(resolve => { releaseToken = resolve; });
    const feature = createTwitchStreamFeature(twitchConfig(), {
        logTools: { sendLog() {} },
        httpClient: {
            post: async () => {
                tokenRequests += 1;
                await tokenGate;
                return { data: { access_token: 'shared-token', expires_in: 3600 } };
            },
            get: async () => ({ data: { data: [] } })
        }
    });
    const streamConfig = { twitchClientId: 'client-id', twitchClientSecret: 'secret' };
    const first = feature._test.helixBatch(streamConfig, 'streams', 'user_login', ['one'], new AbortController().signal);
    const second = feature._test.helixBatch(streamConfig, 'users', 'login', ['two'], new AbortController().signal);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(tokenRequests, 1);
    releaseToken();
    await Promise.all([first, second]);
});

test('Twitch 身分組未設定或遺失時不提及 everyone', () => {
    const feature = createTwitchStreamFeature(twitchConfig(), { logTools: { sendLog() {} } });
    const guild = { id: 'guild', roles: { cache: new Map() } };
    for (const roleID of ['', 'missing-role', 'guild']) {
        const mention = feature._test.getMentionForTarget(guild, { roleID });
        assert.equal(mention.content, '');
        assert.deepEqual(mention.allowedMentions.parse, []);
        assert.deepEqual(mention.allowedMentions.roles, []);
    }
});

test('移除 Twitch 訂閱會立即更新舊通知且不產生 mention', async () => {
    const edits = [];
    const message = { edit: async payload => edits.push(payload) };
    const channel = { messages: { fetch: async () => message } };
    const guild = { channels: { cache: new Map([['channel', channel]]), fetch: async () => channel } };
    const client = { guilds: { cache: new Map([['guild', guild]]) } };
    const feature = createTwitchStreamFeature(twitchConfig(), { logTools: { sendLog() {} } });
    await feature.reconcileRemovedSubscription(client, 'guild', 'streamer', [{
        channelID: 'channel', messageID: 'message',
        stream: { user_login: 'streamer', title: 'title', viewer_count: 1 }
    }]);
    assert.equal(edits.length, 1);
    assert.deepEqual(edits[0].allowedMentions, { parse: [], roles: [], users: [] });
    assert.match(edits[0].content, /停止追蹤/);
});
