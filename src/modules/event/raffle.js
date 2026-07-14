'use strict';

const { createLogTools } = require('../../../core/sendLog');
const { createRaffleRepository, drawWinners } = require('../../../util/raffleRepository');
const { createRaffleViews } = require('../../../util/raffleViews');

function createRaffleDeadlineCoordinator(config) {
    const { sendLog } = createLogTools(config);
    const { createRaffleEmbed, participationRow } = createRaffleViews(config);
    const handles = new Map();
    let context;
    let repository;

    async function fetchMessage(channelID, messageID) {
        try {
            const channel = await context.client.channels.fetch(channelID);
            if (!channel?.messages) return null;
            return await channel.messages.fetch(messageID);
        } catch (error) {
            if (error?.code === 10003 || error?.code === 10008) return null;
            throw error;
        }
    }

    async function process(guildID, raffleID) {
        let raffle = await repository.get(guildID, raffleID);
        if (!raffle) return;
        if (raffle.status === 'open') {
            if (Date.now() < Number(raffle.entryDeadline) * 1000) return;
            raffle = await repository.update(guildID, raffleID, current => {
                if (current.status !== 'open') return current;
                if (current.autoDraw === false) current.status = 'closedPendingSync';
                else {
                    current.winners = drawWinners(current.participants, current.winnerCount);
                    current.status = 'drawnPendingSync';
                    current.drawnAt = new Date().toISOString();
                }
                return current;
            });
        }
        if (!['closedPendingSync', 'drawnPendingSync'].includes(raffle.status)) return;

        const message = await fetchMessage(raffle.channelID, raffle.messageID);
        if (!message) {
            await repository.remove(guildID, raffleID);
            sendLog(context.client, `⚠️ 抽選 ${raffleID} 的公告已不存在，已移除本機資料。`, 'WARN');
            return;
        }
        const drawn = raffle.status === 'drawnPendingSync';
        await message.edit({
            embeds: [createRaffleEmbed(raffle, drawn)],
            components: participationRow(raffle, true)
        });
        await repository.remove(guildID, raffleID);
        sendLog(context.client, drawn
            ? `✅ 抽選 ${raffleID} 已完成，共抽出 ${raffle.winners.length} 位。`
            : `✅ 抽選 ${raffleID} 已截止登記，自動抽選未啟用。`);
    }

    function schedule(raffle) {
        if (!context || !repository || !raffle?.id) return;
        const name = `raffle.deadline.${raffle.guildID}.${raffle.id}`;
        const deadlineAt = ['closedPendingSync', 'drawnPendingSync'].includes(raffle.status)
            ? Date.now()
            : Number(raffle.entryDeadline) * 1000;
        const existing = handles.get(name);
        if (existing) {
            existing.reschedule(deadlineAt);
            return existing;
        }
        const handle = context.scheduler.scheduleDeadline({
            name,
            deadlineAt,
            timeoutMs: 25_000,
            run: () => process(String(raffle.guildID), String(raffle.id))
        });
        handles.set(name, handle);
        return handle;
    }

    async function start(nextContext) {
        if (typeof nextContext.scheduler?.scheduleDeadline !== 'function') {
            throw new Error('抽選 feature 缺少 deadline scheduler context。');
        }
        context = nextContext;
        repository = createRaffleRepository(context.store.raffle);
        for (const raffle of await repository.list()) {
            if (['open', 'closedPendingSync', 'drawnPendingSync'].includes(raffle.status)) schedule(raffle);
        }
        sendLog(context.client, '✅ 抽選 deadline scheduler 已啟動。');
        return stop;
    }

    async function stop() {
        await Promise.all([...handles.values()].map(handle => handle.stop()));
        handles.clear();
        context = null;
        repository = null;
    }

    return { start, stop, schedule, _test: { process } };
}

function createInitializer(config) {
    const coordinator = createRaffleDeadlineCoordinator(config);
    const initializer = (_client, context) => coordinator.start(context);
    initializer._test = coordinator._test;
    return initializer;
}

module.exports = { createInitializer, createRaffleDeadlineCoordinator };
