'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { Collection } = require('discord.js');
const { loadConfig } = require('../core/config');
const { createStoreRegistry } = require('../core/storeRegistry');
const {
    guildStates, getGuildState, summonToVoiceChannel, togglePause, removeQueuedTracks, clearQueue,
    beginTrackPreparation, endTrackPreparation, handleVoiceStateUpdate,
    cleanupState, isCurrentPanel
} = require('../util/musicPlayer');
const {
    CACHE_DIRECTORY, resolveBinaryPath, setProcessManager, cleanupOrphanedCache,
    ensureCacheCapacity, setProtectedCachePaths
} = require('../util/ytDlpManager');
const { createCommand } = require('../src/commands/music');

function interactionFixture(voiceChannel) {
    const calls = [];
    const panelMessage = {
        id: 'panel-message', channelId: 'text-channel', client: null,
        edit: async payload => { calls.push(['message.edit', payload]); return payload; }
    };
    const textChannel = {
        id: 'text-channel',
        send: async payload => ({ ...panelMessage, id: `panel-${calls.length}`, ...payload }),
        messages: { fetch: async () => panelMessage }
    };
    const client = {
        isReady: () => false,
        channels: { fetch: async id => id === 'text-channel' ? textChannel : voiceChannel }
    };
    panelMessage.client = client;
    const interaction = {
        client, guildId: 'music-guild', channelId: textChannel.id, channel: textChannel,
        guild: {
            id: 'music-guild',
            members: { fetch: async () => ({ voice: { channelId: 'different-channel' } }) }
        },
        member: { voice: { channel: voiceChannel } },
        user: { id: 'music-user', tag: 'music-user#0001' },
        message: panelMessage,
        customId: '', values: [], deferred: false, replied: false, calls,
        fields: { getTextInputValue: () => 'https://youtu.be/test-track' },
        inGuild: () => true,
        async reply(payload) { this.replied = true; calls.push(['reply', payload]); return payload; },
        async deferReply(payload) { this.deferred = true; calls.push(['deferReply', payload]); },
        async editReply(payload) { calls.push(['editReply', payload]); return payload; },
        async followUp(payload) { calls.push(['followUp', payload]); return payload; },
        async update(payload) { calls.push(['update', payload]); return payload; },
        async showModal(payload) { calls.push(['showModal', payload]); return payload; },
        async fetchReply() { return panelMessage; }
    };
    return { interaction, panelMessage, textChannel, calls };
}

function temporaryTrack(root, name, queueID = name) {
    const localPath = path.join(root, `${name}.webm`);
    fs.writeFileSync(localPath, name);
    return {
        queueID, localPath, title: name, url: `https://youtu.be/${name}`,
        channel: 'Artist', duration: 180, requestedBy: 'music-user', uploadDate: '20250101'
    };
}

test.before(() => {
    test.mock.method(console, 'log', () => {});
    test.mock.method(console, 'error', () => {});
});

test.after(() => {
    for (const state of guildStates.values()) cleanupState(state, true);
    test.mock.restoreAll();
});

