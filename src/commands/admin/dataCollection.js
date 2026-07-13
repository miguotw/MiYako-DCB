const path = require('path');
const {
    ActionRowBuilder, ChannelType, EmbedBuilder, ModalBuilder, PermissionFlagsBits, SlashCommandBuilder,
    TextInputBuilder, TextInputStyle
} = require('discord.js');
const { config, configCommands } = require(path.join(process.cwd(), 'core/config'));
const { getAdminCommandPath } = require(path.join(process.cwd(), 'core/commandPolicy'));
const { errorReply, infoReply } = require(path.join(process.cwd(), 'core/Reply'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));
const {
    createDataCollection, deleteDataCollection, findDataCollection, getDataCollection,
    updateDataCollection, withCollectionLock
} = require(path.join(process.cwd(), 'util/dataCollectionStore'));
const {
    createMentionBatches, createPublicEmbed, deleteAdminPanels, submitRow, syncAdminPanels
} = require(path.join(process.cwd(), 'util/dataCollectionViews'));
const {
    fetchSourceMessage, parseDeadline: parseDeadlineInput,
    parseMentionTargets: parseMentionTargetsInput, resolveMentionedUsers
} = require(path.join(process.cwd(), 'util/discordCommandInput'));

function getDataCollectionLimits(settings = {}) {
    return {
        titleMaxLength: Math.min(Math.max(Number(settings.titleMaxLength) || 10, 1), 45),
        submissionMaxLength: Math.min(Math.max(Number(settings.submissionMaxLength) || 20, 1), 700)
    };
}

const { titleMaxLength: TITLE_MAX_LENGTH, submissionMaxLength: SUBMISSION_MAX_LENGTH } =
    getDataCollectionLimits(configCommands.dataCollection);

function parseDeadline(value, timezoneOffset = config.log.timezone) {
    return parseDeadlineInput(value, timezoneOffset);
}

function parseMentionTargets(value) {
    return parseMentionTargetsInput(value, '白名單', { required: true });
}

async function resolveWhitelist(interaction, targets) {
    const userIDs = await resolveMentionedUsers(interaction, targets, '白名單');
    if (!userIDs.length) throw new Error('白名單沒有任何可提交資料的真人成員。');
    return userIDs;
}

async function buildWhitelist(interaction, value, resolver = resolveWhitelist) {
    const targets = parseMentionTargets(value);
    return { targets, userIDs: await resolver(interaction, targets) };
}

function createSubmitModal(record, userID) {
    const existing = record.submissions?.[userID];
    const modal = new ModalBuilder().setCustomId(`data_collection_modal:${record.id}`).setTitle('提交資料');
    record.fieldLabels.forEach((label, index) => {
        const input = new TextInputBuilder().setCustomId(`data_${index + 1}`).setLabel(label)
            .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(SUBMISSION_MAX_LENGTH);
        if (existing?.values?.[index]) input.setValue(existing.values[index]);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
    });
    return modal;
}

async function disablePublicPanel(client, record) {
    const channel = await client.channels.fetch(record.publicChannelID).catch(() => null);
    const message = await channel?.messages?.fetch(record.publicMessageID).catch(() => null);
    if (message) await message.edit({ components: submitRow(record, true) }).catch(() => {});
}

