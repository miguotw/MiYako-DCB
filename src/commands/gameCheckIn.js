'use strict';

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    SlashCommandBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const { createReplyTools } = require('../../core/Reply');
const { createLogTools } = require('../../core/sendLog');
const { GameCheckInAdapterError, createGameCheckInAdapters } = require('../../util/gameCheckInAdapters');
const { createGameCheckInRepository } = require('../../util/gameCheckInRepository');

const PLATFORM_NAMES = Object.freeze({ hoyolab: 'HoYoLAB', skport: 'SKPORT' });
const MODE_NAMES = Object.freeze({
    all: '啟用所有通知',
    failures: '僅失敗時通知',
    off: '停用所有通知'
});

function createCommand(config, {
    adapters = createGameCheckInAdapters(),
    repositoryFactory = createGameCheckInRepository,
    wake = () => {}
} = {}) {
    const { errorReply, validationReply } = createReplyTools(config);
    const { sendLog } = createLogTools(config);
    const repositoryCache = new WeakMap();
    const color = config.embed.color.default;
    const emoji = config.commands.gameCheckIn.emoji;

    function repository(context) {
        const json = context?.store?.gameCheckIn;
        if (!json) throw new Error('遊戲簽到功能缺少 gameCheckIn repository context。');
        if (!repositoryCache.has(json)) repositoryCache.set(json, repositoryFactory(json));
        return repositoryCache.get(json);
    }

    function createPanelEmbed() {
        return new EmbedBuilder()
            .setColor(color)
            .setTitle(`${emoji} ┃ 遊戲自動簽到`)
            .setDescription([
                '設定 HoYoLAB／SKPORT 憑證後，機器人會每日自動為已綁定的支援遊戲簽到。',
                '',
                '**支援遊戲**',
                'HoYoLAB：原神、崩壞：星穹鐵道、崩壞 3、未定事件簿、絕區零',
                'SKPORT：明日方舟（繁中服）、明日方舟：終末地',
                '',
                '憑證與個人設定只會在私密互動中處理；請勿將憑證張貼到頻道或交給他人。',
                '通知會嘗試透過 DM 傳送，請確認 Discord 允許共同伺服器成員傳送私人訊息。'
            ].join('\n'));
    }

    function createPanelRow() {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('game_checkin_credentials')
                .setLabel('輸入／更新憑證')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('game_checkin_notifications')
                .setLabel('啟用／停用通知')
                .setStyle(ButtonStyle.Secondary)
        );
    }

    function createCredentialGuide(record) {
        const status = platform => record.credentials[platform] ? '已設定' : '未設定（不自動簽到）';
        const overview = new EmbedBuilder()
            .setColor(color)
            .setTitle(`${emoji} ┃ 憑證設定`)
            .setDescription([
                `HoYoLAB：**${status('hoyolab')}**`,
                `SKPORT：**${status('skport')}**`,
                `通知：**${MODE_NAMES[record.notificationMode]}**`,
                '',
                '請先閱讀下方教學，再從選單選擇平台。Modal 留空送出會清除該平台憑證。',
                '**既有憑證不會重新顯示。**'
            ].join('\n'));
        const hoyolab = new EmbedBuilder()
            .setColor(color)
            .setTitle('HoYoLAB Cookie 取得方式')
            .setDescription([
                '1. 使用瀏覽器登入 HoYoLAB，按 F12 開啟開發者工具。',
                '2. 到 Application／儲存空間 → Cookies → `https://www.hoyolab.com`。',
                '3. 複製 Cookie 並組成完整 header；至少需包含 `ltoken_v2` 與 `ltuid_v2`。',
                '```http',
                'ltoken_v2=v2_xxxxxxxxxx; ltuid_v2=123456789;',
                '```',
                'Cookie 為 HttpOnly 時無法用 `document.cookie` 取得，請從 Cookies 表格複製。'
            ].join('\n'));
        const skport = new EmbedBuilder()
            .setColor(color)
            .setTitle('SKPORT account_token 取得方式')
            .setDescription([
                '1. 在同一瀏覽器登入 Gryphline／SKPORT。',
                '2. 開啟 https://web-api.gryphline.com/cookie_store/account_token 。',
                '3. 畫面會顯示類似以下 JSON，只複製 `data.content` 的值。',
                '```json',
                '{"code":0,"data":{"content":"YourAccountTokenHere"},"msg":""}',
                '```'
            ].join('\n'));
        return [overview, hoyolab, skport];
    }

    function createPlatformRow() {
        return new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('game_checkin_platform')
                .setPlaceholder('選擇要設定的平台')
                .setMinValues(1)
                .setMaxValues(1)
                .addOptions(
                    new StringSelectMenuOptionBuilder()
                        .setLabel('HoYoLAB')
                        .setDescription('設定 Cookie，支援五款 HoYoLAB 遊戲')
                        .setValue('hoyolab'),
                    new StringSelectMenuOptionBuilder()
                        .setLabel('SKPORT')
                        .setDescription('設定長效 account_token')
                        .setValue('skport')
                )
        );
    }

    function createCredentialModal(platform) {
        const isHoyolab = platform === 'hoyolab';
        return new ModalBuilder()
            .setCustomId(`game_checkin_credentials_modal:${platform}`)
            .setTitle(`${PLATFORM_NAMES[platform]} 憑證`)
            .addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('credential')
                    .setLabel(isHoyolab ? 'Cookie（留空停用）' : 'account_token（留空停用）')
                    .setPlaceholder(isHoyolab ? 'ltoken_v2=...; ltuid_v2=...;' : '只貼上 data.content 的值')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(false)
                    .setMaxLength(isHoyolab ? 4000 : 2048)
            ));
    }

    function createResultEmbed(title, description, success = true) {
        return new EmbedBuilder()
            .setColor(success ? config.embed.color.success : config.embed.color.error)
            .setTitle(`${success ? config.emoji.success : config.emoji.error} ┃ ${title}`)
            .setDescription(description);
    }

    async function testDirectMessage(interaction, mode) {
        const payload = {
            embeds: [new EmbedBuilder()
                .setColor(config.embed.color.success)
                .setTitle(`${emoji} ┃ 遊戲簽到通知測試`)
                .setDescription(`目前通知模式：**${MODE_NAMES[mode]}**\n這則訊息表示機器人目前可以傳送 DM 給你。`)],
            allowedMentions: { parse: [] }
        };
        try {
            await interaction.user.send(payload);
            return true;
        } catch {
            sendLog(interaction.client, '⚠️ 遊戲簽到通知測試 DM 無法送達。', 'WARN');
            return false;
        }
    }

    async function showCredentialGuide(interaction, context) {
        const record = await repository(context).readUser(interaction.user.id);
        await interaction.reply({
            embeds: createCredentialGuide(record),
            components: [createPlatformRow()],
            flags: MessageFlags.Ephemeral
        });
    }

    async function selectPlatform(interaction) {
        const platform = interaction.values?.[0];
        if (!PLATFORM_NAMES[platform]) {
            return validationReply(interaction, '**不支援選取的平台。**', { method: 'reply', ephemeral: true });
        }
        return interaction.showModal(createCredentialModal(platform));
    }

    async function submitCredential(interaction, context) {
        const platform = interaction.customId.split(':')[1];
        if (!PLATFORM_NAMES[platform]) {
            return validationReply(interaction, '**憑證表單已失效，請重新開啟設定。**', { method: 'reply', ephemeral: true });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const value = interaction.fields.getTextInputValue('credential').trim();
        try {
            if (value) await adapters.validate[platform](value, { http: context.http, signal: context.signal });
            const changed = await repository(context).setCredential(interaction.user.id, platform, value);
            wake();
            let dmTest = null;
            if (changed.firstActive && changed.record.notificationMode !== 'off') {
                dmTest = await testDirectMessage(interaction, changed.record.notificationMode);
            }
            const action = value ? (changed.changed ? '已驗證並保存' : '未變更') : '已清除並停用';
            const lines = [`${PLATFORM_NAMES[platform]} 憑證${action}。`];
            if (dmTest === true) lines.push('通知測試 DM 已成功送達。');
            if (dmTest === false) lines.push('設定已保存，但測試 DM 無法送達；請到 Discord「使用者設定 → Content & Social → Direct messages」允許共同伺服器私人訊息。');
            await interaction.editReply({ embeds: [createResultEmbed('憑證設定完成', lines.join('\n'))] });
            sendLog(interaction.client, `🎮 遊戲簽到 ${PLATFORM_NAMES[platform]} 憑證已${value ? '更新' : '停用'}。`);
        } catch (error) {
            if (error instanceof GameCheckInAdapterError) {
                return validationReply(interaction, `**${error.message}**`, { method: 'editReply' });
            }
            return errorReply(interaction, error, { context: `更新 ${PLATFORM_NAMES[platform]} 遊戲簽到憑證` });
        }
    }

    async function cycleNotifications(interaction, context) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const updated = await repository(context).cycleNotification(interaction.user.id);
            const needsTest = updated.previousMode === 'off' && updated.mode === 'all';
            const dmTest = needsTest ? await testDirectMessage(interaction, updated.mode) : null;
            const lines = [`通知模式已切換為：**${MODE_NAMES[updated.mode]}**。`];
            if (dmTest === true) lines.push('通知測試 DM 已成功送達。');
            if (dmTest === false) lines.push('設定已保存，但測試 DM 無法送達；請到 Discord「使用者設定 → Content & Social → Direct messages」允許共同伺服器私人訊息。');
            await interaction.editReply({ embeds: [createResultEmbed('通知設定完成', lines.join('\n'), dmTest !== false)] });
        } catch (error) {
            return errorReply(interaction, error, { context: '切換遊戲簽到通知模式' });
        }
    }

    const command = {
        data: new SlashCommandBuilder()
            .setName('遊戲簽到')
            .setDescription('開啟遊戲自動簽到設定面板'),

        async execute(interaction) {
            return interaction.reply({ embeds: [createPanelEmbed()], components: [createPanelRow()] });
        },

        buttonHandlers: {
            game_checkin_credentials: showCredentialGuide,
            game_checkin_notifications: cycleNotifications
        },

        componentHandlers: {
            game_checkin_platform: selectPlatform
        },

        modalSubmitHandlers: {
            game_checkin_credentials_modal: submitCredential
        }
    };

    command._test = {
        createCredentialGuide,
        createCredentialModal,
        createPanelEmbed,
        createPanelRow,
        createPlatformRow,
        testDirectMessage
    };
    return command;
}

module.exports = { MODE_NAMES, PLATFORM_NAMES, createCommand };
