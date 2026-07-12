const path = require('path');
/**
 * 物流追蹤背景排程。
 * 比較「貨態歷史簽章」而非整份 API 回應，只有新貨態才通知；長期無變化的
 * 包裹會在 Track.TW 與本機一起封存。
 */
const { Events } = require('discord.js');
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));
const {
    getPackageTrackingConfig,
    hasTrackTwToken,
    trackingPackage,
    changePackageState,
    createHistorySignature,
    createPackageEmbed,
    createPackageNotificationActionsRows,
    getPackageRecords,
    updatePackageRecord
} = require(path.join(process.cwd(), 'util/getPackageTracking'));

let isChecking = false;

/** 優先通知原頻道，無法使用時退回 DM；成功後只保留最新一則通知。 */
async function sendPackageUpdate(client, record, packageData) {
    const embed = createPackageEmbed(record, packageData, '物流貨態更新');
    // 主動推送的狀態訊息也帶完整操作按鈕，且新增包裹按鈕使用 detached 模式保留原訊息。
    const payload = {
        content: `<@${record.userID}>`,
        embeds: [embed],
        components: createPackageNotificationActionsRows(record),
        allowedMentions: { users: [record.userID] }
    };

    try {
        const oldChannel = record.lastNotificationChannelID
            ? await client.channels.fetch(record.lastNotificationChannelID).catch(() => null)
            : null;
        if (oldChannel && record.lastNotificationMessageID) {
            const oldMessage = await oldChannel.messages?.fetch(record.lastNotificationMessageID).catch(() => null);
            if (oldMessage) await oldMessage.delete().catch(() => {});
        }

        const channel = record.channelID ? await client.channels.fetch(record.channelID).catch(() => null) : null;
        if (channel && typeof channel.send === 'function') {
            const message = await channel.send(payload);
            updatePackageRecord(record.userPackageID, {
                lastNotificationChannelID: message.channelId,
                lastNotificationMessageID: message.id
            });
            return;
        }

        const user = await client.users.fetch(record.userID).catch(() => null);
        if (user) {
            const message = await user.send({ embeds: [embed], components: createPackageNotificationActionsRows(record) });
            updatePackageRecord(record.userPackageID, {
                lastNotificationChannelID: message.channelId,
                lastNotificationMessageID: message.id
            });
            return;
        }

        sendLog(client, `⚠️ 無法通知包裹更新，找不到頻道與使用者：${record.trackingNumber}`, 'WARN');
    } catch (error) {
        sendLog(client, '❌ 發送包裹更新通知時發生錯誤：', 'ERROR', error);
    }
}

async function archiveStalePackage(client, record) {
    try {
        await changePackageState(record.userPackageID, 'archive');
        updatePackageRecord(record.userPackageID, {
            status: 'archived'
        });
        sendLog(client, `📦 已自動封存長時間無更新的包裹：${record.trackingNumber}`);
    } catch (error) {
        sendLog(client, `❌ 自動封存包裹失敗：${record.trackingNumber}`, 'ERROR', error);
    }
}

async function checkPackages(client) {
    // setInterval 不等待上一輪完成，旗標可避免慢速 API 造成重疊檢查。
    if (isChecking) return;
    isChecking = true;

    const packageConfig = getPackageTrackingConfig();
    const activeRecords = getPackageRecords({ status: 'active' });
    const now = Date.now();

    try {
        for (const record of activeRecords) {
            try {
                const packageData = await trackingPackage(record.userPackageID);
                const signature = createHistorySignature(packageData);

                if (signature !== record.lastHistorySignature) {
                    const updatedRecord = updatePackageRecord(record.userPackageID, {
                        lastHistorySignature: signature,
                        lastHistoryChangedAt: new Date().toISOString(),
                        lastPackageData: packageData
                    }) || record;
                    await sendPackageUpdate(client, updatedRecord, packageData);
                    continue;
                }

                const lastHistoryChangedAt = Date.parse(record.lastHistoryChangedAt || record.createdAt || 0);
                if (lastHistoryChangedAt && now - lastHistoryChangedAt >= packageConfig.archiveAfter) {
                    await archiveStalePackage(client, record);
                }
            } catch (error) {
                sendLog(client, `❌ 檢查包裹貨態時發生錯誤：${record.trackingNumber}`, 'ERROR', error);
            }
        }
    } finally {
        isChecking = false;
    }
}

module.exports = (client) => {
    const packageConfig = getPackageTrackingConfig();

    if (!hasTrackTwToken()) {
        sendLog(client, '⚠️ 物流追蹤未設定 Track.TW API Token，監聽未啟動。', 'WARN');
        return;
    }

    client.once(Events.ClientReady, () => {
        setInterval(() => {
            checkPackages(client);
        }, packageConfig.checkInterval);
        sendLog(client, `✅ 物流追蹤監聽已啟動，每 ${Math.round(packageConfig.checkInterval / 60000)} 分鐘檢查一次。`);
    });
};