test('音樂面板、序列、暫停、移除、清空與 preparation 狀態皆走公開 handler', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-music-lifecycle-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createStoreRegistry({ dataRoot: path.join(root, 'data') });
    const context = { store, signal: new AbortController().signal };
    const guild = {
        id: 'music-guild', voiceAdapterCreator: {},
        voiceStates: { cache: new Collection() }
    };
    const voiceChannel = { id: 'voice-channel', guild };
    const { interaction, panelMessage, calls } = interactionFixture(voiceChannel);
    const command = createCommand(loadConfig());

    const buttonRows = command._test.createButtons({ current: null, queue: [], paused: false });
    assert.equal(buttonRows.length, 2);
    assert.deepEqual(
        buttonRows.map(row => row.components.map(component => component.data.custom_id)),
        [['music_request', 'music_play_next', 'music_pause', 'music_skip'], ['music_queue_open:0', 'music_summon']]
    );
    assert.equal(buttonRows.every(row => row.components.length <= 5), true);

    await command.execute(interaction, context);
    const state = guildStates.get('music-guild');
    assert.ok(state);
    assert.equal(isCurrentPanel(state, panelMessage.id), true);
    state.voiceChannelID = voiceChannel.id;
    state.voiceChannel = voiceChannel;

    const existingConnection = new EventEmitter();
    existingConnection.state = { status: 'ready' };
    existingConnection.subscribe = () => {};
    existingConnection.destroy = () => {};
    state.connection = existingConnection;
    interaction.customId = 'music_summon';
    await command.buttonHandlers.music_summon(interaction, context);
    assert.match(calls.at(-1)[1].embeds[0].data.title, /召喚成功/);

    interaction.replied = false;
    interaction.message = { ...panelMessage, id: 'stale-panel' };
    await command.buttonHandlers.music_summon(interaction, context);
    assert.match(calls.at(-1)[1].embeds[0].data.description, /面板已過期/);
    interaction.replied = false;
    interaction.message = panelMessage;
    interaction.member.voice.channel = null;
    await command.buttonHandlers.music_summon(interaction, context);
    assert.match(calls.at(-1)[1].embeds[0].data.description, /先加入語音頻道/);
    interaction.member.voice.channel = voiceChannel;

    interaction.customId = 'music_request';
    await command.buttonHandlers.music_request(interaction, context);
    interaction.customId = 'music_play_next';
    await command.buttonHandlers.music_play_next(interaction, context);
    assert.equal(calls.filter(([name]) => name === 'showModal').length, 2);

    interaction.customId = 'music_pause';
    await command.buttonHandlers.music_pause(interaction, context);
    const current = temporaryTrack(root, 'current');
    state.current = current;
    assert.equal(togglePause(state), true);
    assert.equal(togglePause(state), false);
    await command.buttonHandlers.music_pause(interaction, context);

    state.queue = Array.from({ length: 12 }, (_, index) => temporaryTrack(root, `queue-${index}`, `queue-${index}`));
    interaction.customId = 'music_queue_open:1';
    await command.buttonHandlers.music_queue_open(interaction, context);
    interaction.customId = 'music_queue_page:0';
    await command.buttonHandlers.music_queue_page(interaction, context);

    interaction.customId = 'music_queue_remove:0';
    interaction.values = ['queue-0', 'queue-1'];
    await command.componentHandlers.music_queue_remove(interaction, context);
    assert.equal(state.queue.length, 10);

    interaction.customId = 'music_queue_clear';
    await command.buttonHandlers.music_queue_clear(interaction, context);
    interaction.customId = `music_queue_clear_modal:${interaction.channelId}:${panelMessage.id}`;
    interaction.fields = { getTextInputValue: () => 'y' };
    await command.modalSubmitHandlers.music_queue_clear_modal(interaction, context);
    assert.equal(state.queue.length, 0);

    state.queue = [temporaryTrack(root, 'direct-remove', 'direct-remove')];
    assert.equal(removeQueuedTracks(state, ['direct-remove']).length, 1);
    state.queue = [temporaryTrack(root, 'direct-clear', 'direct-clear')];
    assert.equal(clearQueue(state).length, 1);
    beginTrackPreparation(state);
    assert.equal(state.preparingTracks, 1);
    endTrackPreparation(state);
    assert.equal(state.preparingTracks, 0);
});

test('召喚等待 Ready、同頻道冪等，空閒可搬移但播放工作中拒絕', async t => {
    const guild = {
        id: 'summon-guild', voiceAdapterCreator: {},
        voiceStates: { cache: new Collection() }
    };
    const connections = [];
    class FakeConnection extends EventEmitter {
        constructor(channelID) {
            super();
            this.channelID = channelID;
            this.state = { status: 'connecting' };
            this.destroyed = false;
        }
        subscribe() {}
        destroy() { this.destroyed = true; this.state = { status: 'destroyed' }; }
    }
    const readyWaits = [];
    const state = getGuildState(guild.id, {
        inactivityTimeoutMinutes: 1,
        joinVoiceChannel(options) {
            const connection = new FakeConnection(options.channelId);
            connections.push(connection);
            return connection;
        },
        async entersState(connection, status) {
            readyWaits.push([connection.channelID, status]);
            connection.state = { status };
            return connection;
        }
    }, { persistSnapshot: async () => {} });
    t.after(() => cleanupState(state, true));
    const first = { id: 'voice-a', guild };
    const second = { id: 'voice-b', guild };

    assert.equal(await summonToVoiceChannel(state, first), 'joined');
    assert.equal(await summonToVoiceChannel(state, first), 'alreadyConnected');
    assert.equal(readyWaits.length, 2);
    assert.equal(await summonToVoiceChannel(state, second), 'moved');
    assert.equal(connections[0].destroyed, true);
    assert.ok(state.inactivityTimer, '召喚後沿用既有閒置退出計時器');

    state.current = { title: '正在播放' };
    await assert.rejects(summonToVoiceChannel(state, first), /正在其他語音頻道/);
    assert.equal(state.voiceChannelID, second.id);
    state.current = null;
    state.queue.push({ title: '排隊歌曲' });
    await assert.rejects(summonToVoiceChannel(state, first), /正在其他語音頻道/);
    state.queue.length = 0;
    state.preparingTracks = 1;
    await assert.rejects(summonToVoiceChannel(state, first), /正在其他語音頻道/);
    state.preparingTracks = 0;
    state.starting = true;
    await assert.rejects(summonToVoiceChannel(state, first), /正在其他語音頻道/);
    state.starting = false;
});

