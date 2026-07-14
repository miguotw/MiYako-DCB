const {
    ChannelType,
    PermissionFlagsBits,
    SlashCommandBuilder
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
                .setDescription('移除臨時語音頻道入口')
                .addChannelOption(option =>
                    option
                        .setName('語音頻道')
                        .setDescription('選擇要移除的入口語音頻道')
                        .addChannelTypes(ChannelType.GuildVoice)
                        .setRequired(true))),

    async execute(interaction, context) {
        await interaction.deferReply({ ephemeral: true });

        const subcommand = interaction.options.getSubcommand();
        const channel = interaction.options.getChannel('語音頻道', true);
        sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：${getAdminCommandPath('臨時語音頻道', subcommand)} 語音頻道(${channel.id})`);

        try {
            if (channel.guildId !== interaction.guildId || channel.type !== ChannelType.GuildVoice) {
                return validationReply(interaction, '**請選擇目前伺服器中的語音頻道！**');
            }

            if (subcommand === '移除') {
                const store = await repository(context).readGuild(interaction.guildId);
                if (!store.entrances[channel.id]) {
                    return validationReply(interaction, '**這個語音頻道不是已設定的臨時語音入口！**');
                }

                await repository(context).removeEntrance(interaction.guildId, channel.id);
                return infoReply(interaction, `**已移除入口 ${channel}。既有臨時頻道仍會在空置逾時後自動刪除。**`);
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
            sendLog(interaction.client, '❌ 管理臨時語音頻道入口時發生錯誤：', 'ERROR', error);
            return errorReply(interaction, error, { context: '儲存臨時語音頻道設定' });
        }
    }
};
return command;
}

module.exports = { createCommand };
