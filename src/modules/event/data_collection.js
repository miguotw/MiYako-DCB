const path = require('path');
const { Events } = require('discord.js');
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));
const {
    deleteDataCollection, getAllDataCollections, updateDataCollection, withCollectionLock
} = require(path.join(process.cwd(), 'util/dataCollectionStore'));
const {
    createPublicEmbed, deleteAdminPanels, submitRow, syncAdminPanels
} = require(path.join(process.cwd(), 'util/dataCollectionViews'));

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

function createMentionBatches(record, maxLength = 1900) {
    const targets = record.whitelistMentionTargets?.length
        ? record.whitelistMentionTargets
        : (record.whitelistUserIDs || []).map(id => ({ type: 'user', id }));
    const batches = [];
    for (const target of targets) {
        const mention = target.type === 'role' ? `<@&${target.id}>` : `<@${target.id}>`;
        const current = batches[batches.length - 1];
        if (!current || `${current.content} ${mention}`.length > maxLength) {
            batches.push({
                content: mention,
                userIDs: target.type === 'user' ? [target.id] : [],
                roleIDs: target.type === 'role' ? [target.id] : []
            });
        } else {
            current.content += ` ${mention}`;
            if (target.type === 'user') current.userIDs.push(target.id);
            else current.roleIDs.push(target.id);
        }
    }
    return batches;
}

async function restorePublicPanel(client, record) {
    const channel = await client.channels.fetch(record.publicChannelID).catch(() => null);
    if (!channel || typeof channel.send !== 'function') throw new Error('找不到可重建公開資料收集面板的頻道。');
    const sentMentionMessages = [];
    try {
        const batches = createMentionBatches(record);
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

async function checkCollections(client) {
    if (isChecking) return;
    isChecking = true;
    try {
        const now = Math.floor(Date.now() / 1000);
        for (const record of getAllDataCollections()) {
            try { await processCollection(client, record, now); }
            catch (error) { sendLog(client, `❌ 處理資料收集 ${record.id} 時發生錯誤：`, 'ERROR', error); }
        }
    } finally { isChecking = false; }
}

module.exports = client => {
    client.once(Events.ClientReady, () => {
        checkCollections(client);
        setInterval(() => checkCollections(client), CHECK_INTERVAL_MS);
        sendLog(client, '✅ 資料收集排程已啟動，每 30 秒檢查一次。');
    });
};

module.exports._test = { createMentionBatches, processCollection };
