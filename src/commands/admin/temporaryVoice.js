const path = require('path');
const {
    ChannelType,
    PermissionFlagsBits,
    SlashCommandBuilder
} = require('discord.js');
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));
const { errorReply, infoReply } = require(path.join(process.cwd(), 'core/Reply'));
const {
    loadGuildStore,
    removeEntrance,
    setEntrance
} = require(path.join(process.cwd(), 'util/temporaryVoiceStore'));

const REQUIRED_BOT_PERMISSIONS = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.MoveMembers
];

module.exports = {
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

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const subcommand = interaction.options.getSubcommand();
        const channel = interaction.options.getChannel('語音頻道', true);
        sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：/管理 臨時語音頻道 ${subcommand} 語音頻道(${channel.id})`);

        try {
            if (channel.guildId !== interaction.guildId || channel.type !== ChannelType.GuildVoice) {
                return errorReply(interaction, '**請選擇目前伺服器中的語音頻道！**');
            }

            if (subcommand === '移除') {
                const store = loadGuildStore(interaction.guildId);
                if (!store.entrances[channel.id]) {
                    return errorReply(interaction, '**這個語音頻道不是已設定的臨時語音入口！**');
                }

                removeEntrance(interaction.guildId, channel.id);
                return infoReply(interaction, `**已移除入口 ${channel}。既有臨時頻道仍會在空置逾時後自動刪除。**`);
            }

            const botMember = interaction.guild.members.me;
            const missingPermissions = channel.permissionsFor(botMember)?.missing(REQUIRED_BOT_PERMISSIONS) || REQUIRED_BOT_PERMISSIONS;
            if (missingPermissions.length > 0) {
                return errorReply(interaction, `**機器人在該頻道缺少必要權限：${missingPermissions.join('、')}**`);
            }

            const wasConfigured = Boolean(loadGuildStore(interaction.guildId).entrances[channel.id]);
            const prefix = interaction.options.getString('前綴')?.trim() || '';
            setEntrance(interaction.guildId, channel.id, prefix);
            return infoReply(
                interaction,
                `**已${wasConfigured ? '更新' : '新增'}入口 ${channel}${prefix ? `，前綴為「${prefix}」` : '，不使用前綴'}。**`
            );
        } catch (error) {
            sendLog(interaction.client, '❌ 管理臨時語音頻道入口時發生錯誤：', 'ERROR', error);
            return errorReply(interaction, '**無法儲存臨時語音頻道設定，請稍後再試。**');
        }
    }
};
