const path = require('path');
/**
 * Track.TW 物流功能的 Discord 互動層。
 *
 * 新增流程可能跨越 Modal、物流商選單與額外欄位表單，因此 Map 保存本次程序的
 * 暫態選擇；正式包裹資料由 `util/getPackageTracking` 依使用者寫入 JSON。
 * 暫態資料不跨重啟，遺失時使用者只需重新執行新增或選取流程。
 */
const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const { config, configCommands } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));
const { errorReply, validationReply } = require(path.join(process.cwd(), 'core/Reply'));
const {
    getAvailableCarriers,
    detectCarrier,
    importPackage,
    trackingPackage,
    changePackageState,
    findCarrier,
    createPackageEmbed,
    createAddPackageButton,
    createAddPackageRow,
    createPackageNotificationActionsRows,
    withAddPackageRow,
    findDuplicatePackage,
    getPackageRecord,
    upsertPackageRecord,
    updatePackageRecord,
    deletePackageRecord,
    getPackageRecords,
    createPackageRecord,
    createHistorySignature,
    createStoredPackageEmbed
} = require(path.join(process.cwd(), 'util/getPackageTracking'));

const EMBED_COLOR = config.embed.color.default;
const EMBED_EMOJI = configCommands.packageTracking?.emoji || '📦';
const MAX_SELECT_OPTIONS = 25;
const MAX_CARRIER_SELECT_OPTIONS = MAX_SELECT_OPTIONS * 2;
const pendingExtraFields = new Map();
const pendingCarrierChoices = new Map();
const DEFERRED_UPDATE = Symbol('packageDeferredUpdate');

// 面板元件與跨互動狀態 ------------------------------------------------------

async function deferMessageUpdate(interaction) {
    await interaction.deferUpdate();
    interaction[DEFERRED_UPDATE] = true;
}

/** deferUpdate 後的驗證錯誤必須另送私密 follow-up，不可覆寫原公開訊息。 */
function replyPackageValidation(interaction, message) {
    if (interaction[DEFERRED_UPDATE] || interaction.replied) {
        return validationReply(interaction, message, { method: 'followUp', ephemeral: true });
    }
    if (interaction.deferred) return validationReply(interaction, message);
    return validationReply(interaction, message, { method: 'reply', ephemeral: true });
}

/** 未知錯誤遵循相同可見性規則，並由 errorReply 產生事件 ID。 */
function replyPackageError(interaction, error, context) {
    if (interaction[DEFERRED_UPDATE] || interaction.replied) {
        return errorReply(interaction, error, { method: 'followUp', ephemeral: true, context });
    }
    return errorReply(interaction, error, { context });
}

function getUserRecords(userID, status = 'all') {
    return getPackageRecords({ userID, status })
        .filter(record => record.status !== 'deleted')
        .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));
}

function getUserRecordByID(userID, userPackageID) {
    return getPackageRecord(userID, userPackageID);
}

function createPanelEmbed(interaction) {
    const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle(`${EMBED_EMOJI} ┃ 物流追蹤 - 包裹管理面板`)
        .setDescription('使用下方按鈕新增包裹，或進入追蹤中與已封存包裹管理。')
        .setTimestamp();

    return embed;
}

function createPanelRows() {
    return [
        new ActionRowBuilder().addComponents(
            createAddPackageButton(),
            new ButtonBuilder()
                .setCustomId('package_panel_active')
                .setLabel('追蹤中')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('package_panel_archived')
                .setLabel('已封存')
                .setStyle(ButtonStyle.Secondary)
        )
    ];
}

function isDetachedAddFlow(interaction) {
    // detached 新增流程會另開一則回覆承載後續 edit，避免覆蓋目前的包裹狀態訊息。
    return interaction.customId.endsWith(':detached');
}

function createPackageAddModal(detached = false) {
    return new ModalBuilder()
        .setCustomId(detached ? 'package_panel_add_modal:detached' : 'package_panel_add_modal')
        .setTitle('新增物流追蹤')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('trackingNumber')
                    .setLabel('物流追蹤單號')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('note')
                    .setLabel('備註')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
            )
        );
}

function createNoteModal(record) {
    const noteInput = new TextInputBuilder()
        .setCustomId('note')
        .setLabel('備註')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

    if (record.note) {
        noteInput.setValue(record.note.slice(0, 100));
    }

    return new ModalBuilder()
        .setCustomId(`package_panel_note_modal:${record.userPackageID}`)
        .setTitle('修改包裹備註')
        .addComponents(
            new ActionRowBuilder().addComponents(
                noteInput
            )
        );
}

