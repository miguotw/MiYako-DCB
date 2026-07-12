const path = require('path');
const { ActionRowBuilder, PermissionFlagsBits, SlashCommandBuilder, StringSelectMenuBuilder } = require('discord.js');
const { readGuildStore, writeGuildStore } = require(path.join(process.cwd(), 'util/twitchStreamStore'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));

function normalizeTwitchLogin(value) {
    return String(value || '').trim().replace(/^https?:\/\/(?:www\.)?twitch\.tv\//i, '').split(/[/?#]/)[0].toLowerCase();
}

async function handleRemoveSelected(interaction) {
    if (!interaction.inGuild() || !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: '你必須是伺服器管理員才能使用此選單。', ephemeral: true });
    }

    const [, ownerID] = interaction.customId.split(':');
    if (ownerID !== interaction.user.id) {
        return interaction.reply({ content: '這不是你建立的移除選單。', ephemeral: true });
    }

    const twitchUserLogin = normalizeTwitchLogin(interaction.values[0]);
    const store = readGuildStore(interaction.guildId);
    const originalLength = store.subscriptions.length;
    store.subscriptions = store.subscriptions.filter(item => item.twitchUserLogin !== twitchUserLogin);

    if (store.subscriptions.length === originalLength) {
        return interaction.update({ content: '這個 Twitch 頻道已不在追蹤清單中。', components: [] });
    }

    store.notifications = store.notifications.filter(item => item.twitchUserLogin !== twitchUserLogin);
    writeGuildStore(interaction.guildId, store);
    sendLog(interaction.client, `💾 ${interaction.user.tag} 移除 Twitch 直播通知：${twitchUserLogin}（所有設定）`);
    return interaction.update({ content: `已移除 **${twitchUserLogin}** 在此伺服器的所有直播通知設定。`, components: [] });
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
            .setDescription('從選單移除已追蹤的 Twitch 頻道')),

    async execute(interaction) {
        if (!interaction.inGuild() || !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: '你必須是伺服器管理員才能使用此指令。', ephemeral: true });
        }

        const store = readGuildStore(interaction.guildId);
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === '移除') {
            const trackedChannels = [...new Set(store.subscriptions.map(item => normalizeTwitchLogin(item.twitchUserLogin)).filter(Boolean))];
            if (!trackedChannels.length) {
                return interaction.reply({ content: '此伺服器目前沒有已建立的 Twitch 追蹤頻道。', ephemeral: true });
            }

            const menu = new StringSelectMenuBuilder()
                .setCustomId(`twitch_stream_remove:${interaction.user.id}`)
                .setPlaceholder('選擇要移除的 Twitch 頻道')
                .addOptions(trackedChannels.slice(0, 25).map(login => {
                    const targetCount = store.subscriptions.filter(item => item.twitchUserLogin === login).length;
                    return {
                        label: login,
                        value: login,
                        description: `移除全部 ${targetCount} 個通知目標`
                    };
                }));

            return interaction.reply({
                content: trackedChannels.length > 25
                    ? '請選擇要移除的 Twitch 頻道（選單最多顯示前 25 個）。'
                    : '請選擇要移除的 Twitch 頻道。',
                components: [new ActionRowBuilder().addComponents(menu)],
                ephemeral: true
            });
        }

        const twitchUserLogin = normalizeTwitchLogin(interaction.options.getString('twitch頻道id'));
        if (!/^[a-z0-9_]{1,25}$/.test(twitchUserLogin)) {
            return interaction.reply({ content: 'Twitch 頻道 ID 格式不正確。請輸入登入名稱或頻道網址。', ephemeral: true });
        }

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
            await interaction.reply({
                content: `已設定追蹤 **${twitchUserLogin}**，通知將發送至 ${channel}${role ? `，並提及 ${role}` : '，未指定身分組時將提及 @everyone'}。`,
                ephemeral: true
            });
            interaction.client.checkTwitchStreamStatus?.().catch(error => {
                sendLog(interaction.client, '❌ 新增設定後立即檢查 Twitch 直播狀態時發生錯誤：', 'ERROR', error);
            });
            return;
        }

    },

    componentHandlers: {
        twitch_stream_remove: handleRemoveSelected
    }
};
