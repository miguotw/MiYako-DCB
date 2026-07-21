'use strict';

const { EmbedBuilder } = require('discord.js');
const { createLogTools } = require('../../../core/sendLog');
const { createGameCheckInAdapters } = require('../../../util/gameCheckInAdapters');
const { createGameCheckInRepository } = require('../../../util/gameCheckInRepository');

const USER_CONCURRENCY = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

function dateKeyAt(epoch, timezone) {
    const shifted = new Date(epoch + timezone * 60 * 60 * 1000);
    const year = shifted.getUTCFullYear();
    const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const day = String(shifted.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function scheduledEpoch(date, time, timezone) {
    const [year, month, day] = date.split('-').map(Number);
    const [hour, minute] = time.split(':').map(Number);
    return Date.UTC(year, month - 1, day, hour, minute) - timezone * 60 * 60 * 1000;
}

function nextDateKey(date) {
    const [year, month, day] = date.split('-').map(Number);
    return dateKeyAt(Date.UTC(year, month - 1, day) + DAY_MS, 0);
}

function resultEmbed(config, item) {
    const symbols = { success: '✅', already: '☑️', skipped: '➖', failure: '❌' };
    const lines = (item.result?.outcomes || []).map(outcome => {
        const account = outcome.account ? `／${outcome.account}` : '';
        return `${symbols[outcome.status] || '•'} **${outcome.game}${account}**：${outcome.message}`;
    });
    let description = lines.join('\n') || '本次沒有可顯示的簽到結果。';
    if (description.length > 3900) description = `${description.slice(0, 3890)}\n…（結果過長，已截斷）`;
    return new EmbedBuilder()
        .setColor(lines.some(line => line.startsWith('❌')) ? config.embed.color.error : config.embed.color.success)
        .setTitle(`${config.commands.gameCheckIn.emoji} ┃ 遊戲自動簽到結果`)
        .setDescription(description)
        .setFooter({ text: `簽到日期：${item.date}` })
        .setTimestamp();
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
    const { sendLog } = logTools;
    let context = null;
    let repository = null;
    let handle = null;

    function timing(epoch = now()) {
        const date = dateKeyAt(epoch, settings.timezone);
        const todayAt = scheduledEpoch(date, settings.checkInTime, settings.timezone);
        const tomorrowAt = scheduledEpoch(nextDateKey(date), settings.checkInTime, settings.timezone);
        return { date, todayAt, tomorrowAt };
    }

    async function processPlatform(candidate, date, signal) {
        const reservation = await repository.reservePlatform(candidate.userID, candidate.platform, date);
        if (!reservation) return;
        let result;
        try {
            result = await adapters.run[candidate.platform](reservation.credential, {
                http: context.http,
                signal
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
        const grouped = new Map();
        for (const candidate of due) {
            if (!grouped.has(candidate.userID)) grouped.set(candidate.userID, []);
            grouped.get(candidate.userID).push(candidate);
        }
        await runWithConcurrency([...grouped.values()], USER_CONCURRENCY, async candidates => {
            for (const candidate of candidates) {
                if (signal?.aborted) throw signal.reason || new Error('遊戲簽到工作已取消。');
                await processPlatform(candidate, date, signal);
            }
        });
        await repository.finalizeReady(date);
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
        handle?.reschedule(await nextDeadline());
    }

    function wake() {
        handle?.reschedule(now());
    }

    async function start(nextContext) {
        if (typeof nextContext.scheduler?.scheduleDeadline !== 'function') {
            throw new Error('遊戲簽到 feature 缺少 deadline scheduler context。');
        }
        if (!nextContext.store?.gameCheckIn) throw new Error('遊戲簽到 feature 缺少 repository context。');
        context = nextContext;
        repository = repositoryFactory(context.store.gameCheckIn, { now });
        handle = context.scheduler.scheduleDeadline({
            name: 'gameCheckIn.deadline',
            deadlineAt: now(),
            timeoutMs: 30 * 60 * 1000,
            run: reconcile
        });
        sendLog(context.client, `✅ 遊戲簽到排程已啟動，每日 ${settings.checkInTime}（UTC${settings.timezone >= 0 ? '+' : ''}${settings.timezone}）。`);
        return stop;
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
        _test: { deliverOutbox, nextDeadline, processDue, reconcile, timing }
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
