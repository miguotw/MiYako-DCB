const path = require('path');
const { ChannelType, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { config } = require(path.join(process.cwd(), 'core/config'));
const { getAdminCommandPath } = require(path.join(process.cwd(), 'core/commandPolicy'));
const { errorReply, infoReply } = require(path.join(process.cwd(), 'core/Reply'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));
const { createRaffle, deleteRaffle, getRaffle, updateRaffle } = require(path.join(process.cwd(), 'util/raffleStore'));
const { createRaffleEmbed, participationRow } = require(path.join(process.cwd(), 'util/raffleViews'));

const MESSAGE_LINK = /^https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)\/?$/i;
const DISCORD_REQUEST_TIMEOUT_MS = 15000;

function withTimeout(promise, message) {
    let timeout;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error(message)), DISCORD_REQUEST_TIMEOUT_MS);
        })
    ]).finally(() => clearTimeout(timeout));
}

function parseDeadline(value, timezoneOffset = config.log.timezone) {
    const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d)$/);
    if (!match) return null;
    const [, year, month, day, hour, minute] = match.map(Number);
    const localDate = new Date(year, month - 1, day, hour, minute, 0, 0);
    if (localDate.getFullYear() !== year || localDate.getMonth() !== month - 1 || localDate.getDate() !== day
        || localDate.getHours() !== hour || localDate.getMinutes() !== minute) return null;

    const offset = Number(timezoneOffset);
    localDate.setHours(localDate.getHours() + (Number.isFinite(offset) ? offset : 0));
    return Math.floor(localDate.getTime() / 1000);
}

function parseMentionTargets(value, fieldName) {
    if (!value?.trim()) return [];
    const tokens = value.trim().split(/[\s,，]+/).filter(Boolean);
    const targets = tokens.map(token => {
        const user = token.match(/^<@!?(\d{17,20})>$/);
        if (user) return { type: 'user', id: user[1] };
        const role = token.match(/^<@&(\d{17,20})>$/);
        if (role) return { type: 'role', id: role[1] };
        throw new Error(`${fieldName}僅接受 @用戶 或 @身分組，不接受純數字 ID。`);
    });
    return [...new Map(targets.map(target => [`${target.type}:${target.id}`, target])).values()];
}

async function fetchSourceMessage(interaction, input) {
    const link = String(input).trim().match(MESSAGE_LINK);
    if (link) {
        const [, guildID, channelID, messageID] = link;
        if (guildID !== interaction.guildId) throw new Error('來源訊息連結必須屬於目前伺服器。');
        const channel = await interaction.guild.channels.fetch(channelID).catch(() => null);
        if (!channel?.messages) throw new Error('無法讀取來源訊息所在頻道。');
        return channel.messages.fetch(messageID);
    }
    if (!/^\d{17,20}$/.test(String(input).trim())) throw new Error('請輸入有效的 Discord 訊息 ID 或訊息連結。');
    if (!interaction.channel?.messages) throw new Error('目前頻道不支援讀取訊息。');
    return interaction.channel.messages.fetch(String(input).trim());
}

async function resolveMentionedUsers(interaction, targets, fieldName) {
    if (!targets.length) return [];
    const userIDs = new Set();
    if (targets.some(target => target.type === 'role')) {
        await withTimeout(
            interaction.guild.members.fetch(),
            `展開${fieldName}身分組逾時。請確認 Discord Developer Portal 已啟用 Server Members Intent。`
        );
    }
    for (const target of targets) {
        if (target.type === 'user') {
            const member = interaction.guild.members.cache.get(target.id) || await withTimeout(
                interaction.guild.members.fetch(target.id).catch(() => null),
                `查詢${fieldName}用戶逾時。`
            );
            if (!member || member.user.bot) throw new Error(`${fieldName}包含不在伺服器中的用戶或 Bot。`);
            userIDs.add(member.id);
            continue;
        }
        const role = interaction.guild.roles.cache.get(target.id);
        if (!role) throw new Error(`${fieldName}包含不存在的身分組。`);
        for (const member of role.members.values()) {
            if (!member.user.bot) userIDs.add(member.id);
        }
    }
    return [...userIDs];
}

