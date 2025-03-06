const path = require('path');
const axios = require('axios');
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { config } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));
const { errorReply } = require(path.join(process.cwd(), 'core/errorReply'));
const { getPlayerSkin, getPlayerAvatar, getPlayerSkinDownload, getServerStatus, getServerIcon } = require(path.join(process.cwd(), 'util/getMinecraftInfo'));

// 導入設定檔內容
const EMBED_COLOR = config.Embed_Color;
const EMBED_EMOJI = config.Emoji.Commands.Minecraft;
const DEFAULT_SERVERS = config.Commands.Minecraft;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('麥塊')
        .setDescription('麥塊相關的輔助功能')
        .addSubcommand(subcommand => 
            subcommand
                .setName('玩家外觀資訊')
                .setDescription('查詢 Minecraft 玩家的外觀資訊')
                .addStringOption(option => 
                    option.setName('玩家名稱')
                          .setDescription('要查詢的玩家名稱')
                          .setRequired(true)))
            .addSubcommand(subcommand => 
            subcommand
                .setName('伺服器狀態資訊')
                .setDescription('查詢 Minecraft 伺服器狀態資訊')
                .addStringOption(option => 
                    option.setName('選擇預設伺服器')
                          .setDescription('從預設列表中選擇伺服器')
                          .setRequired(false)
                          .addChoices(
                              // 動態添加預設伺服器選項
                              ...Object.entries(DEFAULT_SERVERS).map(([name, ip]) => ({
                                  name: name,
                                  value: ip
                              }))
                          ))
                .addStringOption(option => 
                    option.setName('輸入伺服器位址')
                          .setDescription('手動輸入伺服器 IP 位址')
                          .setRequired(false))),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        //啟用延遲回覆
        await interaction.deferReply();

        if (subcommand === '玩家外觀資訊') {
            try {
                const playerName = interaction.options.getString('玩家名稱');

                // 發送執行指令的摘要到 sendLog
                sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：/麥塊 外觀(${playerName})`, "INFO");

                const Starlight_Skin = `https://starlightskins.lunareclipse.studio/render/default/${playerName}/full`;
                const Minotar_Avatar = `https://minotar.net/avatar/${playerName}/64.png`;
                const Minotar_Download = `https://minotar.net/download/${playerName}`;
            
                // 創建嵌入訊息
                const embed = new EmbedBuilder()
                    .setColor(EMBED_COLOR)
                    .setTitle(`${EMBED_EMOJI} ┃ 玩家外觀 - ${playerName}`)
                    .setThumbnail(Minotar_Avatar)
                    .setImage(Starlight_Skin)
                    .setFooter({ text: '使用 Minotar 與 StarLight Skins API' });

                // 創建下載按鈕
                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setLabel(`下載 ${playerName} 的外觀`)
                            .setStyle(ButtonStyle.Link)
                            .setURL(Minotar_Download)
                    );

                await interaction.editReply({ embeds: [embed], components: [row] });

            } catch (error) {
                // 錯誤處理
                sendLog(interaction.client, `❌ 在執行 /麥塊 外觀 指令時發生錯誤`, "ERROR", error); // 記錄錯誤日誌
                errorReply(interaction, '**發生未預期的錯誤，請向開發者回報！**'); // 向用戶顯示錯誤訊息
            };
            
        } else if (subcommand === '伺服器狀態資訊') {
            try {
                // 優先使用「選擇預設伺服器」，若未選擇則使用「輸入伺服器位址」
                const serverIP = interaction.options.getString('選擇預設伺服器') || interaction.options.getString('輸入伺服器位址');
        
                // 沒有填入必要參數時的回應
                if (!serverIP) {
                    return errorReply(interaction, '**請選擇預設伺服器或手動輸入伺服器 IP 位址！**');
                }
        
                // 發送執行指令的摘要到 sendLog
                sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：/麥塊 伺服器位址(${serverIP})`, "INFO");
                
                // 使用 mcstatus.io API 獲取伺服器狀態
                const { ServerStatusMOTD, ServerStatusPlayersOnline, ServerStatusPlayersMax, ServerStatusVersionName, ServerStatusVersionProtocol, ServerStatusPlayersList, ServerStatusIP } = await getServerStatus(serverIP);
        
                // 取得伺服器圖標
                const serverIcon = `https://api.mcstatus.io/v2/icon/${serverIP}`;
        
                // 創建嵌入訊息
                const embed = new EmbedBuilder()
                    .setColor(EMBED_COLOR)
                    .setTitle(`${EMBED_EMOJI} ┃ 伺服器狀態 - ${serverIP}`)
                    .setDescription(ServerStatusMOTD)
                    .setThumbnail(serverIcon)
                    .addFields(
                        { name: '玩家在線', value: `${ServerStatusPlayersOnline} / ${ServerStatusPlayersMax}`, inline: true },
                        { name: '遊戲版本', value: ServerStatusVersionName, inline: true },
                        { name: '協定版本', value: ServerStatusVersionProtocol, inline: true },
                        { name: '線上玩家', value: ServerStatusPlayersList, inline: false },
                        { name: '真實位址', value: `||${ServerStatusIP}||`, inline: false }
                    );
        
                // 回覆訊息
                await interaction.editReply({ 
                    embeds: [embed], 
                });
            } catch (error) {
                // 如果伺服器不是 Minecraft 伺服器或無法連接
                sendLog(interaction.client, `❌ 在執行 /麥塊 伺服器狀態資訊 指令時發生錯誤：`, "ERROR", error); // 記錄錯誤日誌
                errorReply(interaction, `**無法連接到伺服器，原因：${error.message || '未知錯誤'}**`); // 向用戶顯示錯誤訊息
            }
        }
    }
};