const path = require('path');
const { ActionRowBuilder, SlashCommandBuilder, StringSelectMenuBuilder } = require('discord.js');
const { createTwitchStreamRepository } = require('../../../util/twitchStreamRepository');
const { createCommandPolicy } = require('../../../core/commandPolicy');
const { createLogTools } = require('../../../core/sendLog');
const { createReplyTools } = require('../../../core/Reply');

function createCommand(config, {
    requestTwitchCheck = async () => {},
    reconcileRemovedSubscription = async () => {}
} = {}) {
const { getAdminCommandPath } = createCommandPolicy(config);
const { sendLog } = createLogTools(config);
const { infoReply, validationReply } = createReplyTools(config);
const repositories = new WeakMap();

function repository(context) {
    const json = context?.store?.twitchStream;
    if (!json) throw new Error('Twitch 功能缺少 twitchStream repository context。');
    if (!repositories.has(json)) repositories.set(json, createTwitchStreamRepository(json));
    return repositories.get(json);
}

function normalizeTwitchLogin(value) {
    return String(value || '').trim().replace(/^https?:\/\/(?:www\.)?twitch\.tv\//i, '').split(/[/?#]/)[0].toLowerCase();
}

async function handleRemoveSelected(interaction, context) {
    const [, ownerID] = interaction.customId.split(':');
    if (ownerID !== interaction.user.id) {
        return validationReply(interaction, '這不是你建立的移除選單。', { ephemeral: true });
    }

    const twitchUserLogin = normalizeTwitchLogin(interaction.values[0]);
    const removed = await repository(context).removeSubscription(interaction.guildId, twitchUserLogin);
    if (!removed.found) {
        return validationReply(interaction, '這個 Twitch 頻道已不在追蹤清單中。', {
            method: 'update', content: null, components: []
        });
    }

    await reconcileRemovedSubscription(interaction.client, interaction.guildId, twitchUserLogin, removed.notifications);
    sendLog(interaction.client, `💾 ${interaction.user.tag} 移除 Twitch 直播通知：${twitchUserLogin}（所有設定）`);
    return infoReply(interaction, `已移除 **${twitchUserLogin}** 在此伺服器的所有直播通知設定。`, {
        method: 'update', content: null, components: []
    });
}

const command = {
    data: new SlashCommandBuilder()
        .setName('直播通知')
        .setDescription('管理 Twitch 直播通知')
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
                .setDescription('開播通知要提及的身分組；未設定時不提及任何人')
                .setRequired(false)))
        .addSubcommand(subcommand => subcommand
            .setName('移除')
            .setDescription('從選單移除已追蹤的 Twitch 頻道')),

    async execute(interaction, context) {
        const store = await repository(context).readGuild(interaction.guildId);
        const subcommand = interaction.options.getSubcommand();
        const commandPath = getAdminCommandPath('直播通知', subcommand);

        if (subcommand === '移除') {
            sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：${commandPath}`, 'INFO');
            const trackedChannels = [...new Set(store.subscriptions.map(item => normalizeTwitchLogin(item.twitchUserLogin)).filter(Boolean))];
            if (!trackedChannels.length) {
                return validationReply(interaction, '此伺服器目前沒有已建立的 Twitch 追蹤頻道。', { ephemeral: true });
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

            return infoReply(interaction, trackedChannels.length > 25
                    ? '請選擇要移除的 Twitch 頻道（選單最多顯示前 25 個）。'
                    : '請選擇要移除的 Twitch 頻道。', {
                components: [new ActionRowBuilder().addComponents(menu)],
                ephemeral: true
            });
        }

        const twitchUserLogin = normalizeTwitchLogin(interaction.options.getString('twitch頻道id'));
        const channel = interaction.options.getChannel('通知頻道');
        const role = interaction.options.getRole('提及身分組');
        sendLog(
            interaction.client,
            `💾 ${interaction.user.tag} 執行了指令：${commandPath} twitch頻道id(${twitchUserLogin}) 通知頻道(${channel}) 提及身分組(${role || '未指定'})`,
            'INFO'
        );

        if (!/^[a-z0-9_]{1,25}$/.test(twitchUserLogin)) {
            return validationReply(interaction, 'twitch頻道id 格式不正確。請輸入登入名稱或頻道網址。', { ephemeral: true });
        }

        if (subcommand === '新增') {
            if (!channel?.isTextBased() || typeof channel.send !== 'function') {
                return validationReply(interaction, '請選擇可以發送訊息的文字頻道。', { ephemeral: true });
            }

            const subscription = {
                twitchUserLogin,
                channelID: channel.id,
                roleID: role?.id || ''
            };
            const isOverwrite = store.subscriptions.some(item => item.twitchUserLogin === twitchUserLogin);
            store.subscriptions = store.subscriptions.filter(item => item.twitchUserLogin !== twitchUserLogin);
            store.subscriptions.push(subscription);
            store.notifications = store.notifications.filter(item =>
                item.twitchUserLogin !== twitchUserLogin || item.channelID === channel.id
            );
            await repository(context).writeGuild(interaction.guildId, store);
            await infoReply(interaction, `已${isOverwrite ? '覆寫' : '新增'}追蹤 **${twitchUserLogin}**，通知將發送至 ${channel}${role ? `，並提及 ${role}` : '，且不提及任何人'}。`, {
                ephemeral: true
            });
            requestTwitchCheck().catch(error => {
                sendLog(interaction.client, '❌ 新增設定後立即檢查 Twitch 直播狀態時發生錯誤：', 'ERROR', error);
            });
            return;
        }

    },

    componentHandlers: {
        twitch_stream_remove: handleRemoveSelected
    }
};
return command;
}

module.exports = { createCommand };
