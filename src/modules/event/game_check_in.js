'use strict';

const { EmbedBuilder } = require('discord.js');
const { createLogTools } = require('../../../core/sendLog');
const { createGameCheckInAdapters } = require('../../../util/gameCheckInAdapters');
const { createGameCheckInCredentialCodec } = require('../../../util/gameCheckInCredentialCodec');
const { createGameCheckInRepository } = require('../../../util/gameCheckInRepository');
const {
    dateKeyAt,
    nextCheckInEpoch,
    nextDateKey,
    scheduledEpoch
} = require('../../../util/gameCheckInSchedule');
const {
    createGameCheckInPanelEmbed,
    createGameCheckInPanelRow
} = require('../../../util/gameCheckInViews');

const USER_CONCURRENCY = 2;
const EMBED_FIELD_VALUE_LIMIT = 1024;

function inlineCode(value) {
    return `\`${String(value).replace(/`/g, 'ˋ')}\``;
}

function truncateFieldValue(value) {
    const text = String(value);
    if (text.length <= EMBED_FIELD_VALUE_LIMIT) return text;
    const suffix = '\n…（結果過長，已截斷）';
    return `${text.slice(0, EMBED_FIELD_VALUE_LIMIT - suffix.length)}${suffix}`;
}

function conciseReason(outcome) {
    const message = String(outcome.message || '未知錯誤。').replace(/\s+/g, ' ').trim();
    const game = String(outcome.game || '').replace(/\s+/g, ' ').trim();
    if (!game) return message;
    const escapedGame = game.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return message.replace(
        new RegExp(`^((?:HoYoLAB|SKPORT)\\s*)?${escapedGame}\\s*`, 'i'),
        (_match, platform = '') => platform ? `${platform.trim()} ` : ''
    ).trim() || '未知錯誤。';
}

function gameList(items) {
    return [...new Set(items.map(item => item.label))].map(inlineCode).join('、');
}

function resultEmbed(config, item) {
    const emojis = config.commands.gameCheckIn.resultEmojis;
    const groups = { success: [], already: [], skipped: [], failure: [] };
    for (const outcome of item.result?.outcomes || []) {
        const game = String(outcome.game || '未知遊戲').replace(/\s+/g, ' ').trim();
        const normalized = { ...outcome, label: game };
        const status = ['success', 'already', 'skipped'].includes(outcome.status)
            ? outcome.status
            : 'failure';
        groups[status].push(normalized);
    }
    const fields = [];
    if (groups.success.length) fields.push({
        name: `${emojis.success} 簽到成功`, value: truncateFieldValue(gameList(groups.success))
    });
    if (groups.already.length) fields.push({
        name: `${emojis.already} 重複簽到`, value: truncateFieldValue(gameList(groups.already))
    });
    if (groups.skipped.length) fields.push({
        name: `${emojis.skipped} 未綁定遊戲`, value: truncateFieldValue(gameList(groups.skipped))
    });
    if (groups.failure.length) {
        const failures = [...new Set(groups.failure
            .map(item => `${inlineCode(item.label)} ${conciseReason(item)}`))]
            .join('\n');
        fields.push({ name: `${emojis.error} 錯誤`, value: truncateFieldValue(failures) });
    }
    const embed = new EmbedBuilder()
        .setColor(config.embed.color.default)
        .setTitle(`${config.commands.gameCheckIn.emoji} ┃ 遊戲自動簽到（BETA） - 結果`);
    if (fields.length) embed.addFields(fields);
    else embed.setDescription('本次沒有可顯示的簽到結果。');
    return embed;
}

function isPermanentDiscordDmError(error) {
    return [10013, 50007].includes(Number(error?.code));
}

async function runWithConcurrency(groups, limit, worker) {
    let index = 0;
    async function consume() {
        while (index < groups.length) {
            const current = groups[index++];
            await worker(current);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, groups.length) }, consume));
}

