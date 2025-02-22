const path = require('path');
const util = require('minecraft-server-util');
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { config } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/log'));
const { errorReply } = require(path.join(process.cwd(), 'core/error_reply'));

// 導入設定檔內容
const EMBED_COLOR = config.Embed_Color;
const EMBED_EMOJI = config.Emoji.Commands.Minecraft;
const STARILGHT_SKIN = config.API.Minecraft.Starlight_Skin; // 皮膚 API 連結
const MINOTAR = config.API.Minecraft.Minotar; // 皮膚 API 連結
const MCARVSTAT = config.API.Minecraft.Mcsrvstat; // 伺服器圖示 API 連結
const DEFAULT_SERVERS = config.Commands.Minecraft;

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
                          .setRequired(false))
                .addIntegerOption(option => 
                    option.setName('端口號')
                          .setDescription('手動輸入伺服器端口號（選填）')
                          .setRequired(false)
                          .setMinValue(1)
                          .setMaxValue(65535))),

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
                    .setTitle(`${EMBED_EMOJI} ┃ 玩家外觀 - ${playerName}`)  // 標題
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
                // 優先使用「選擇預設伺服器」，若未選擇則使用「輸入伺服器位址」
                const serverIP = interaction.options.getString('選擇預設伺服器') || interaction.options.getString('輸入伺服器位址');

                if (!serverIP) {
                    return errorReply(interaction, '**請選擇預設伺服器或手動輸入伺服器 IP 位址！**');
                }

                // 獲取端口號，若未指定則使用預設值 25565
                const port = interaction.options.getInteger('端口號') || 25565;

                // 發送執行指令的摘要到 sendLog
                sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：/麥塊 伺服器位址(${serverIP}:${port})`, "INFO");

                // 驗證伺服器 IP 是否為有效的 IP 或域名
                const isValidDomain = /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/.test(serverIP); // 檢查是否為域名
                const isValidIPv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(serverIP); // 檢查是否為 IPv4
                const isValidIPv6 = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/.test(serverIP) || // 標準 IPv6
                                   /^([0-9a-fA-F]{1,4}:){1,7}:$/.test(serverIP) || // 縮寫 IPv6
                                   /^::([0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}$/.test(serverIP) || // 縮寫 IPv6
                                   /^([0-9a-fA-F]{1,4}:){1,6}:\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(serverIP); // IPv4 映射格式

                if (!isValidIPv4 && !isValidIPv6 && !isValidDomain) {
                    return errorReply(interaction, '**請輸入有效的伺服器 IP 或域名！**');
                }
                
                // 檢查是否為 Minecraft 伺服器
                try {
                    const response = await util.status(serverIP, port, { timeout: 5000 }); // 設置超時時間
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
                    
                    // 處理玩家列表
                    const players = response.players?.sample?.map(p => p.name.replace(/_/g, '\\_')) || []; // 轉義 _ 避免 Markdown 格式
                    let playersList;

                    if (players.length === 0) {
                        playersList = '無法取得線上玩家，或目前無玩家在線。';
                    } else if (players.length <= response.players.online) {
                        playersList = players.join('、') + ` …等。`;
                    } else {
                        playersList = players.join('、') + `。`;
                    }

                    const embed = new EmbedBuilder()
                        .setColor(EMBED_COLOR)
                        .setTitle(`${EMBED_EMOJI} ┃ 伺服器狀態 - ${serverIP}`)
                        .setDescription(response.motd.clean)
                        .setThumbnail(serverIcon) // 顯示伺服器圖示
                        .addFields(
                            { name: '玩家在線', value: `${response.players.online} / ${response.players.max}`, inline: true },
                            { name: '遊戲版本', value: response.version.name, inline: true },
                            { name: '遊戲延遲', value: `${latency}ms`, inline: true },
                            { name: '線上玩家', value: playersList, inline: false }
                        )
                        //.setFooter({ text: '使用 Minecraft Server Util' });
                    
                    // 僅在使用域名查詢時顯示「前往伺服器官網」按鈕
                    // let row;
                    // if (isValidDomain) {
                    //     const domainParts = serverIP.split('.');
                    //     let secondLevelDomain;
                    //     if (domainParts.length > 2) {
                    //         secondLevelDomain = domainParts.slice(-2).join('.');
                    //     } else {
                    //         secondLevelDomain = serverIP;
                    //     }
                    //     const websiteURL = `https://www.${secondLevelDomain}`;

                    //     row = new ActionRowBuilder()
                    //         .addComponents(
                    //             new ButtonBuilder()
                    //                 .setLabel('前往伺服器官網')
                    //                 .setStyle(ButtonStyle.Link)
                    //                 .setURL(websiteURL)
                    //         );
                    // }

                    // 回覆訊息
                    await interaction.reply({ 
                        embeds: [embed], 
                        // components: row ? [row] : []
                    });
                } catch (error) {
                    // 如果伺服器不是 Minecraft 伺服器或無法連接
                    sendLog(interaction.client, `❌ 無法連接到伺服器 ${serverIP}，伺服器可能離線或無法連接`, "ERROR", error); // 記錄錯誤日誌
                    errorReply(interaction, `**無法連接到伺服器 ${serverIP}，伺服器可能離線或無法連接。**`); // 向用戶顯示錯誤訊息
                }
            } catch (error) {
                sendLog(interaction.client, `❌ 在執行 /麥塊 伺服器狀態 指令時發生錯誤`, "ERROR", error); // 記錄錯誤日誌
                errorReply(interaction, `**執行指令時發生錯誤，請稍後再試！**`); // 向用戶顯示錯誤訊息
            }
        }
    }
};