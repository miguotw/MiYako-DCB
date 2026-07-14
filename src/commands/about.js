const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { createLogTools } = require('../../core/sendLog');
const { createReplyTools } = require('../../core/Reply');

// 導入設定檔內容
function createCommand(config) {
const { sendLog } = createLogTools(config);
const { errorReply } = createReplyTools(config);
const configCommands = config.commands;
const EMBED_COLOR = config.embed.color.default;
const EMBED_EMOJI = configCommands.about.emoji;
const BOTNICKNAME = configCommands.about.botNickname;
const INTRODUCE = configCommands.about.introduce;
const PROVIDER = configCommands.about.provider;
const REPOSITORY = configCommands.about.repository;

const command = {
    data: new SlashCommandBuilder()
        .setName(`關於${BOTNICKNAME}`)
        .setDescription('查詢機器人的相關資訊與介紹')
        .addBooleanOption(option =>
            option.setName('顯示伺服器唯一編號')
                    .setDescription('選擇顯示伺服器 ID')
                    .setRequired(false)), // 讓顯示伺服器 ID 成為可選項

    async execute(interaction, context) {

        //啟用延遲回覆
        await interaction.deferReply({ ephemeral: false });

        try {
            // 獲取用戶選擇是否顯示伺服器 ID
            const showServerID = interaction.options.getBoolean('顯示伺服器唯一編號') || false;
            
            // 發送執行指令的摘要到 sendLog
            sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：/關於${BOTNICKNAME} 顯示伺服器唯一編號(${showServerID ? '是' : '否'})`, "INFO");

            // 獲取機器人的相關資訊
            const botUser = interaction.client.user;
            const botUsername = botUser.username;
            const botAvatar = botUser.displayAvatarURL({ format: 'png', dynamic: true, size: 1024 });
            const guilds = interaction.client.guilds.cache;

            // 獲取目前擁有的指令列表
            const commandNames = context?.router?.commandNames || [];
            const commandCount = commandNames.length;
            const commands = commandNames.map(name => `\`${name}\``).join(' | ');

            // 計算所有伺服器的成員總數
            let totalMembers = 0;
            guilds.forEach(guild => {
                totalMembers += guild.memberCount;
            });

            // 根據用戶選擇格式化伺服器列表
            const guildList = guilds.map(guild => {
                return showServerID ? `- ${guild.name}（ID: ${guild.id}）` : `- ${guild.name}`;
            }).join('\n');

            // 創建嵌入訊息
            const embed = new EmbedBuilder()
                .setColor(EMBED_COLOR)
                .setTitle(`${EMBED_EMOJI} ┃ 關於${botUsername}`)
                .setThumbnail(botAvatar)
                .setDescription(INTRODUCE)
                .addFields(
                    { name: '服務提供者', value: `<@${PROVIDER}>`, inline: true },
                    { name: 'GitHub 儲存庫', value: `[前往 GitHub 儲存庫](${REPOSITORY})`, inline: true },
                    { name: `共有 ${commandCount} 條指令`, value: commands || '無', inline: false },
                    { name: `在 ${guilds.size.toString()} 個伺服器服務 ${totalMembers.toString()} 位成員`, value: guildList || '無', inline: false }
                );

                await interaction.editReply({ embeds: [embed], ephemeral: false });

        } catch (error) {
            // 錯誤處理
            return errorReply(interaction, error, { context: '執行關於指令' });
        }
    }
};
return command;
}

module.exports = { createCommand };