function createGameCheckInDeadlineCoordinator(config, {
    adapters = createGameCheckInAdapters(),
    repositoryFactory = createGameCheckInRepository,
    logTools = createLogTools(config),
    now = () => Date.now()
} = {}) {
    const settings = config.commands.gameCheckIn;
    const timezone = config.log.timezone;
    const { sendLog } = logTools;
    let context = null;
    let repository = null;
    let handle = null;

    function timing(epoch = now()) {
        const date = dateKeyAt(epoch, timezone);
        const todayAt = scheduledEpoch(date, settings.checkInTime, timezone);
        const tomorrowAt = scheduledEpoch(nextDateKey(date), settings.checkInTime, timezone);
        return { date, todayAt, tomorrowAt };
    }

    async function processPlatform(candidate, date, signal) {
        const reservation = await repository.reservePlatform(candidate.userID, candidate.platform, date);
        if (!reservation) return;
        let result;
        try {
            result = await adapters.run[candidate.platform](reservation.credential, {
                http: context.http,
                signal,
                gameIDs: reservation.gameIDs
            });
        } catch (error) {
            if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : error;
            sendLog(context.client, `❌ ${candidate.platform} 遊戲簽到 adapter 發生非預期錯誤。`, 'ERROR', error, {
                sensitiveValues: [reservation.credential]
            });
            result = {
                platform: candidate.platform,
                retryable: true,
                outcomes: [{
                    platform: candidate.platform,
                    game: candidate.platform === 'hoyolab' ? 'HoYoLAB' : 'SKPORT',
                    account: null,
                    status: 'failure',
                    message: '平台處理發生暫時性錯誤，將稍後重試。'
                }]
            };
        }
        await repository.completePlatform(reservation, result);
    }

    async function processDue(date, scheduledAt, signal) {
        const due = await repository.listDuePlatforms(date, scheduledAt);
        if (!due.length) return repository.finalizeReady(date);
        const grouped = new Map();
        for (const candidate of due) {
            if (!grouped.has(candidate.userID)) grouped.set(candidate.userID, []);
            grouped.get(candidate.userID).push(candidate);
        }
        sendLog(
            context.client,
            `🎮 遊戲自動簽到已觸發：共 ${grouped.size} 位使用者、${due.length} 個平台。`
        );
        await runWithConcurrency([...grouped.values()], USER_CONCURRENCY, async candidates => {
            for (const candidate of candidates) {
                if (signal?.aborted) throw signal.reason || new Error('遊戲簽到工作已取消。');
                await processPlatform(candidate, date, signal);
            }
        });
        await repository.finalizeReady(date);
        sendLog(context.client, `✅ 遊戲自動簽到處理完成。`);
    }

    async function fetchPanelMessage(panel) {
        let channel = context.client.channels?.cache?.get(panel.channelID);
        if (!channel && typeof context.client.channels?.fetch === 'function') {
            try {
                channel = await context.client.channels.fetch(panel.channelID);
            } catch (error) {
                if (Number(error?.code) !== 10003) throw error;
            }
        }
        if (!channel?.messages) return null;
        return channel.messages.fetch(panel.messageID).catch(error => {
            if (Number(error?.code) === 10008) return null;
            throw error;
        });
    }

    function panelScope(message, panel) {
        const guildID = String(message.guildId || message.guild?.id || message.channel?.guild?.id || '');
        return guildID
            ? { type: 'guild', id: guildID }
            : { type: 'dm', id: String(message.channelId || panel.channelID) };
    }

    async function disablePanel(panel, message = null) {
        try {
            const target = message || await fetchPanelMessage(panel);
            if (target) await target.edit({ components: [createGameCheckInPanelRow(true)] });
        } catch (error) {
            sendLog(context.client, '⚠️ 停用被取代的遊戲自動簽到面板失敗。', 'WARN', error);
        }
    }

    async function syncPanels() {
        const panels = typeof repository.listPanels === 'function' ? await repository.listPanels() : [];
        if (!panels.length) return;
        const nextTriggerAt = nextCheckInEpoch(now(), settings.checkInTime, timezone);
        for (const panel of panels) {
            try {
                const message = await fetchPanelMessage(panel);
                if (!message) {
                    await repository.removePanel?.(panel.channelID, panel.messageID);
                    continue;
                }
                const scope = panelScope(message, panel);
                const claim = typeof repository.claimPanelScope === 'function'
                    ? await repository.claimPanelScope(panel.channelID, panel.messageID, scope)
                    : { tracked: true, replaced: [] };
                for (const replaced of claim.replaced) await disablePanel(replaced);
                if (!claim.tracked) {
                    await disablePanel(panel, message);
                    continue;
                }
                await message.edit({
                    embeds: [createGameCheckInPanelEmbed(config, nextTriggerAt)],
                    components: [createGameCheckInPanelRow()]
                });
                if (typeof repository.isCurrentPanel === 'function'
                    && !await repository.isCurrentPanel(scope, panel.messageID)) {
                    await disablePanel(panel, message);
                }
            } catch (error) {
                sendLog(context.client, '⚠️ 更新遊戲自動簽到主面板倒數失敗。', 'WARN', error);
            }
        }
    }

    async function deliverOutbox() {
        for (const due of await repository.listDueOutbox()) {
            const item = await repository.prepareOutboxDelivery(due.userID, due.id);
            if (!item) continue;
            try {
                const user = await context.client.users.fetch(String(due.userID));
                await user.send({ embeds: [resultEmbed(config, item)], allowedMentions: { parse: [] } });
                await repository.markOutboxDelivered(due.userID, due.id);
            } catch (error) {
                const permanent = isPermanentDiscordDmError(error);
                await repository.markOutboxFailed(due.userID, due.id, { permanent });
                sendLog(
                    context.client,
                    permanent ? '⚠️ 遊戲簽到結果 DM 因使用者隱私設定無法送達。' : '⚠️ 遊戲簽到結果 DM 暫時無法送達。',
                    'WARN'
                );
            }
        }
    }

    async function nextDeadline() {
        const current = now();
        const { date, todayAt, tomorrowAt } = timing(current);
        const candidates = [current < todayAt ? todayAt : tomorrowAt];
        if (current >= todayAt) {
            const pending = await repository.earliestPending(date);
            if (pending !== null) candidates.push(Math.max(pending, current + 1000));
        }
        const outboxAt = await repository.earliestOutbox();
        if (outboxAt !== null) candidates.push(Math.max(outboxAt, current + 1000));
        return Math.min(...candidates);
    }

    async function reconcile({ signal } = {}) {
        const current = now();
        const { date, todayAt } = timing(current);
        await deliverOutbox();
        if (current >= todayAt) await processDue(date, todayAt, signal);
        await deliverOutbox();
        await syncPanels();
        handle?.reschedule(await nextDeadline());
    }

    async function start(nextContext) {
        if (typeof nextContext.scheduler?.scheduleDeadline !== 'function') {
            throw new Error('遊戲簽到 feature 缺少 deadline scheduler context。');
        }
        if (!nextContext.store?.gameCheckIn) throw new Error('遊戲簽到 feature 缺少 repository context。');
        try {
            const credentialCodec = createGameCheckInCredentialCodec(settings.credentialEncryptionKey);
            repository = repositoryFactory(nextContext.store.gameCheckIn, { now, credentialCodec });
            await repository.validateStoredCredentials?.();
            context = nextContext;
            handle = context.scheduler.scheduleDeadline({
                name: 'gameCheckIn.deadline',
                deadlineAt: now(),
                timeoutMs: 30 * 60 * 1000,
                run: reconcile
            });
            sendLog(
                context.client,
                `✅ 遊戲簽到排程已啟動，每日 ${settings.checkInTime} 執行一次。`
            );
            return stop;
        } catch (error) {
            repository = null;
            context = null;
            throw error;
        }
    }

    function wake() {
        if (!handle) return false;
        handle.reschedule(now());
        return true;
    }

    async function stop() {
        const currentHandle = handle;
        handle = null;
        await currentHandle?.stop();
        repository = null;
        context = null;
    }

    return {
        start,
        stop,
        wake,
        _test: { deliverOutbox, nextDeadline, processDue, reconcile, syncPanels, timing }
    };
}

module.exports = {
    createGameCheckInDeadlineCoordinator,
    dateKeyAt,
    isPermanentDiscordDmError,
    nextDateKey,
    resultEmbed,
    runWithConcurrency,
    scheduledEpoch
};