function createCarrierChoiceEmbed(carrierIDs, carriers) {
    const shownCount = Math.min(carrierIDs.length, MAX_CARRIER_SELECT_OPTIONS);
    const description = [
        '**偵測到多個可能的物流商，請從下方選單選擇。**',
        carrierIDs.length > MAX_CARRIER_SELECT_OPTIONS
            ? `\n僅顯示前 ${shownCount} 個候選項目，若沒有正確物流商，請重新檢查單號後再試。`
            : carrierIDs.length > MAX_SELECT_OPTIONS
                ? '\n候選項目較多，已分成兩個選單顯示。'
                : ''
    ].join('');

    return new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle(`${EMBED_EMOJI} ┃ 物流追蹤 - 選擇物流商`)
        .setDescription(description);
}

function createCarrierChoiceRows(carrierIDs, carriers) {
    const shownCarrierIDs = carrierIDs.slice(0, MAX_CARRIER_SELECT_OPTIONS);
    const chunks = [
        shownCarrierIDs.slice(0, MAX_SELECT_OPTIONS),
        shownCarrierIDs.slice(MAX_SELECT_OPTIONS, MAX_CARRIER_SELECT_OPTIONS)
    ].filter(chunk => chunk.length);

    return chunks.map((chunk, chunkIndex) => {
        const offset = chunkIndex * MAX_SELECT_OPTIONS;
        const menu = new StringSelectMenuBuilder()
            .setCustomId(chunkIndex === 0 ? 'package_panel_select_carrier' : 'package_panel_select_carrier_2')
            .setPlaceholder(chunkIndex === 0 ? '選擇物流商' : '選擇物流商（26-50）')
            .addOptions(
                chunk.map((carrierID, index) => {
                    const carrierIndex = offset + index;
                    const carrier = findCarrier(carriers, carrierID);
                    const name = carrier?.name || `物流商 ${carrierIndex + 1}`;
                    return new StringSelectMenuOptionBuilder()
                        .setLabel(name.slice(0, 100))
                        .setDescription('選擇此物流商')
                        .setValue(String(carrierIndex));
                })
            );

        return new ActionRowBuilder().addComponents(menu);
    });
}

function createPackageSelectRow(records, customId, placeholder) {
    const menu = new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(placeholder)
        .addOptions(
            records.slice(0, MAX_SELECT_OPTIONS).map(record =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(`${record.carrierName} ${record.trackingNumber}`.slice(0, 100))
                    .setDescription((record.note || '未設定備註').slice(0, 100))
                    .setValue(record.userPackageID.slice(0, 100))
            )
        );

    return new ActionRowBuilder().addComponents(menu);
}

function createPackageActionsRows(record = null) {
    return createPackageNotificationActionsRows(record);
}

/** 建立已封存包裹操作列；喚醒與刪除都必須綁定不可省略的 package ID。 */
function createArchivedActionsRows(record) {
    return withAddPackageRow([
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`package_panel_wake:${record.userPackageID}`)
                .setLabel('喚醒')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`package_panel_delete:${record.userPackageID}`)
                .setLabel('刪除')
                .setStyle(ButtonStyle.Danger)
        )
    ], 'package_panel_add:detached');
}

function createManageEmbed(record, packageData = null) {
    if (packageData) {
        return createPackageEmbed(record, packageData, '物流追蹤 - 包裹已更新');
    }

    return new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle(`${EMBED_EMOJI} ┃ 物流追蹤 - 已刪除包裹`)
        .setDescription(record.note || '未設定備註')
        .addFields(
            { name: '物流商', value: record.carrierName || '未知', inline: true },
            { name: '物流單號', value: `\`${record.trackingNumber}\``, inline: true },
            {
                name: '追蹤狀態',
                value: record.status === 'active' ? '追蹤中' : record.status === 'deleted' ? '已刪除' : '已封存',
                inline: true
            }
        )
        .setTimestamp();
}

// Track.TW 新增流程 ---------------------------------------------------------

/** 相容 Track.TW 不同回應形狀，找出新增後的 user_package_id。 */
function getImportResultID(importResult, trackingNumber) {
    return importResult[trackingNumber] || Object.values(importResult)[0];
}

