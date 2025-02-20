const path = require('path');
const util = require('minecraft-server-util');
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { config } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/log'));
const { errorReply } = require(path.join(process.cwd(), 'core/error_reply'));

// 導入設定檔內容
const EMBED_COLOR = config.Embed_Color;
const STARILGHT_SKIN = config.API.Minecraft.Starlight_Skin; // 皮膚 API 連結
const MINOTAR = config.API.Minecraft.Minotar; // 皮膚 API 連結
const MCARVSTAT = config.API.Minecraft.Mcsrvstat; // 伺服器圖示 API 連結

module.exports = {
    data: new SlashCommandBuilder()
        .setName('麥塊')
        .setDescription('麥塊相關的輔助功能')
        .addSubcommand(subcommand => 
            subcommand
                .setName('外觀')
                .setDescription('查詢 Minecraft 玩家的外觀')
                .addStringOption(option => 
                    option.setName('玩家名稱')
                          .setDescription('要查詢的玩家名稱')
                          .setRequired(true)))
        .addSubcommand(subcommand => 
            subcommand
                .setName('伺服器狀態')
                .setDescription('查詢 Minecraft 伺服器狀態')
                .addStringOption(option => 
                    option.setName('伺服器位址')
                          .setDescription('要查詢的伺服器 IP 位址')
                          .setRequired(true))),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === '外觀') {
            try {
                const playerName = interaction.options.getString('玩家名稱');

                // 發送執行指令的摘要到 sendLog
                sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：/麥塊 外觀(${playerName})`, "INFO");

                const Starlight_Skin = `${STARILGHT_SKIN}/render/default/${playerName}/full`;
                const Minotar_Avatar = `${MINOTAR}/avatar/${playerName}/64.png`;
                const Minotar_Download = `${MINOTAR}/download/${playerName}`;
            
                // 創建嵌入訊息
                const embed = new EmbedBuilder()
                    .setColor(EMBED_COLOR) // 設置顏色
                    .setTitle(`🧱 ┃ 玩家外觀 - ${playerName}`)  // 標題
                    .setThumbnail(Minotar_Avatar) // 設置 avatar 圖示
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

                await interaction.reply({ embeds: [embed], components: [row] });

            } catch (error) {
                // 錯誤處理
                sendLog(interaction.client, `❌ 在執行 /麥塊 外觀 指令時發生錯誤`, "ERROR", error); // 記錄錯誤日誌
                errorReply(interaction, '**發生未預期的錯誤，請向開發者回報！**'); // 向用戶顯示錯誤訊息
            };
            
        } else if (subcommand === '伺服器狀態') {
            try {
                const serverIP = interaction.options.getString('伺服器位址');

                // 發送執行指令的摘要到 sendLog
                sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：/麥塊 伺服器位址(${serverIP})`, "INFO");

                const response = await util.status(serverIP);
                const serverIcon = `${MCARVSTAT}/icon/${serverIP}`;
                const latency = response.roundTripLatency ?? '無法獲取';
                
                // 處理主機名稱
                const domainParts = serverIP.split('.');
                let secondLevelDomain;
                if (domainParts.length > 2) {
                    secondLevelDomain = domainParts.slice(-2).join('.');
                } else {
                    secondLevelDomain = serverIP;
                }
                const websiteURL = `https://www.${secondLevelDomain}`;
                
                const embed = new EmbedBuilder()
                    .setColor(EMBED_COLOR)
                    .setTitle(`🧱 ┃ 伺服器狀態 - ${serverIP}`)
                    .setDescription(response.motd.clean)
                    .setThumbnail(serverIcon) // 顯示伺服器圖示
                    .addFields(
                        { name: '玩家在線', value: `${response.players.online} / ${response.players.max}`, inline: true },
                        { name: '遊戲版本', value: response.version.name, inline: true },
                        { name: '遊戲延遲', value: `${latency}ms`, inline: true }
                    )
                    .setFooter({ text: '使用 Minecraft Server Util' });
                
                const row = new ActionRowBuilder();
                
                    row.addComponents(
                        new ButtonBuilder()
                            .setLabel('前往伺服器官網')
                            .setStyle(ButtonStyle.Link)
                            .setURL(websiteURL)
                    );
                    
                    await interaction.reply({ embeds: [embed], components: [row] });
                } catch (error) {
                    sendLog(interaction.client, `❌ 在執行 /麥塊 伺服器狀態 指令時發生錯誤`, "ERROR", error); // 記錄錯誤日誌
                    errorReply(interaction, `無法連接到伺服器 ${serverIP}，請確認 IP 是否正確。`); // 向用戶顯示錯誤訊息
                }
            
            }
        }
    };
