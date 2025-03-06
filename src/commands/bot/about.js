const path = require('path');
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { config } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/log'));
const { errorReply } = require(path.join(process.cwd(), 'core/error_reply'));

// 導入設定檔內容
const EMBED_COLOR = config.Embed_Color;
const EMBED_EMOJI = config.Emoji.Commands.About;
const BOTNICKNAME = config.About.Bot_Nicdname;
const INTRODUCE = config.About.Introduce;
const PROVIDER = config.About.Provider;
const REPOSITORY = config.About.Repository;

module.exports = {
    data: new SlashCommandBuilder()
        .setName(`關於${BOTNICKNAME}`)
        .setDescription('查詢機器人的相關資訊與介紹')
        .addBooleanOption(option =>
            option.setName('顯示伺服器唯一編號')
                  .setDescription('選擇顯示伺服器 ID')
                  .setRequired(false)), // 讓顯示伺服器 ID 成為可選項

    async execute(interaction) {
        try {
            // 獲取用戶選擇是否顯示伺服器 ID
            const showServerID = interaction.options.getBoolean('顯示伺服器唯一編號') || false;
            
            // 發送執行指令的摘要到 sendLog
            sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：/關於${BOTNICKNAME} 顯示伺服器唯一編號(${showServerID ? '是' : '否'})`, "INFO");

            // 獲取機器人的相關資訊
            const botUser = interaction.client.user;
            const botUsername = botUser.username;
            const botAvatar = botUser.displayAvatarURL({ format: 'png', dynamic: true, size: 1024 });
            const botID = botUser.id;
            const guilds = interaction.client.guilds.cache;

            // 獲取目前擁有的指令列表
            const commandCount = interaction.client.commands.size;
            const commands = interaction.client.commands.map(command => `\`${command.data.name}\``).join(' | ');

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

            await interaction.reply({ embeds: [embed] });

        } catch (error) {
            // 錯誤處理
            sendLog(interaction.client, `❌ 在執行 /關於我 指令時發生錯誤`, "ERROR", error); // 記錄錯誤日誌
            errorReply(interaction, '**發生未預期的錯誤，請向開發者回報！**'); // 向用戶顯示錯誤訊息
        }
    }
};