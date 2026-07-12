const path = require('path');
const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { readGuildStore, writeGuildStore } = require(path.join(process.cwd(), 'util/twitchStreamStore'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));

function normalizeTwitchLogin(value) {
    return String(value || '').trim().replace(/^https?:\/\/(?:www\.)?twitch\.tv\//i, '').split(/[/?#]/)[0].toLowerCase();
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('直播通知')
        .setDescription('管理 Twitch 直播通知')
        .setDMPermission(false)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(subcommand => subcommand
            .setName('新增')
            .setDescription('新增或更新 Twitch 直播通知')
            .addStringOption(option => option
                .setName('twitch頻道id')
                .setDescription('Twitch 頻道登入名稱或網址')
                .setRequired(true))
            .addChannelOption(option => option
                .setName('通知頻道')
                .setDescription('發送直播通知的 Discord 頻道')
                .setRequired(true))
            .addRoleOption(option => option
                .setName('提及身分組')
                .setDescription('開播通知要提及的身分組；未設定時提及 @everyone')
                .setRequired(false)))
        .addSubcommand(subcommand => subcommand
            .setName('移除')
            .setDescription('移除 Twitch 直播通知')
            .addStringOption(option => option
                .setName('twitch頻道id')
                .setDescription('要停止追蹤的 Twitch 頻道登入名稱或網址')
                .setRequired(true))
            .addChannelOption(option => option
                .setName('通知頻道')
                .setDescription('只移除此通知頻道；未選擇則移除該 Twitch 頻道的全部設定')
                .setRequired(false))),

    async execute(interaction) {
        if (!interaction.inGuild() || !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: '你必須是伺服器管理員才能使用此指令。', ephemeral: true });
        }

        const twitchUserLogin = normalizeTwitchLogin(interaction.options.getString('twitch頻道id'));
        if (!/^[a-z0-9_]{1,25}$/.test(twitchUserLogin)) {
            return interaction.reply({ content: 'Twitch 頻道 ID 格式不正確。請輸入登入名稱或頻道網址。', ephemeral: true });
        }

        const store = readGuildStore(interaction.guildId);
        const subcommand = interaction.options.getSubcommand();
        const channel = interaction.options.getChannel('通知頻道');

        if (subcommand === '新增') {
            if (!channel?.isTextBased() || typeof channel.send !== 'function') {
                return interaction.reply({ content: '請選擇可以發送訊息的文字頻道。', ephemeral: true });
            }

            const role = interaction.options.getRole('提及身分組');
            const subscription = {
                twitchUserLogin,
                channelID: channel.id,
                roleID: role?.id || ''
            };
            const index = store.subscriptions.findIndex(item =>
                item.twitchUserLogin === twitchUserLogin && item.channelID === channel.id
            );
            if (index === -1) store.subscriptions.push(subscription);
            else store.subscriptions[index] = subscription;
            writeGuildStore(interaction.guildId, store);
            sendLog(interaction.client, `💾 ${interaction.user.tag} 新增 Twitch 直播通知：${twitchUserLogin} -> ${channel.id}`);
            return interaction.reply({
                content: `已設定追蹤 **${twitchUserLogin}**，通知將發送至 ${channel}${role ? `，並提及 ${role}` : '，未指定身分組時將提及 @everyone'}。`,
                ephemeral: true
            });
        }

        const originalLength = store.subscriptions.length;
        store.subscriptions = store.subscriptions.filter(item =>
            item.twitchUserLogin !== twitchUserLogin || (channel && item.channelID !== channel.id)
        );
        if (store.subscriptions.length === originalLength) {
            return interaction.reply({ content: '找不到符合的直播通知設定。', ephemeral: true });
        }

        store.notifications = store.notifications.filter(item =>
            item.twitchUserLogin !== twitchUserLogin || (channel && item.channelID !== channel.id)
        );
        writeGuildStore(interaction.guildId, store);
        sendLog(interaction.client, `💾 ${interaction.user.tag} 移除 Twitch 直播通知：${twitchUserLogin}${channel ? ` -> ${channel.id}` : ''}`);
        return interaction.reply({
            content: `已移除 **${twitchUserLogin}**${channel ? ` 在 ${channel} 的` : '全部'}直播通知設定。`,
            ephemeral: true
        });
    }
};