async function resolveCarrier(trackingNumber) {
    const carriers = await getAvailableCarriers();
    const carrierIDs = await detectCarrier([trackingNumber]);

    if (!carrierIDs.length) {
        const error = new Error('**無法自動識別物流商，請重新檢查物流單號或稍後再次嘗試。**');
        error.isCarrierDetectionError = true;
        throw error;
    }

    if (carrierIDs.length > 1) {
        return { carrier: null, carrierIDs, carriers };
    }

    const carrier = findCarrier(carriers, carrierIDs[0]);
    if (!carrier) throw new Error('無法取得物流商資料。');

    return { carrier, carrierIDs, carriers };
}

/** 遠端匯入成功並取得首份貨態後才寫入本機；這是新增流程的 commit 點。 */
async function importAndStorePackage(interaction, pending, extraFields = null) {
    const duplicate = findDuplicatePackage(interaction.user.id, pending.carrier.id, pending.trackingNumber);
    if (duplicate) {
        return replyPackageValidation(interaction, `**這筆物流單已存在。**\n狀態：${duplicate.status === 'active' ? '追蹤中' : '已封存'}`);
    }

    const importResult = await importPackage(pending.carrier.id, pending.trackingNumber, pending.note, extraFields);
    const userPackageID = getImportResultID(importResult, pending.trackingNumber);
    if (!userPackageID) throw new Error('Track.TW 未回傳 user_package_id。');

    const packageData = await trackingPackage(userPackageID);
    const record = createPackageRecord({
        interaction,
        carrier: pending.carrier,
        trackingNumber: pending.trackingNumber,
        note: pending.note,
        userPackageID,
        packageData
    });

    upsertPackageRecord(record);
    const embed = createPackageEmbed(record, packageData, '物流追蹤 - 新增完成');
    await interaction.editReply({ embeds: [embed], components: createPackageActionsRows(record) });
    sendLog(
        interaction.client,
        `📦 ${interaction.user.tag} 新增了物流追蹤：${pending.trackingNumber}`,
        'INFO',
        null,
        { sensitiveValues: [pending.trackingNumber] }
    );
}

async function continuePackageImport(interaction, pending) {
    const requirements = Array.isArray(pending.carrier.requirements) ? pending.carrier.requirements : [];
    pending.requirements = requirements;

    if (requirements.length > 5) {
        return replyPackageValidation(interaction, '**此物流商需要超過 5 個額外欄位，目前無法透過 Discord 表單新增。**');
    }

    if (requirements.length > 0) {
        pendingExtraFields.set(interaction.user.id, pending);

        const embed = new EmbedBuilder()
            .setColor(EMBED_COLOR)
            .setTitle(`${EMBED_EMOJI} ┃ 需要補填物流資訊`)
            .setDescription(`物流商 **${pending.carrier.name}** 需要額外資料才能查詢。\n請點擊下方按鈕填寫。`);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('package_panel_extra_fields')
                .setLabel('填寫額外資訊')
                .setStyle(ButtonStyle.Primary)
        );

        await interaction.editReply({ embeds: [embed], components: withAddPackageRow([row]) });
        return;
    }

    await importAndStorePackage(interaction, pending);
}

// 面板導覽與包裹操作 --------------------------------------------------------

async function handlePanel(interaction) {
    await interaction.reply({
        embeds: [createPanelEmbed(interaction)],
        components: createPanelRows()
    });
}

async function handleAddModalSubmit(interaction) {
    if (isDetachedAddFlow(interaction)) {
        // 從既有物流狀態訊息新增時另建流程訊息；後續選物流商/補填資訊/完成都 edit 這則回覆。
        await interaction.deferReply({ ephemeral: true });
    } else {
        await deferMessageUpdate(interaction);
    }

    const trackingNumber = interaction.fields.getTextInputValue('trackingNumber').trim();
    const note = interaction.fields.getTextInputValue('note')?.trim() || '';

    try {
        const { carrier, carrierIDs, carriers } = await resolveCarrier(trackingNumber);
        const pending = { trackingNumber, note, carrier };

        if (!carrier && carrierIDs?.length > 1) {
            pendingCarrierChoices.set(interaction.user.id, { trackingNumber, note, carrierIDs, carriers });
            await interaction.editReply({
                embeds: [createCarrierChoiceEmbed(carrierIDs, carriers)],
                components: withAddPackageRow(createCarrierChoiceRows(carrierIDs, carriers))
            });
            return;
        }

        await continuePackageImport(interaction, pending);
    } catch (error) {
        if (error.isCarrierDetectionError) return replyPackageValidation(interaction, error.message);
        sendLog(interaction.client, '❌ 新增物流追蹤時發生錯誤：', 'ERROR', error);
        return replyPackageError(interaction, error, '新增物流追蹤');
    }
}