module.exports = {
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

    async execute(interaction) {
        if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
            return errorReply(interaction, '**此指令僅限伺服器管理員使用。**', [], true);
        }
        await interaction.deferReply({ ephemeral: true });
        sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：${getAdminCommandPath('抽選系統')}`);
        try {
            const source = await fetchSourceMessage(interaction, interaction.options.getString('訊息id或連結', true));
            if (!source.content.trim()) return errorReply(interaction, '**來源訊息沒有可作為介紹的文字內容。**');
            if (source.content.length > 4096) return errorReply(interaction, '**來源訊息超過 Embed 介紹內文的 4096 字元上限。**');
            const channel = interaction.options.getChannel('選擇頻道', true);
            if (!channel.isTextBased() || typeof channel.send !== 'function') return errorReply(interaction, '**請選擇可發送訊息的文字頻道。**');

            const entryDeadline = parseDeadline(interaction.options.getString('截止時間', true));
            if (!entryDeadline || entryDeadline <= Math.floor(Date.now() / 1000)) {
                return errorReply(interaction, '**截止時間格式錯誤，或該時間已截止。請使用 yyyy-mm-dd hh:mm。**');
            }
            const whitelistTargets = parseMentionTargets(interaction.options.getString('白名單'), '白名單');
            const blacklistTargets = parseMentionTargets(interaction.options.getString('黑名單'), '黑名單');
            const whitelistUserIDs = await resolveMentionedUsers(interaction, whitelistTargets, '白名單');
            const blacklistUserIDs = await resolveMentionedUsers(interaction, blacklistTargets, '黑名單');
            const conflicts = whitelistUserIDs.filter(id => blacklistUserIDs.includes(id));
            if (conflicts.length) return errorReply(interaction, `**白名單與黑名單包含相同用戶：${conflicts.map(id => `<@${id}>`).join('、')}**`);
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
            return errorReply(interaction, `**${error.message || '無法建立抽選，請稍後再試。'}**`);
        }
    },

    publicButtonHandlers: {
        raffle_join: async interaction => {
            const raffleID = interaction.customId.split(':')[1];
            if (interaction.user.bot) return errorReply(interaction, '**Bot 無法參加抽選。**', [], true);
            const raffle = getRaffle(interaction.guildId, raffleID);
            if (!raffle) return errorReply(interaction, '**找不到這筆抽選。**', [], true);
            if (raffle.status !== 'open' || Math.floor(Date.now() / 1000) >= raffle.entryDeadline) return errorReply(interaction, '**這筆抽選已截止。**', [], true);
            const whitelist = raffle.whitelistUserIDs || raffle.qualifiedUserIDs || [];
            const blacklist = raffle.blacklistUserIDs || [];
            if (whitelist.includes(interaction.user.id)) return infoReply(interaction, '**您在本次抽選的白名單中，無須參與抽選。**', [], true);
            if (blacklist.includes(interaction.user.id)) return errorReply(interaction, '**您在本次抽選的黑名單中，不可參與抽選。**', [], true);
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
            if (!joined && !cancelled) return errorReply(interaction, '**這筆抽選剛剛截止。**', [], true);
            const updated = getRaffle(interaction.guildId, raffleID);
            try {
                await interaction.message.edit({ embeds: [createRaffleEmbed(updated)], components: participationRow(updated) });
            } catch (error) {
                sendLog(interaction.client, `❌ 更新抽選 ${raffleID} 登記名單時發生錯誤：`, 'ERROR', error);
            }
            return infoReply(interaction, cancelled ? '**已取消抽選登記。**' : '**已成功登記抽選！**', [], true);
        }
    }
};

module.exports._test = { parseDeadline, parseMentionTargets };