function canManageCollection(interaction, record) {
    if (interaction.user.id === record.creatorID) return true;
    return interaction.inGuild() && interaction.guildId === record.guildID
        && interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

function privateReply(interaction) { return interaction.inGuild(); }

module.exports = {
    data: new SlashCommandBuilder().setName('資料收集').setDescription('建立資料收集面板')
        .addStringOption(opt => opt.setName('訊息id或連結').setDescription('作為介紹內文的訊息 ID 或連結').setRequired(true))
        .addChannelOption(opt => opt.setName('選擇頻道').setDescription('發送資料收集消息的頻道').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
        .addStringOption(opt => opt.setName('截止時間').setDescription('格式：yyyy-mm-dd hh:mm；依 log.timezone 偏移').setRequired(true))
        .addStringOption(opt => opt.setName('白名單').setDescription('使用 @用戶 或 @身分組；只有白名單可提交').setMaxLength(6000).setRequired(true))
        .addStringOption(opt => opt.setName('管理面板').setDescription('管理面板要發送到目前頻道或私訊').addChoices(
            { name: '目前頻道', value: 'channel' },
            { name: '私信我', value: 'dm' }
        ).setRequired(true))
        .addStringOption(opt => opt.setName('資料1').setDescription('第一個資料欄位的標題').setMinLength(1).setMaxLength(TITLE_MAX_LENGTH).setRequired(true))
        .addStringOption(opt => opt.setName('資料2').setDescription('第二個資料欄位的標題').setMinLength(1).setMaxLength(TITLE_MAX_LENGTH))
        .addStringOption(opt => opt.setName('資料3').setDescription('第三個資料欄位的標題').setMinLength(1).setMaxLength(TITLE_MAX_LENGTH))
        .addStringOption(opt => opt.setName('資料4').setDescription('第四個資料欄位的標題').setMinLength(1).setMaxLength(TITLE_MAX_LENGTH))
        .addStringOption(opt => opt.setName('資料5').setDescription('第五個資料欄位的標題').setMinLength(1).setMaxLength(TITLE_MAX_LENGTH)),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });
        sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：${getAdminCommandPath('資料收集')}`);
        let record = null;
        let publicMessage = null;
        const mentionMessages = [];
        try {
            const source = await fetchSourceMessage(interaction, interaction.options.getString('訊息id或連結', true));
            if (!source.content.trim()) return errorReply(interaction, '**來源訊息沒有可作為介紹的文字內容。**');
            if (source.content.length > 4096) return errorReply(interaction, '**來源訊息超過 Embed 介紹內文的 4096 字元上限。**');
            const publicChannel = interaction.options.getChannel('選擇頻道', true);
            if (!publicChannel.isTextBased() || typeof publicChannel.send !== 'function') return errorReply(interaction, '**請選擇可發送訊息的文字頻道。**');
            if (!interaction.channel?.isTextBased() || typeof interaction.channel.send !== 'function') return errorReply(interaction, '**目前頻道無法建立管理面板。**');
            const deadline = parseDeadline(interaction.options.getString('截止時間', true));
            if (!deadline || deadline <= Math.floor(Date.now() / 1000)) return errorReply(interaction, '**截止時間格式錯誤或已過期，請使用 yyyy-mm-dd hh:mm。**');
            const whitelist = await buildWhitelist(interaction, interaction.options.getString('白名單', true));
            const whitelistTargets = whitelist.targets;
            const whitelistUserIDs = whitelist.userIDs;
            const fieldLabels = [1, 2, 3, 4, 5].map(index => interaction.options.getString(`資料${index}`)?.trim()).filter(Boolean);
            const image = source.attachments.find(attachment => attachment.contentType?.startsWith('image/'));
            const adminPanelTarget = interaction.options.getString('管理面板', true);
            const adminChannel = adminPanelTarget === 'dm'
                ? await interaction.user.createDM()
                : interaction.channel;
            if (!adminChannel?.isTextBased() || typeof adminChannel.send !== 'function') {
                return errorReply(interaction, '**無法建立管理面板頻道；若選擇私信我，請確認 Bot 可以私訊您。**');
            }

            record = createDataCollection(interaction.guildId, {
                creatorID: interaction.user.id,
                sourceChannelID: source.channelId,
                sourceMessageID: source.id,
                publicChannelID: publicChannel.id,
                adminChannelID: adminChannel.id,
                adminPanelTarget,
                description: source.content,
                imageURL: image?.url || null,
                deadline,
                whitelistUserIDs,
                whitelistMentionTargets: whitelistTargets,
                fieldLabels,
                adminSyncPending: true
            });
            const mentionBatches = createMentionBatches(whitelistTargets);
            for (const batch of mentionBatches.slice(0, -1)) {
                mentionMessages.push(await publicChannel.send({
                    content: batch.content,
                    allowedMentions: { users: batch.userIDs, roles: batch.roleIDs }
                }));
            }
            const finalBatch = mentionBatches[mentionBatches.length - 1];
            publicMessage = await publicChannel.send({
                content: finalBatch.content,
                embeds: [createPublicEmbed(record)],
                components: submitRow(record),
                allowedMentions: { users: finalBatch.userIDs, roles: finalBatch.roleIDs }
            });
            record = updateDataCollection(interaction.guildId, record.id, current => {
                current.publicMessageID = publicMessage.id;
                current.publicMentionMessageIDs = mentionMessages.map(message => message.id);
            });
            await syncAdminPanels(interaction.client, record);
            return infoReply(interaction, `**已在 ${publicChannel} 建立資料收集面板。**\n唯一 ID：\`${record.id}\``);
        } catch (error) {
            sendLog(interaction.client, '❌ 建立資料收集面板時發生錯誤：', 'ERROR', error);
            if (publicMessage) await publicMessage.delete().catch(() => {});
            for (const message of mentionMessages) await message.delete().catch(() => {});
            if (record) {
                await deleteAdminPanels(interaction.client, getDataCollection(interaction.guildId, record.id) || record);
                deleteDataCollection(interaction.guildId, record.id);
            }
            return errorReply(interaction, `**${error.message || '無法建立資料收集面板。'}**`);
        }
    },

    buttonHandlers: {},

    modalSubmitHandlers: {},

    publicButtonHandlers: {
        data_collection_delete: async interaction => {
            const collectionID = interaction.customId.split(':')[1];
            const record = findDataCollection(collectionID);
            if (!record) return errorReply(interaction, '**找不到這筆資料收集。**', [], privateReply(interaction));
            if (!canManageCollection(interaction, record)) return errorReply(interaction, '**只有資料收集建立者或伺服器管理員可以刪除資料。**', [], privateReply(interaction));
            const modal = new ModalBuilder().setCustomId(`data_collection_delete_modal:${collectionID}`).setTitle('確認刪除資料收集')
                .addComponents(new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('confirmation').setLabel('輸入 y 以刪除所有收集資料')
                        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(1)
                ));
            return interaction.showModal(modal);
        },
        data_collection_submit: async interaction => {
            const collectionID = interaction.customId.split(':')[1];
            const record = getDataCollection(interaction.guildId, collectionID);
            if (!record) return errorReply(interaction, '**找不到這筆資料收集。**', [], true);
            if (record.status !== 'open' || Math.floor(Date.now() / 1000) >= record.deadline) return errorReply(interaction, '**資料提交已截止。**', [], true);
            if (!record.whitelistUserIDs.includes(interaction.user.id)) return errorReply(interaction, '**您不在本次資料收集的白名單中。**', [], true);
            return interaction.showModal(createSubmitModal(record, interaction.user.id));
        }
    },

    publicModalSubmitHandlers: {
        data_collection_delete_modal: async interaction => {
            const collectionID = interaction.customId.split(':')[1];
            await interaction.deferReply({ ephemeral: privateReply(interaction) });
            if (interaction.fields.getTextInputValue('confirmation').trim().toLowerCase() !== 'y') {
                return errorReply(interaction, '**確認文字不正確，未刪除資料。**');
            }
            return withCollectionLock(collectionID, async () => {
                const record = findDataCollection(collectionID);
                if (!record) return errorReply(interaction, '**找不到這筆資料收集。**');
                if (!canManageCollection(interaction, record)) return errorReply(interaction, '**只有資料收集建立者或伺服器管理員可以刪除資料。**');
                await disablePublicPanel(interaction.client, record);
                await deleteAdminPanels(interaction.client, record);
                deleteDataCollection(record.guildID, collectionID);
                sendLog(interaction.client, `💾 ${interaction.user.tag} 刪除資料收集 ${collectionID} 及全部提交資料。`);
                return infoReply(interaction, '**已停用公開面板並刪除所有收集資料。**');
            });
        },
        data_collection_modal: async interaction => {
            const collectionID = interaction.customId.split(':')[1];
            await interaction.deferReply({ ephemeral: true });
            return withCollectionLock(collectionID, async () => {
                let record = getDataCollection(interaction.guildId, collectionID);
                if (!record) return errorReply(interaction, '**找不到這筆資料收集。**', [], true);
                if (record.status !== 'open' || Math.floor(Date.now() / 1000) >= record.deadline) return errorReply(interaction, '**資料提交已截止。**', [], true);
                if (!record.whitelistUserIDs.includes(interaction.user.id)) return errorReply(interaction, '**您不在本次資料收集的白名單中。**', [], true);
                const values = record.fieldLabels.map((_, index) => interaction.fields.getTextInputValue(`data_${index + 1}`).trim());
                if (values.some(value => !value)) return errorReply(interaction, '**所有資料欄位皆為必填。**', [], true);
                const previous = record.submissions?.[interaction.user.id];
                const now = new Date().toISOString();
                record = updateDataCollection(interaction.guildId, collectionID, current => {
                    current.submissions[interaction.user.id] = {
                        values, submittedAt: previous?.submittedAt || now, updatedAt: now
                    };
                    current.adminSyncPending = true;
                });
                try { await syncAdminPanels(interaction.client, record); }
                catch (error) { sendLog(interaction.client, `❌ 更新資料收集 ${collectionID} 管理面板失敗：`, 'ERROR', error); }

                const copy = new EmbedBuilder().setColor(config.embed.color.default).setTitle('📝 ┃ 您提交的資料副本（BETA）')
                    .addFields(record.fieldLabels.map((label, index) => ({ name: label, value: values[index] })))
                    .setFooter({ text: record.id })
                    .setTimestamp();
                const dmSent = await interaction.user.send({ embeds: [copy] }).then(() => true).catch(() => false);
                return infoReply(interaction, dmSent
                    ? `**資料已${previous ? '更新' : '提交'}，副本已透過私訊寄送給您。**`
                    : `**資料已${previous ? '更新' : '提交'}，但副本寄送失敗。**\n可能原因包含關閉伺服器成員私訊、封鎖 Bot，或 Discord 隱私設定限制。`, [], true);
            });
        }
    }
};

module.exports._test = {
    buildWhitelist, getDataCollectionLimits, parseDeadline, parseMentionTargets
};