async function handleManagePackages(interaction) {
    await deferMessageUpdate(interaction);

    const records = getUserRecords(interaction.user.id, 'active');
    if (!records.length) {
        return replyPackageValidation(interaction, '**目前沒有追蹤中的包裹。**');
    }

    const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle(`${EMBED_EMOJI} ┃ 選擇包裹`)
        .setDescription(records.length > MAX_SELECT_OPTIONS
            ? `請選擇要管理的包裹。僅顯示最近 ${MAX_SELECT_OPTIONS} 筆追蹤中包裹。`
            : '請選擇要管理的包裹。');

    await interaction.editReply({
        embeds: [embed],
        components: withAddPackageRow([createPackageSelectRow(records, 'package_panel_select_active_package', '選擇追蹤中的包裹')])
    });
}

async function handleArchivedPackages(interaction) {
    await deferMessageUpdate(interaction);

    const records = getUserRecords(interaction.user.id, 'archived');
    if (!records.length) {
        return replyPackageValidation(interaction, '**目前沒有已封存的包裹。**');
    }

    const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle(`${EMBED_EMOJI} ┃ 物流追蹤 - 選擇已封存包裹`)
        .setDescription(records.length > MAX_SELECT_OPTIONS
            ? `請選擇要查看的已封存包裹。僅顯示最近 ${MAX_SELECT_OPTIONS} 筆。`
            : '請選擇要查看的已封存包裹。');

    await interaction.editReply({
        embeds: [embed],
        components: withAddPackageRow([createPackageSelectRow(records, 'package_panel_select_archived_package', '選擇已封存的包裹')])
    });
}

async function updateActiveRecord(record) {
    const packageData = await trackingPackage(record.userPackageID);
    const signature = createHistorySignature(packageData);
    const updates = {
        lastHistorySignature: signature,
        lastPackageData: packageData
    };
    if (signature !== record.lastHistorySignature) {
        updates.lastHistoryChangedAt = new Date().toISOString();
    }

    return {
        packageData,
        record: updatePackageRecord(record.userID, record.userPackageID, updates) || record
    };
}

async function handleActivePackageSelected(interaction) {
    await deferMessageUpdate(interaction);

    const record = getUserRecordByID(interaction.user.id, interaction.values[0]);
    if (!record || record.status !== 'active') {
        return replyPackageValidation(interaction, '**找不到可管理的追蹤中包裹。**');
    }

    try {
        const updated = await updateActiveRecord(record);
        await interaction.editReply({
            embeds: [createManageEmbed(updated.record, updated.packageData)],
            components: createPackageActionsRows(updated.record)
        });
    } catch (error) {
        sendLog(interaction.client, '❌ 選擇追蹤中包裹並更新時發生錯誤：', 'ERROR', error);
        return replyPackageError(interaction, error, '更新選取的物流包裹');
    }
}

async function handleArchivedPackageSelected(interaction) {
    await deferMessageUpdate(interaction);

    const record = getUserRecordByID(interaction.user.id, interaction.values[0]);
    if (!record || record.status !== 'archived') {
        return replyPackageValidation(interaction, '**找不到可查看的已封存包裹。**');
    }

    await interaction.editReply({
        embeds: [createStoredPackageEmbed(record, '物流追蹤 - 包裹已封存')],
        components: createArchivedActionsRows(record)
    });
}

/** 從 `action:packageID` 取出完整 ID；舊按鈕缺少 ID 時回傳 null。 */
function getScopedUserPackageID(interaction, customId) {
    const prefix = `${customId}:`;
    const packageID = interaction.customId.startsWith(prefix) ? interaction.customId.slice(prefix.length) : '';
    return packageID || null;
}

/** 在 acknowledgement 前直接從點擊者的檔案取回包裹並核對 owner 與允許狀態。 */
function getTargetRecord(interaction, customId, allowedStatuses, findRecord = getUserRecordByID) {
    const userPackageID = getScopedUserPackageID(interaction, customId);
    if (!userPackageID) return null;
    const record = findRecord(interaction.user.id, userPackageID);
    if (!record || String(record.userID) !== interaction.user.id || !allowedStatuses.includes(record.status)) return null;
    return record;
}

