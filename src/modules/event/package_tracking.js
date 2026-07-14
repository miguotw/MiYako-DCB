'use strict';

/** 物流輪詢與 persisted outbox worker；Discord 傳送永遠不在 repository mutex 內執行。 */
const { createLogTools } = require('../../../core/sendLog');
const { createPackageTrackingTools } = require('../../../util/getPackageTracking');
const { createPackageTrackingRepository } = require('../../../util/packageTrackingRepository');

function createInitializer(config, {
    packageTools = createPackageTrackingTools(config),
    logTools = createLogTools(config),
    repositoryFactory = createPackageTrackingRepository
} = {}) {
const { sendLog } = logTools;
const {
    getPackageTrackingConfig,
    hasTrackTwToken,
    trackingPackage,
    changePackageState,
    createHistorySignature,
    createPackageEmbed,
    createPackageNotificationActionsRows
} = packageTools;

function createLegacyRepository() {
    return {
        listPackages: async filter => packageTools.getPackageRecords(filter),
        updatePackage: async (ownerID, packageID, changes) => packageTools.updatePackageRecord?.(ownerID, packageID, changes),
        stageNotification: async () => {},
        listDueOutbox: async () => [],
        markOutboxFailed: async () => {},
        markOutboxDelivered: async () => null,
        getPackage: async () => null
    };
}

/** 新通知成功前不得刪除舊訊息；函式只負責傳送並回傳新 locator。 */
async function sendPackageUpdate(client, record, packageData) {
    const embed = createPackageEmbed(record, packageData, '物流貨態更新');
    const payload = {
        content: `<@${record.userID}>`,
        embeds: [embed],
        components: createPackageNotificationActionsRows(record),
        allowedMentions: { users: [record.userID] }
    };

    const channel = record.channelID ? await client.channels.fetch(record.channelID).catch(() => null) : null;
    if (channel && typeof channel.send === 'function') {
        const message = await channel.send(payload);
        return { channelID: message.channelId, messageID: message.id };
    }

    const user = await client.users.fetch(record.userID).catch(() => null);
    if (user) {
        const message = await user.send({ embeds: [embed], components: createPackageNotificationActionsRows(record) });
        return { channelID: message.channelId, messageID: message.id };
    }

    const error = new Error('找不到可通知物流更新的頻道或使用者。');
    error.code = 'PACKAGE_NOTIFICATION_TARGET_MISSING';
    throw error;
}

async function deleteOldNotification(client, locator) {
    if (!locator?.channelID || !locator?.messageID) return;
    const channel = await client.channels.fetch(locator.channelID).catch(() => null);
    const message = await channel?.messages?.fetch(locator.messageID).catch(() => null);
    await message?.delete().catch(() => {});
}

async function processOutbox(client, repository, signal) {
    const errors = [];
    for (const item of await repository.listDueOutbox()) {
        if (signal?.aborted) return;
        try {
            const record = await repository.getPackage(item.ownerID, item.packageID);
            if (!record) {
                await repository.markOutboxDelivered(item.ownerID, item.id, {
                    channelID: null,
                    messageID: null
                }, item.signature);
                continue;
            }
            const locator = await sendPackageUpdate(client, record, item.packageData);
            const previous = await repository.markOutboxDelivered(
                item.ownerID,
                item.id,
                locator,
                item.signature
            );
            if (previous === false) {
                // 傳送期間若輪詢已把同一 outbox 換成更新貨態，新送出的舊狀態不應成為 locator。
                await deleteOldNotification(client, locator);
                continue;
            }
            await deleteOldNotification(client, previous);
        } catch (error) {
            errors.push(error);
            await repository.markOutboxFailed(item.ownerID, item.id).catch(() => {});
            sendLog(client, '❌ 發送物流 outbox 通知時發生錯誤：', 'ERROR', error);
        }
    }
    if (errors.length) throw new AggregateError(errors, '物流通知 outbox 有工作失敗。');
}

async function archiveStalePackage(client, repository, record) {
    await changePackageState(record.userPackageID, 'archive');
    await repository.updatePackage(record.userID, record.userPackageID, { status: 'archived' });
    sendLog(client, `📦 已自動封存長時間無更新的包裹：${record.trackingNumber}`, 'INFO', null, {
        sensitiveValues: [record.trackingNumber]
    });
}

async function checkPackages(client, signal, repository) {
    const packageConfig = getPackageTrackingConfig();
    const activeRecords = await repository.listPackages({ status: 'active' });
    const now = Date.now();
    const errors = [];

    for (const record of activeRecords) {
        if (signal?.aborted) return;
        try {
            const packageData = await trackingPackage(record.userPackageID, { signal });
            const signature = createHistorySignature(packageData);
            const observed = record.observedHistorySignature || record.lastHistorySignature;

            if (signature !== observed) {
                await repository.stageNotification(record.userID, record.userPackageID, { signature, packageData });
                continue;
            }

            const lastHistoryChangedAt = Date.parse(record.lastHistoryChangedAt || record.createdAt || 0);
            if (lastHistoryChangedAt && now - lastHistoryChangedAt >= packageConfig.archiveAfter) {
                await archiveStalePackage(client, repository, record);
            }
        } catch (error) {
            errors.push(error);
            sendLog(client, `❌ 檢查包裹貨態時發生錯誤：${record.trackingNumber}`, 'ERROR', error, {
                sensitiveValues: [record.trackingNumber]
            });
        }
    }
    if (errors.length) throw new AggregateError(errors, '物流追蹤排程有工作失敗。');
}

const initializer = (client, context = {}) => {
    const packageConfig = getPackageTrackingConfig();
    if (!hasTrackTwToken()) {
        sendLog(client, '⚠️ 物流追蹤未設定 Track.TW API Token，監聽未啟動。', 'WARN');
        return;
    }
    if (!context.scheduler) throw new Error('物流追蹤 feature 缺少 scheduler context。');

    const repository = context.store?.packageTracking
        ? repositoryFactory(context.store.packageTracking, {
            maxActivePackages: config.commands.packageTracking.maxActivePackages
        })
        : createLegacyRepository();
    const outboxHandle = context.scheduler.register({
        name: 'packageTracking.outbox',
        intervalMs: 60_000,
        timeoutMs: 55_000,
        immediate: true,
        run: ({ signal }) => processOutbox(client, repository, signal)
    });
    const pollHandle = context.scheduler.register({
        name: 'packageTracking.check',
        intervalMs: packageConfig.checkInterval,
        timeoutMs: Math.min(packageConfig.checkInterval, 10 * 60 * 1000),
        immediate: false,
        run: ({ signal }) => checkPackages(client, signal, repository)
    });
    sendLog(client, `✅ 物流追蹤監聽已啟動，每 ${Math.round(packageConfig.checkInterval / 60000)} 分鐘檢查一次。`);
    return async () => {
        await Promise.all([pollHandle.stop(), outboxHandle.stop()]);
    };
};

initializer._test = { checkPackages, processOutbox, sendPackageUpdate };
return initializer;
}

module.exports = { createInitializer };
