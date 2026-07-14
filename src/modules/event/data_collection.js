const path = require('path');
const { createLogTools } = require('../../../core/sendLog');
const {
    deleteDataCollection, getAllDataCollections, updateDataCollection, withCollectionLock
} = require('../../../util/dataCollectionStore');
const { createDataCollectionViews } = require('../../../util/dataCollectionViews');

function createInitializer(config) {
const { sendLog } = createLogTools(config);
const {
    createMentionBatches, createPublicEmbed, deleteAdminPanels, submitRow, syncAdminPanels
} = createDataCollectionViews(config);

const CHECK_INTERVAL_MS = 30000;
let isChecking = false;

function isMissingResource(error) { return error?.code === 10003 || error?.code === 10008; }

async function fetchPublicMessage(client, record) {
    try {
        const channel = await client.channels.fetch(record.publicChannelID);
        if (!channel?.messages) return null;
        return await channel.messages.fetch(record.publicMessageID);
    } catch (error) {
        if (isMissingResource(error)) return null;
        throw error;
    }
}

async function adminPanelsExist(client, record) {
    try {
        const channel = await client.channels.fetch(record.adminChannelID);
        if (!channel?.messages) return false;
        for (const messageID of record.adminPageMessageIDs || []) await channel.messages.fetch(messageID);
        return true;
    } catch (error) {
        if (isMissingResource(error)) return false;
        throw error;
    }
}

async function disablePublicMessage(message, record) {
    if (message) await message.edit({ components: submitRow(record, true) }).catch(() => {});
}

async function cleanDeletedAdminPanels(client, record, publicMessage) {
    await disablePublicMessage(publicMessage, record);
    await deleteAdminPanels(client, record);
    deleteDataCollection(record.guildID, record.id);
    sendLog(client, `⚠️ 資料收集 ${record.id} 的管理面板已不存在，已停用公開提交並刪除管理面板與本機資料。`, 'WARN');
}

async function restorePublicPanel(client, record) {
    const channel = await client.channels.fetch(record.publicChannelID).catch(() => null);
    if (!channel || typeof channel.send !== 'function') throw new Error('找不到可重建公開資料收集面板的頻道。');
    const sentMentionMessages = [];
    try {
        const mentionTargets = record.whitelistMentionTargets?.length
            ? record.whitelistMentionTargets
            : (record.whitelistUserIDs || []).map(id => ({ type: 'user', id }));
        const batches = createMentionBatches(mentionTargets);
        for (const batch of batches.slice(0, -1)) {
            sentMentionMessages.push(await channel.send({
                content: batch.content,
                allowedMentions: { users: batch.userIDs, roles: batch.roleIDs }
            }));
        }
        const finalBatch = batches[batches.length - 1];
        const message = await channel.send({
            content: finalBatch?.content || null,
            embeds: [createPublicEmbed(record)],
            components: submitRow(record),
            allowedMentions: { users: finalBatch?.userIDs || [], roles: finalBatch?.roleIDs || [] }
        });
        updateDataCollection(record.guildID, record.id, current => {
            current.publicMessageID = message.id;
            current.publicMentionMessageIDs = [
                ...(current.publicMentionMessageIDs || []),
                ...sentMentionMessages.map(item => item.id)
            ];
        });
        sendLog(client, `✅ 資料收集 ${record.id} 的公開面板已重新提及白名單並自動重建。`);
        return message;
    } catch (error) {
        for (const message of sentMentionMessages) await message.delete().catch(() => {});
        throw error;
    }
}

async function processCollection(client, snapshot, now) {
    return withCollectionLock(snapshot.id, async () => {
        // 建立流程會先寫入資料再建立兩種面板；避免排程清理由另一個請求正在建立的暫存紀錄。
        if (!snapshot.publicMessageID || !(snapshot.adminPageMessageIDs || []).length) return;
        let message = await fetchPublicMessage(client, snapshot);
        if (!await adminPanelsExist(client, snapshot)) return cleanDeletedAdminPanels(client, snapshot, message);
        if (!message) {
            if (snapshot.status === 'open' && now < snapshot.deadline) message = await restorePublicPanel(client, snapshot);
            else return;
        }
        if (snapshot.adminSyncPending) await syncAdminPanels(client, snapshot);
        if (snapshot.status !== 'open' || now < snapshot.deadline) return;
        await message.edit({ components: submitRow(snapshot, true) });
        updateDataCollection(snapshot.guildID, snapshot.id, current => {
            current.status = 'closed';
            current.closedAt = new Date().toISOString();
        });
        sendLog(client, `✅ 資料收集 ${snapshot.id} 已截止並停用提交按鈕。`);
    });
}

async function checkCollections(client, signal) {
    if (isChecking) return;
    isChecking = true;
    try {
        const now = Math.floor(Date.now() / 1000);
        const errors = [];
        for (const record of getAllDataCollections()) {
            if (signal?.aborted) return;
            try { await processCollection(client, record, now); }
            catch (error) {
                errors.push(error);
                sendLog(client, `❌ 處理資料收集 ${record.id} 時發生錯誤：`, 'ERROR', error);
            }
        }
        if (errors.length) throw new AggregateError(errors, '資料收集排程有工作失敗。');
    } finally { isChecking = false; }
}

const initializer = (client, context = {}) => {
    if (!context.scheduler) throw new Error('資料收集 feature 缺少 scheduler context。');
    const handle = context.scheduler.register({
        name: 'dataCollection.check',
        intervalMs: CHECK_INTERVAL_MS,
        timeoutMs: 25000,
        immediate: true,
        run: ({ signal }) => checkCollections(client, signal)
    });
    sendLog(client, '✅ 資料收集排程已啟動，每 30 秒檢查一次。');
    return () => handle.stop();
};

initializer._test = { processCollection };
return initializer;
}

module.exports = { createInitializer };