async function handleRefreshSelected(interaction) {
    const record = getTargetRecord(interaction, 'package_panel_refresh', ['active']);
    if (!record) return replyPackageValidation(interaction, '**這個包裹操作已過期，或你不是包裹擁有者。**');
    await deferMessageUpdate(interaction);

    try {
        const updated = await updateActiveRecord(record);
        await interaction.editReply({
            embeds: [createManageEmbed(updated.record, updated.packageData)],
            components: createPackageActionsRows(updated.record)
        });
    } catch (error) {
        sendLog(interaction.client, '❌ 立即更新包裹時發生錯誤：', 'ERROR', error);
        return replyPackageError(interaction, error, '立即更新物流包裹');
    }
}

async function handleArchiveSelected(interaction) {
    const record = getTargetRecord(interaction, 'package_panel_archive', ['active']);
    if (!record) return replyPackageValidation(interaction, '**這個包裹操作已過期，或你不是包裹擁有者。**');
    await deferMessageUpdate(interaction);

    try {
        await changePackageState(record.userPackageID, 'archive');
        const updatedRecord = updatePackageRecord(record.userID, record.userPackageID, { status: 'archived' }) || record;
        await interaction.editReply({
            embeds: [createStoredPackageEmbed(updatedRecord, '物流追蹤 - 已封存包裹')],
            components: createArchivedActionsRows(updatedRecord)
        });
    } catch (error) {
        sendLog(interaction.client, '❌ 封存包裹時發生錯誤：', 'ERROR', error);
        return replyPackageError(interaction, error, '封存物流包裹');
    }
}

async function handleDeleteSelected(interaction) {
    const record = getTargetRecord(interaction, 'package_panel_delete', ['active', 'archived']);
    if (!record) return replyPackageValidation(interaction, '**這個包裹操作已過期，或你不是包裹擁有者。**');
    await deferMessageUpdate(interaction);

    try {
        await changePackageState(record.userPackageID, 'delete');
        deletePackageRecord(record.userID, record.userPackageID);
        const updatedRecord = { ...record, status: 'deleted' };
        await interaction.editReply({
            embeds: [createManageEmbed(updatedRecord)],
            components: [createAddPackageRow()]
        });
    } catch (error) {
        sendLog(interaction.client, '❌ 刪除包裹時發生錯誤：', 'ERROR', error);
        return replyPackageError(interaction, error, '刪除物流包裹');
    }
}

async function handleWakeSelected(interaction) {
    const record = getTargetRecord(interaction, 'package_panel_wake', ['archived']);
    if (!record) return replyPackageValidation(interaction, '**這個包裹操作已過期，或你不是包裹擁有者。**');
    await deferMessageUpdate(interaction);

    try {
        await changePackageState(record.userPackageID, 'inbox');
        const updatedRecord = updatePackageRecord(record.userID, record.userPackageID, {
            status: 'active',
            lastHistoryChangedAt: new Date().toISOString()
        }) || record;
        await interaction.editReply({
            embeds: [createStoredPackageEmbed(updatedRecord, '物流追蹤 - 包裹已更新')],
            components: createPackageActionsRows(updatedRecord)
        });
    } catch (error) {
        sendLog(interaction.client, '❌ 喚醒包裹時發生錯誤：', 'ERROR', error);
        return replyPackageError(interaction, error, '喚醒物流包裹');
    }
}

async function handleNoteModalSubmit(interaction) {
    const record = getTargetRecord(interaction, 'package_panel_note_modal', ['active']);
    if (!record) return replyPackageValidation(interaction, '**這個包裹操作已過期，或你不是包裹擁有者。**');
    await deferMessageUpdate(interaction);

    const note = interaction.fields.getTextInputValue('note')?.trim() || '';
    const updatedRecord = updatePackageRecord(record.userID, record.userPackageID, { note }) || record;
    await interaction.editReply({
        embeds: [createStoredPackageEmbed(updatedRecord, '物流追蹤 - 包裹已更新')],
        components: createPackageActionsRows(updatedRecord)
    });
}

