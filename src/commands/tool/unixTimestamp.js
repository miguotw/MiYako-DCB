const path = require('path');
const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, ModalBuilder, TextInputBuilder, ActionRowBuilder, TextInputStyle } = require('discord.js');
const { config, configCommands } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));
const { errorReply, infoReply } = require(path.join(process.cwd(), 'core/Reply'));

// 導入設定檔內容
const EMBED_COLOR = config.embed.color.default;
const EMBED_EMOJI = configCommands.unixTimestamp.emoji;
const TIMEZONE = config.log.timezone;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('時間戳')
        .setDescription('時間戳相關的輔助功能')
        .addSubcommand(subcommand =>
            subcommand
                .setName('現在時間')
                .setDescription('取得目前的 UNIX 時間戳'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('指定時間')
                .setDescription('取得指定的 UNIX 時間戳')),

async execute(interaction) {
    try {
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === '現在時間') {
            // 停用延遲回覆
            await interaction.deferReply({ ephemeral: false });

            const now = new Date();
            const timestampSeconds = Math.floor(now.getTime() / 1000);

            const embed = new EmbedBuilder()
                .setColor(EMBED_COLOR)
                .setTitle(`${EMBED_EMOJI} ┃ 時間戳 - 現在時間`)
                .setDescription(`<t:${timestampSeconds}>`)
                .addFields({
                    name: '桌面端可直接從下方複製語法',
                    value: `\`\`\`\n<t:${timestampSeconds}>\n\`\`\``,
                    inline: false
                });

            sendLog(interaction.client, `🕒 ${interaction.user.tag} 執行了指令：/時間戳 現在時間`, "INFO");
            await interaction.editReply({ embeds: [embed] });
        }

        else if (subcommand === '指定時間') {
            const modal = new ModalBuilder()
                .setCustomId('unixTimestamp_modal')
                .setTitle('輸入指定時間');

            const dateInput = new TextInputBuilder()
                .setCustomId('dateInput')
                .setLabel('日期 (YYYY-MM-DD)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('例如：2020-03-24')
                .setRequired(true)
                .setMaxLength(10);

            const timeInput = new TextInputBuilder()
                .setCustomId('timeInput')
                .setLabel('時間 (HH:MM:SS)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('例如：23:59:59')
                .setRequired(true)
                .setMaxLength(8);

            const timezoneInput = new TextInputBuilder()
                .setCustomId('timezoneInput')
                .setLabel(`您的時區 (UTC±X，不填則預設為 ${TIMEZONE})`)
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('例如：+8')
                .setRequired(false)
                .setMaxLength(3);

            const firstRow = new ActionRowBuilder().addComponents(dateInput);
            const secondRow = new ActionRowBuilder().addComponents(timeInput);
            const thirdRow = new ActionRowBuilder().addComponents(timezoneInput);

            modal.addComponents(firstRow, secondRow, thirdRow);

            sendLog(interaction.client, `🕒 ${interaction.user.tag} 執行了指令：/時間戳 指定時間`, "INFO");
            await interaction.showModal(modal);
        }

        } catch (error) {
            sendLog(interaction.client, `❌ 在執行 /時間戳 指令時發生錯誤：`, "ERROR", error);
            errorReply(interaction, `**無法執行時間戳指令，原因：${error.message || '未知錯誤'}**`);
        }
    }
};

// 處理 Modal 提交的函式
module.exports.modalSubmitHandlers = {
    unixTimestamp_modal: async (interaction) => {
        try {
            const date = interaction.fields.getTextInputValue('dateInput');
            const time = interaction.fields.getTextInputValue('timeInput');
            const timezoneInput = interaction.fields.getTextInputValue('timezoneInput') || TIMEZONE;
            
            // 驗證日期格式 YYYY-MM-DD
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                return errorReply(interaction, '**日期格式錯誤，請使用 YYYY-MM-DD，例如：2020-03-24**');
            }
            // 驗證時間格式 HH:MM:SS
            if (!/^\d{2}:\d{2}:\d{2}$/.test(time)) {
                return errorReply(interaction, '**時間格式錯誤，請使用 HH:MM:SS，例如：23:59:59**');
            }
            // 驗證時區格式（允許 +8、-5、8、-08、+08）
            if (timezoneInput && !/^([+-]?\d{1,2})$/.test(timezoneInput)) {
                return errorReply(interaction, '**時區格式錯誤，請輸入類似 +8、-5**');
            }

            // 檢查時區範圍（-12 ~ +14）
            const timezoneNum = parseInt(timezoneInput, 10);
            if (timezoneNum < -12 || timezoneNum > 14) {
                return errorReply(interaction, '**時區超出範圍，請輸入 -12 ~ +14 之間的數字**');
            }
            
            // 組合日期和時間
            const combined = `${date}T${time}`;

            // 處理時區字串，允許 "+8"、"-5"、"8" 這些格式
            let timezoneOffset = parseInt(timezoneInput, 10);
            if (isNaN(timezoneOffset)) timezoneOffset = parseInt(TIMEZONE, 10) || 0;

            // 將輸入時間視為該時區的本地時間，轉為 UTC timestamp
            const inputDate = new Date(combined);
            const utcTimestamp = inputDate.getTime() - (timezoneOffset * 60 * 60 * 1000);
            const timestampSeconds = Math.floor(utcTimestamp / 1000);

            const embed = new EmbedBuilder()
                .setColor(EMBED_COLOR)
                .setTitle(`${EMBED_EMOJI} ┃ 時間戳 - 指定時間`)
                .setDescription(`<t:${timestampSeconds}>`)
                .addFields({
                    name: '桌面端可直接從下方複製語法',
                    value: `\`\`\`\n<t:${timestampSeconds}>\n\`\`\``,
                    inline: false
                });

            await interaction.reply({ embeds: [embed],ephemeral: false});

        } catch (error) {
            sendLog(interaction.client, '❌ 在處理時間戳 Modal 時發生錯誤：', "ERROR", error);
            errorReply(interaction, `**無法解析時間戳：${error.message || '未知錯誤'}**`);
        }
    }
};