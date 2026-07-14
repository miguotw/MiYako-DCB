const path = require('path');
const { ChannelType, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { createCommandPolicy } = require('../../../core/commandPolicy');
const { createReplyTools } = require('../../../core/Reply');
const { createLogTools } = require('../../../core/sendLog');
const { createRaffle, deleteRaffle, getRaffle, updateRaffle } = require('../../../util/raffleStore');
const { createRaffleViews } = require('../../../util/raffleViews');
const {
    fetchSourceMessage, parseDeadline: parseDeadlineInput, parseMentionTargets, resolveMentionedUsers
} = require('../../../util/discordCommandInput');

function createCommand(config) {
const { getAdminCommandPath } = createCommandPolicy(config);
const { errorReply, infoReply, validationReply } = createReplyTools(config);
const { sendLog } = createLogTools(config);
const { createRaffleEmbed, participationRow } = createRaffleViews(config);

// 將專案時區預設值包在指令層，讓共用解析器不依賴全域設定。
function parseDeadline(value, timezoneOffset = config.log.timezone) {
    return parseDeadlineInput(value, timezoneOffset);
}

const command = {
    data: new SlashCommandBuilder()
        .setName('抽選系統')
        .setDescription('建立與管理抽選')
        .setDMPermission(false)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(opt => opt.setName('訊息id或連結').setDescription('作為介紹內文的訊息 ID 或連結').setRequired(true))
        .addChannelOption(opt => opt.setName('選擇頻道').setDescription('發送抽選消息的頻道').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
        .addIntegerOption(opt => opt.setName('抽選數量').setDescription('要抽出的用戶數量（1～100）').setMinValue(1).setMaxValue(100).setRequired(true))
        .addStringOption(opt => opt.setName('截止時間').setDescription('格式：yyyy-mm-dd hh:mm；依 log.timezone 偏移').setRequired(true))
        .addBooleanOption(opt => opt.setName('自動抽選').setDescription('截止後是否自動抽選').setRequired(true))
        .addRoleOption(opt => opt.setName('提及身分組').setDescription('建立抽選時要提及的身分組').setRequired(false))
        .addStringOption(opt => opt.setName('白名單').setDescription('使用 @用戶 或 @身分組；白名單用戶無須參與抽選').setMaxLength(6000))
        .addStringOption(opt => opt.setName('黑名單').setDescription('使用 @用戶 或 @身分組；黑名單用戶不可參與抽選').setMaxLength(6000)),

    async execute(interaction, context) {
        if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
            return validationReply(interaction, '**此指令僅限伺服器管理員使用。**', { ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });
        sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：${getAdminCommandPath('抽選系統')}`);
        try {
            const source = await fetchSourceMessage(interaction, interaction.options.getString('訊息id或連結', true));
            if (!source.content.trim()) return validationReply(interaction, '**來源訊息沒有可作為介紹的文字內容。**');
            if (source.content.length > 4096) return validationReply(interaction, '**來源訊息超過 Embed 介紹內文的 4096 字元上限。**');
            const channel = interaction.options.getChannel('選擇頻道', true);
            if (!channel.isTextBased() || typeof channel.send !== 'function') return validationReply(interaction, '**請選擇可發送訊息的文字頻道。**');

            const entryDeadline = parseDeadline(interaction.options.getString('截止時間', true));
            if (!entryDeadline || entryDeadline <= Math.floor(Date.now() / 1000)) {
                return validationReply(interaction, '**截止時間格式錯誤，或該時間已截止。請使用 yyyy-mm-dd hh:mm。**');
            }
            const whitelistTargets = parseMentionTargets(interaction.options.getString('白名單'), '白名單');
            const blacklistTargets = parseMentionTargets(interaction.options.getString('黑名單'), '黑名單');
            const whitelistUserIDs = await resolveMentionedUsers(interaction, whitelistTargets, '白名單');
            const blacklistUserIDs = await resolveMentionedUsers(interaction, blacklistTargets, '黑名單');
            const conflicts = whitelistUserIDs.filter(id => blacklistUserIDs.includes(id));
            if (conflicts.length) return validationReply(interaction, `**白名單與黑名單包含相同用戶：${conflicts.map(id => `<@${id}>`).join('、')}**`);
            const winnerCount = interaction.options.getInteger('抽選數量', true);

            const image = source.attachments.find(attachment => attachment.contentType?.startsWith('image/'));
            const role = interaction.options.getRole('提及身分組');
            const raffle = createRaffle(interaction.guildId, {
                creatorID: interaction.user.id,
                sourceChannelID: source.channelId,
                sourceMessageID: source.id,
                channelID: channel.id,
                messageID: null,
                roleID: role?.id || null,
                description: source.content,
                imageURL: image?.url || null,
                winnerCount,
                entryDeadline,
                autoDraw: interaction.options.getBoolean('自動抽選', true),
                whitelistUserIDs,
                blacklistUserIDs
            });
            try {
                const message = await channel.send({
                    content: role ? `${role}` : null,
                    embeds: [createRaffleEmbed(raffle)],
                    components: participationRow(raffle),
                    allowedMentions: { roles: role ? [role.id] : [] }
                });
                updateRaffle(interaction.guildId, raffle.id, current => { current.messageID = message.id; });
            } catch (error) {
                deleteRaffle(interaction.guildId, raffle.id);
                throw error;
            }
            return infoReply(interaction, `**已在 ${channel} 建立抽選。**\n抽選 ID：\`${raffle.id}\``);
        } catch (error) {
            sendLog(interaction.client, '❌ 建立抽選時發生錯誤：', 'ERROR', error);
            return errorReply(interaction, error, { context: '建立抽選' });
        }
    },

    publicButtonHandlers: {
        raffle_join: async interaction => {
            const raffleID = interaction.customId.split(':')[1];
            if (interaction.user.bot) return validationReply(interaction, '**Bot 無法參加抽選。**', { ephemeral: true });
            const raffle = getRaffle(interaction.guildId, raffleID);
            if (!raffle) return validationReply(interaction, '**找不到這筆抽選。**', { ephemeral: true });
            if (raffle.status !== 'open' || Math.floor(Date.now() / 1000) >= raffle.entryDeadline) return validationReply(interaction, '**這筆抽選已截止。**', { ephemeral: true });
            const whitelist = raffle.whitelistUserIDs || raffle.qualifiedUserIDs || [];
            const blacklist = raffle.blacklistUserIDs || [];
            if (whitelist.includes(interaction.user.id)) return infoReply(interaction, '**您在本次抽選的白名單中，無須參與抽選。**', { ephemeral: true });
            if (blacklist.includes(interaction.user.id)) return validationReply(interaction, '**您在本次抽選的黑名單中，不可參與抽選。**', { ephemeral: true });
            let joined = false;
            let cancelled = false;
            updateRaffle(interaction.guildId, raffleID, current => {
                if (current.status !== 'open' || Math.floor(Date.now() / 1000) >= current.entryDeadline) return;
                const index = current.participants.indexOf(interaction.user.id);
                if (index >= 0) {
                    current.participants.splice(index, 1);
                    cancelled = true;
                } else {
                    current.participants.push(interaction.user.id);
                    joined = true;
                }
            });
            if (!joined && !cancelled) return validationReply(interaction, '**這筆抽選剛剛截止。**', { ephemeral: true });
            const updated = getRaffle(interaction.guildId, raffleID);
            try {
                await interaction.message.edit({ embeds: [createRaffleEmbed(updated)], components: participationRow(updated) });
            } catch (error) {
                sendLog(interaction.client, `❌ 更新抽選 ${raffleID} 登記名單時發生錯誤：`, 'ERROR', error);
            }
            return infoReply(interaction, cancelled ? '**已取消抽選登記。**' : '**已成功登記抽選！**', { ephemeral: true });
        }
    }
};

command._test = { parseDeadline, parseMentionTargets };
return command;
}

module.exports = { createCommand };