async function handleCarrierSelected(interaction) {
    await deferMessageUpdate(interaction);

    const pendingChoice = pendingCarrierChoices.get(interaction.user.id);
    if (!pendingChoice) {
        return replyPackageValidation(interaction, '**找不到待選擇的物流商資料，請重新執行新增流程。**');
    }

    const carrierIndex = Number(interaction.values[0]);
    const carrierID = pendingChoice.carrierIDs.slice(0, MAX_CARRIER_SELECT_OPTIONS)[carrierIndex];
    if (!carrierID) {
        return replyPackageValidation(interaction, '**選擇的物流商不在候選清單中，請重新執行新增流程。**');
    }

    const carrier = findCarrier(pendingChoice.carriers, carrierID);
    if (!carrier) {
        return replyPackageValidation(interaction, '**無法取得物流商資料，請稍後再次嘗試。**');
    }

    pendingCarrierChoices.delete(interaction.user.id);

    try {
        await continuePackageImport(interaction, {
            trackingNumber: pendingChoice.trackingNumber,
            note: pendingChoice.note,
            carrier
        });
    } catch (error) {
        sendLog(interaction.client, '❌ 選擇物流商新增物流追蹤時發生錯誤：', 'ERROR', error);
        return replyPackageError(interaction, error, '選擇物流商並新增物流追蹤');
    }
}

// Handler key 必須與按鈕、選單及 Modal 的 customId 冒號前綴一致。
module.exports = {
    data: new SlashCommandBuilder()
        .setName('物流追蹤')
        .setDescription('開啟物流追蹤管理面板'),

    async execute(interaction) {
        return handlePanel(interaction);
    },

    buttonHandlers: {
        package_panel_add: async (interaction) => {
            await interaction.showModal(createPackageAddModal(isDetachedAddFlow(interaction)));
        },

        package_panel_active: handleManagePackages,

        package_panel_archived: handleArchivedPackages,

        package_panel_extra_fields: async (interaction) => {
            const pending = pendingExtraFields.get(interaction.user.id);
            if (!pending) {
                return replyPackageValidation(interaction, '**找不到待補填的包裹資料，請重新執行新增流程。**');
            }

            const modal = new ModalBuilder()
                .setCustomId('package_panel_extra_fields_modal')
                .setTitle('補填物流資訊');

            for (const requirement of pending.requirements) {
                const input = new TextInputBuilder()
                    .setCustomId(requirement.key)
                    .setLabel((requirement.desc || requirement.key).slice(0, 45))
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder((requirement.placeholder || '').slice(0, 100))
                    .setRequired(true);

                modal.addComponents(new ActionRowBuilder().addComponents(input));
            }

            await interaction.showModal(modal);
        },

        package_panel_refresh: handleRefreshSelected,

        package_panel_note: async (interaction) => {
            const record = getTargetRecord(interaction, 'package_panel_note', ['active']);
            if (!record) {
                return replyPackageValidation(interaction, '**這個包裹操作已過期，或你不是包裹擁有者。**');
            }
            await interaction.showModal(createNoteModal(record));
        },

        package_panel_archive: handleArchiveSelected,

        package_panel_delete: handleDeleteSelected,

        package_panel_wake: handleWakeSelected
    },

    componentHandlers: {
        package_panel_select_carrier: handleCarrierSelected,

        package_panel_select_carrier_2: handleCarrierSelected,

        package_panel_select_active_package: handleActivePackageSelected,

        package_panel_select_archived_package: handleArchivedPackageSelected
    },

    modalSubmitHandlers: {
        package_panel_add_modal: handleAddModalSubmit,

        package_panel_extra_fields_modal: async (interaction) => {
            await deferMessageUpdate(interaction);

            const pending = pendingExtraFields.get(interaction.user.id);
            if (!pending) {
                return replyPackageValidation(interaction, '**找不到待補填的包裹資料，請重新執行新增流程。**');
            }

            const extraFields = {};
            for (const requirement of pending.requirements) {
                const value = interaction.fields.getTextInputValue(requirement.key);
                if (requirement.regex && !new RegExp(requirement.regex).test(value)) {
                    return replyPackageValidation(interaction, `**${requirement.desc || requirement.key} 格式不正確。**`);
                }
                extraFields[requirement.key] = value;
            }

            try {
                await importAndStorePackage(interaction, pending, extraFields);
                pendingExtraFields.delete(interaction.user.id);
                sendLog(
                    interaction.client,
                    `📦 ${interaction.user.tag} 補填資料並新增了物流追蹤：${pending.trackingNumber}`,
                    'INFO',
                    null,
                    { sensitiveValues: [pending.trackingNumber] }
                );
            } catch (error) {
                sendLog(interaction.client, '❌ 補填資料新增物流追蹤時發生錯誤：', 'ERROR', error);
                return replyPackageError(interaction, error, '補填資料並新增物流追蹤');
            }
        },

        package_panel_note_modal: handleNoteModalSubmit
    }
};

module.exports._test = { createArchivedActionsRows, getScopedUserPackageID, getTargetRecord };
