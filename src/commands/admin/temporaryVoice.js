const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    EmbedBuilder,
    PermissionFlagsBits,
    SlashCommandBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder
} = require('discord.js');
const { createCommandPolicy } = require('../../../core/commandPolicy');
const { createLogTools } = require('../../../core/sendLog');
const { createReplyTools } = require('../../../core/Reply');
const { createTemporaryVoiceRepository } = require('../../../util/temporaryVoiceRepository');

const REQUIRED_BOT_PERMISSIONS = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.MoveMembers
];
const MAX_SELECT_OPTIONS = 25;

function createCommand(config) {
const { getAdminCommandPath } = createCommandPolicy(config);
const { sendLog } = createLogTools(config);
const { errorReply, infoReply, validationReply } = createReplyTools(config);
const repositories = new WeakMap();

function repository(context) {
    const json = context?.store?.temporaryVoice;
    if (!json) throw new Error('臨時語音功能缺少 temporaryVoice repository context。');
    if (!repositories.has(json)) repositories.set(json, createTemporaryVoiceRepository(json));
    return repositories.get(json);
}

function createRemoveEntrancePayload(interaction, store, requestedPage = 0) {
    const entries = Object.entries(store.entrances).map(([storedChannelID, record]) => {
        const channelID = String(record.channelID || storedChannelID);
        const channel = interaction.guild?.channels?.cache?.get(channelID);
        return { ...record, channelID, channelName: channel?.name || `未知頻道 ${channelID}` };
    }).sort((left, right) => left.channelName.localeCompare(right.channelName, 'zh-Hant'));
    const totalPages = Math.max(1, Math.ceil(entries.length / MAX_SELECT_OPTIONS));
    const page = Math.min(Math.max(Number(requestedPage) || 0, 0), totalPages - 1);
    const pageEntries = entries.slice(page * MAX_SELECT_OPTIONS, (page + 1) * MAX_SELECT_OPTIONS);
    const select = new StringSelectMenuBuilder()
        .setCustomId('temporary_voice_remove_select')
        .setPlaceholder('選擇要移除的臨時語音入口')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(pageEntries.map(entry => new StringSelectMenuOptionBuilder()
            .setLabel(entry.channelName.slice(0, 100))
            .setDescription((entry.prefix ? `前綴：${entry.prefix}` : `頻道 ID：${entry.channelID}`).slice(0, 100))
            .setValue(entry.channelID)));
    const components = [new ActionRowBuilder().addComponents(select)];
    if (totalPages > 1) {
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`temporary_voice_remove_page:${page - 1}`)
                .setLabel('上一頁')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === 0),
            new ButtonBuilder()
                .setCustomId(`temporary_voice_remove_page:${page + 1}`)
                .setLabel('下一頁')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === totalPages - 1)
        ));
    }
    return {
        embeds: [new EmbedBuilder()
            .setColor(config.embed.color.default)
            .setTitle('🔊 ┃ 移除臨時語音頻道入口')
            .setDescription(`請從下拉選單選擇一個已設定的入口。\n頁數：${page + 1} / ${totalPages}`)],
        components
    };
}

async function showRemoveEntrancePage(interaction, context) {
    try {
        const store = await repository(context).readGuild(interaction.guildId);
        if (!Object.keys(store.entrances).length) {
            return validationReply(interaction, '**目前沒有已設定的臨時語音頻道入口。**', {
                method: 'update', components: []
            });
        }
        const page = Number(interaction.customId.split(':')[1] || 0);
        return interaction.update(createRemoveEntrancePayload(interaction, store, page));
    } catch (error) {
        return errorReply(interaction, error, {
            context: '載入臨時語音頻道移除選單', method: 'update', components: []
        });
    }
}

async function removeSelectedEntrance(interaction, context) {
    try {
        const channelID = interaction.values?.[0];
        const store = await repository(context).readGuild(interaction.guildId);
        if (!channelID || !store.entrances[channelID]) {
            return validationReply(interaction, '**這個臨時語音入口已不存在，請重新執行移除指令。**', {
                method: 'update', components: []
            });
        }
        await repository(context).removeEntrance(interaction.guildId, channelID);
        sendLog(
            interaction.client,
            `💾 ${interaction.user.tag} 移除了臨時語音頻道入口：${channelID}`
        );
        return infoReply(
            interaction,
            `**已移除入口 <#${channelID}>。既有臨時頻道仍會在空置逾時後自動刪除。**`,
            { method: 'update', components: [] }
        );
    } catch (error) {
        return errorReply(interaction, error, {
            context: '移除臨時語音頻道設定', method: 'update', components: []
        });
    }
}

const command = {
    data: new SlashCommandBuilder()
        .setName('臨時語音頻道')
        .setDescription('管理自動建立的臨時語音頻道入口')
        .addSubcommand(subcommand =>
            subcommand
                .setName('新增')
                .setDescription('新增或更新臨時語音頻道入口')
                .addChannelOption(option =>
                    option
                        .setName('語音頻道')
                        .setDescription('選擇要作為入口的語音頻道')
                        .addChannelTypes(ChannelType.GuildVoice)
                        .setRequired(true))
                .addStringOption(option =>
                    option
                        .setName('前綴')
                        .setDescription('臨時頻道名稱前綴；省略會清除既有前綴')
                        .setMaxLength(100)
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('移除')
                .setDescription('從已設定清單移除臨時語音頻道入口')),

    async execute(interaction, context) {
        await interaction.deferReply({ ephemeral: true });

        const subcommand = interaction.options.getSubcommand();

        try {
            if (subcommand === '移除') {
                const store = await repository(context).readGuild(interaction.guildId);
                if (!Object.keys(store.entrances).length) {
                    return validationReply(interaction, '**目前沒有已設定的臨時語音頻道入口。**');
                }
                sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：${getAdminCommandPath('臨時語音頻道', subcommand)}`);
                return interaction.editReply(createRemoveEntrancePayload(interaction, store, 0));
            }

            const channel = interaction.options.getChannel('語音頻道', true);
            sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：${getAdminCommandPath('臨時語音頻道', subcommand)} 語音頻道(${channel.id})`);
            if (channel.guildId !== interaction.guildId || channel.type !== ChannelType.GuildVoice) {
                return validationReply(interaction, '**請選擇目前伺服器中的語音頻道！**');
            }
            const botMember = interaction.guild.members.me;
            const missingPermissions = channel.permissionsFor(botMember)?.missing(REQUIRED_BOT_PERMISSIONS) || REQUIRED_BOT_PERMISSIONS;
            if (missingPermissions.length > 0) {
                return validationReply(interaction, `**機器人在該頻道缺少必要權限：${missingPermissions.join('、')}**`);
            }

            const wasConfigured = Boolean((await repository(context).readGuild(interaction.guildId)).entrances[channel.id]);
            const prefix = interaction.options.getString('前綴')?.trim() || '';
            await repository(context).setEntrance(interaction.guildId, channel.id, prefix);
            return infoReply(
                interaction,
                `**已${wasConfigured ? '更新' : '新增'}入口 ${channel}${prefix ? `，前綴為「${prefix}」` : '，不使用前綴'}。**`
            );
        } catch (error) {
            return errorReply(interaction, error, { context: '儲存臨時語音頻道設定' });
        }
    },

    buttonHandlers: {
        temporary_voice_remove_page: showRemoveEntrancePage
    },

    componentHandlers: {
        temporary_voice_remove_select: removeSelectedEntrance
    }
};
command._test = { createRemoveEntrancePayload };
return command;
}

module.exports = { createCommand };
