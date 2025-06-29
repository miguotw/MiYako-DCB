const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { QueryType, useMainPlayer } = require('discord-player');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('音樂')
        .setDescription('音樂相關指令')
        .addSubcommand(subcommand =>
            subcommand
                .setName('播放')
                .setDescription('播放音樂')
                .addStringOption(option =>
                    option
                        .setName('連結')
                        .setDescription('您想播放的音樂連結或關鍵字')
                        .setRequired(true)
                )
        ),

    async execute(interaction) {
        try {
            const subcommand = interaction.options.getSubcommand();
            if (subcommand !== '播放') return;

            await interaction.deferReply({ ephemeral: false });

            const player = useMainPlayer();
            const song = interaction.options.getString('連結');
            const res = await player.search(song, {
                requestedBy: interaction.member,
                searchEngine: QueryType.AUTO
            });

            let defaultEmbed = new EmbedBuilder().setColor('#2f3136');

            if (!res?.tracks.length) {
                defaultEmbed.setAuthor({ name: '沒有找到結果... 再試一次？ <❌>' });
                return interaction.editReply({ embeds: [defaultEmbed] });
            }

            try {
                const { track } = await player.play(interaction.member.voice.channel, song, {
                    nodeOptions: {
                        metadata: {
                            channel: interaction.channel
                        },
                        volume: 50,
                        leaveOnEmpty: true,
                        leaveOnEmptyCooldown: 300000,
                        leaveOnEnd: true,
                        leaveOnEndCooldown: 300000,
                    }
                });

                defaultEmbed.setAuthor({ name: `載入 <${track.title}> 到佇列中... <✅>` });
                await interaction.editReply({ embeds: [defaultEmbed], ephemeral: false });
            } catch (error) {
                console.log(`Play error: ${error}`);
                defaultEmbed.setAuthor({ name: '我無法加入語音頻道... 再試一次？ <❌>' });
                return interaction.editReply({ embeds: [defaultEmbed] });
            }
        } catch (error) {
            console.log(`音樂播放指令錯誤: ${error}`);
            const errorEmbed = new EmbedBuilder()
                .setColor('#ff0000')
                .setAuthor({ name: `執行音樂播放時發生錯誤：${error.message || '未知錯誤'}` });
            return interaction.editReply({ embeds: [errorEmbed] });
        }
    }
};