test('音樂下載 adapter 使用 fake process，下載後離開原語音會拒絕加入序列', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-music-download-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createStoreRegistry({ dataRoot: path.join(root, 'data') });
    const context = { store, signal: new AbortController().signal };
    const guild = { id: 'download-guild', voiceAdapterCreator: {}, voiceStates: { cache: new Collection() } };
    const voiceChannel = { id: 'download-voice', guild };
    const { interaction, calls } = interactionFixture(voiceChannel);
    interaction.guildId = guild.id;
    interaction.guild.id = guild.id;
    interaction.customId = 'music_request_modal';

    fs.mkdirSync(CACHE_DIRECTORY, { recursive: true, mode: 0o700 });
    const binaryPath = resolveBinaryPath();
    const createdTestBinary = !fs.existsSync(binaryPath);
    if (createdTestBinary) {
        fs.mkdirSync(path.dirname(binaryPath), { recursive: true, mode: 0o700 });
        fs.writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
        t.after(() => {
            fs.rmSync(binaryPath, { force: true });
            fs.rmSync(`${binaryPath}.update.json`, { force: true });
        });
    }
    assert.equal(fs.existsSync(binaryPath), true);
    setProcessManager({
        async run(_command, args, options) {
            if (args.includes('--dump-single-json')) {
                return { code: 0, stderr: '', stdout: JSON.stringify({
                    id: 'test-track', title: 'Test Track', webpage_url: 'https://youtu.be/test-track',
                    uploader: 'Artist', upload_date: '20250101', duration: 120
                }) };
            }
            const outputIndex = args.indexOf('-o');
            if (outputIndex >= 0) {
                const localPath = args[outputIndex + 1].replace('%(ext)s', 'webm');
                fs.writeFileSync(localPath, Buffer.alloc(64));
                options.onStderr?.('[download] 50.0%\n[download] 100.0%');
                return { code: 0, stderr: '', stdout: `${localPath}\n` };
            }
            return { code: 0, stderr: '', stdout: '' };
        }
    });

    const command = createCommand(loadConfig());
    const state = getGuildState(guild.id);
    state.voiceChannelID = voiceChannel.id;
    state.voiceChannel = voiceChannel;
    await command.modalSubmitHandlers.music_request_modal(interaction, context);
    assert.equal(calls.some(([name]) => name === 'editReply'), true);
    assert.equal(state.queue.length, 0);
    cleanupOrphanedCache([]);
});

test('播放器語音人數、快取容量與清理邊界不遺留 timer 或檔案', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-player-state-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const guild = {
        id: 'voice-event-guild',
        voiceStates: { cache: new Collection() }
    };
    const state = getGuildState(guild.id, { inactivityTimeoutMinutes: 1 }, {
        updatePanel: async () => {}, persistSnapshot: async () => {}, notifyPlaybackStatus: async () => {}
    });
    state.voiceChannelID = 'voice';
    state.voiceChannel = { id: 'voice', guild };
    state.current = temporaryTrack(root, 'voice-current');
    handleVoiceStateUpdate({ guild, channelId: 'voice' }, { guild, channelId: null });
    await new Promise(resolve => setTimeout(resolve, 275));
    assert.equal(state.paused, true);

    fs.mkdirSync(CACHE_DIRECTORY, { recursive: true, mode: 0o700 });
    const protectedFile = path.join(CACHE_DIRECTORY, 'protected-test.webm');
    fs.writeFileSync(protectedFile, Buffer.alloc(16));
    setProtectedCachePaths([protectedFile]);
    assert.throws(() => ensureCacheCapacity({ maxCacheSizeBytes: 8 }, 0), /快取空間/);
    fs.rmSync(protectedFile, { force: true });
    cleanupState(state, true);
    assert.equal(guildStates.has(guild.id), false);
});
