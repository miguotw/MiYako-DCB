'use strict';

const { createLogTools } = require('../../../core/sendLog');
const { createDataCollectionRepository } = require('../../../util/dataCollectionRepository');
const { createDataCollectionViews } = require('../../../util/dataCollectionViews');

function createDataCollectionDeadlineCoordinator(config) {
    const { sendLog } = createLogTools(config);
    const {
        createMentionBatches, createPublicEmbed, deleteAdminPanels, submitRow, syncAdminPanels
    } = createDataCollectionViews(config);
    const handles = new Map();
    let context;
    let repository;

    function isMissing(error) { return error?.code === 10003 || error?.code === 10008; }

    async function fetchMessage(channelID, messageID) {
        try {
            const channel = await context.client.channels.fetch(channelID);
            if (!channel?.messages || !messageID) return null;
            return await channel.messages.fetch(messageID);
        } catch (error) {
            if (isMissing(error)) return null;
            throw error;
        }
    }

    async function adminPanelsExist(record) {
        if (!(record.adminPageMessageIDs || []).length) return false;
        for (const messageID of record.adminPageMessageIDs) {
            if (!await fetchMessage(record.adminChannelID, messageID)) return false;
        }
        return true;
    }

    async function restorePublicPanel(record) {
        const channel = await context.client.channels.fetch(record.publicChannelID).catch(() => null);
        if (!channel || typeof channel.send !== 'function') throw new Error('找不到可重建公開資料收集面板的頻道。');
        const targets = record.whitelistMentionTargets?.length
            ? record.whitelistMentionTargets
            : (record.whitelistUserIDs || []).map(id => ({ type: 'user', id }));
        const batches = createMentionBatches(targets);
        const sent = [];
        try {
            for (const batch of batches.slice(0, -1)) {
                sent.push(await channel.send({
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
            await repository.update(record.guildID, record.id, current => {
                current.publicMessageID = message.id;
                current.publicMentionMessageIDs = [
                    ...(current.publicMentionMessageIDs || []), ...sent.map(item => item.id)
                ];
            });
            return message;
        } catch (error) {
            for (const message of sent) await message.delete().catch(() => {});
            throw error;
        }
    }

    async function reconcile(record) {
        if (!['open', 'closing'].includes(record.status) && !record.adminSyncPending) return;
        if (!record.publicMessageID || !(record.adminPageMessageIDs || []).length) return;

        let publicMessage = await fetchMessage(record.publicChannelID, record.publicMessageID);
        if (!await adminPanelsExist(record)) {
            await publicMessage?.edit({ components: submitRow(record, true) }).catch(() => {});
            await deleteAdminPanels(context.client, record);
            await repository.remove(record.guildID, record.id);
            sendLog(context.client, `⚠️ 資料收集 ${record.id} 的管理面板已不存在，已停用並移除本機資料。`, 'WARN');
            return;
        }

        if (!publicMessage && record.status === 'open' && Date.now() < Number(record.deadline) * 1000) {
            publicMessage = await restorePublicPanel(record);
        }
        let latest = await repository.get(record.guildID, record.id);
        if (!latest) return;
        if (latest.adminSyncPending) {
            await syncAdminPanels(context.client, latest, repository);
            latest = await repository.get(record.guildID, record.id);
        }
        if (!latest) return;

        if (latest.status === 'open' && Date.now() < Number(latest.deadline) * 1000) {
            schedule(latest);
            return;
        }
        if (latest.status === 'open') {
            latest = await repository.update(latest.guildID, latest.id, current => {
                if (current.status === 'open') current.status = 'closing';
            });
        }
        if (latest.status !== 'closing') return;
        publicMessage ||= await fetchMessage(latest.publicChannelID, latest.publicMessageID);
        if (publicMessage) await publicMessage.edit({ components: submitRow(latest, true) });
        await repository.update(latest.guildID, latest.id, current => {
            current.status = 'closed';
            current.closedAt = current.closedAt || new Date().toISOString();
            current.adminSyncPending = false;
        });
        sendLog(context.client, `✅ 資料收集 ${latest.id} 已截止並停用提交按鈕。`);
    }

    function schedule(record) {
        if (!context || !record?.id) return;
        const name = `dataCollection.deadline.${record.guildID}.${record.id}`;
        const deadlineAt = record.status === 'closing' || record.adminSyncPending
            ? Date.now()
            : Number(record.deadline) * 1000;
        const existing = handles.get(name);
        if (existing) {
            existing.reschedule(deadlineAt);
            return existing;
        }
        const handle = context.scheduler.scheduleDeadline({
            name,
            deadlineAt,
            timeoutMs: 25_000,
            run: async () => {
                const latest = await repository.get(String(record.guildID), String(record.id));
                if (latest) await reconcile(latest);
            }
        });
        handles.set(name, handle);
        return handle;
    }

    async function start(nextContext) {
        if (typeof nextContext.scheduler?.scheduleDeadline !== 'function') {
            throw new Error('資料收集 feature 缺少 deadline scheduler context。');
        }
        context = nextContext;
        repository = createDataCollectionRepository(context.store.dataCollection);
        for (const record of await repository.list({ actionableOnly: true })) {
            if (record.status === 'open' || record.status === 'closing' || record.adminSyncPending) {
                // 啟動 reconciliation 立即處理一次，但不觸碰已關閉且無 pending 的紀錄。
                schedule({ ...record, adminSyncPending: true });
            }
        }
        sendLog(context.client, '✅ 資料收集 deadline scheduler 已啟動。');
        return stop;
    }

    async function stop() {
        await Promise.all([...handles.values()].map(handle => handle.stop()));
        handles.clear();
        context = null;
        repository = null;
    }

    return { start, stop, schedule, _test: { reconcile } };
}

function createInitializer(config) {
    const coordinator = createDataCollectionDeadlineCoordinator(config);
    const initializer = (_client, context) => coordinator.start(context);
    initializer._test = coordinator._test;
    return initializer;
}

module.exports = { createDataCollectionDeadlineCoordinator, createInitializer };
