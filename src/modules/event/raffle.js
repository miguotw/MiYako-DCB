const path = require('path');
const { createLogTools } = require('../../../core/sendLog');
const { deleteRaffle, drawWinners, getAllRaffles, updateRaffle } = require('../../../util/raffleStore');
const { createRaffleViews } = require('../../../util/raffleViews');

function createInitializer(config) {
const { sendLog } = createLogTools(config);
const { createRaffleEmbed, participationRow } = createRaffleViews(config);

const CHECK_INTERVAL_MS = 30000;
let isChecking = false;

function isMissingDiscordResource(error) {
    return error?.code === 10003 || error?.code === 10008;
}

async function announcementExists(client, raffle) {
    try {
        const channel = await client.channels.fetch(raffle.channelID);
        if (!channel?.messages) return false;
        await channel.messages.fetch(raffle.messageID);
        return true;
    } catch (error) {
        if (isMissingDiscordResource(error)) return false;
        throw error;
    }
}

async function updateCompletedMessage(client, raffle) {
    const channel = await client.channels.fetch(raffle.channelID).catch(() => null);
    const message = await channel?.messages?.fetch(raffle.messageID).catch(() => null);
    if (!message) throw new Error('找不到原抽選公告訊息。');
    await message.edit({ embeds: [createRaffleEmbed(raffle, true)], components: participationRow(raffle, true) });
    deleteRaffle(raffle.guildID, raffle.id);
}

async function finishRaffle(client, raffle) {
    const winners = drawWinners(raffle.participants, raffle.winnerCount);
    const completed = updateRaffle(raffle.guildID, raffle.id, current => {
        if (current.status !== 'open') return;
        current.winners = winners;
        current.status = 'drawn';
        current.drawnAt = new Date().toISOString();
    });
    if (!completed || completed.status !== 'drawn') return;
    if (completed.participants.length < completed.winnerCount) {
        sendLog(client, `⚠️ 抽選 ${completed.id} 參加人數不足，全部 ${completed.participants.length} 位參加者中選。`, 'WARN');
    }
    await updateCompletedMessage(client, completed);
    sendLog(client, `✅ 抽選 ${completed.id} 已完成，共抽出 ${completed.winners.length} 位。`);
}

async function closeRegistration(client, raffle) {
    const closed = updateRaffle(raffle.guildID, raffle.id, current => {
        if (current.status === 'open') current.status = 'closed';
    });
    const channel = await client.channels.fetch(closed.channelID).catch(() => null);
    const message = await channel?.messages?.fetch(closed.messageID).catch(() => null);
    if (!message) throw new Error('找不到原抽選公告訊息。');
    await message.edit({ embeds: [createRaffleEmbed(closed, false)], components: participationRow(closed, true) });
    deleteRaffle(closed.guildID, closed.id);
    sendLog(client, `✅ 抽選 ${closed.id} 已截止登記，自動抽選未啟用。`);
}

async function checkRaffles(client, signal) {
    if (isChecking) return;
    isChecking = true;
    try {
        const now = Math.floor(Date.now() / 1000);
        const errors = [];
        for (const raffle of getAllRaffles()) {
            if (signal?.aborted) return;
            try {
                if (raffle.messageID) {
                    if (!await announcementExists(client, raffle)) {
                        deleteRaffle(raffle.guildID, raffle.id);
                        sendLog(client, `⚠️ 抽選 ${raffle.id} 的公告已不存在，已刪除該筆抽選資料。`, 'WARN');
                        continue;
                    }
                }
                if (raffle.status === 'open' && now >= raffle.entryDeadline) {
                    if (raffle.autoDraw === false) await closeRegistration(client, raffle);
                    else await finishRaffle(client, raffle);
                }
                else if (raffle.status === 'drawn') {
                    if (raffle.messageUpdatedAt) deleteRaffle(raffle.guildID, raffle.id);
                    else await updateCompletedMessage(client, raffle);
                }
                else if (raffle.status === 'closed') {
                    if (raffle.messageUpdatedAt) deleteRaffle(raffle.guildID, raffle.id);
                    else await closeRegistration(client, raffle);
                }
            } catch (error) {
                errors.push(error);
                sendLog(client, `❌ 處理抽選 ${raffle.id} 時發生錯誤：`, 'ERROR', error);
            }
        }
        if (errors.length) throw new AggregateError(errors, '抽選排程有工作失敗。');
    } finally {
        isChecking = false;
    }
}

const initializer = (client, context = {}) => {
    if (!context.scheduler) throw new Error('抽選 feature 缺少 scheduler context。');
    const handle = context.scheduler.register({
        name: 'raffle.check',
        intervalMs: CHECK_INTERVAL_MS,
        timeoutMs: 25000,
        immediate: true,
        run: ({ signal }) => checkRaffles(client, signal)
    });
    sendLog(client, '✅ 抽選系統排程已啟動，每 30 秒檢查一次。');
    return () => handle.stop();
};

initializer._test = { finishRaffle };
return initializer;
}

module.exports = { createInitializer };
