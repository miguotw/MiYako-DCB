'use strict';

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    SlashCommandBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const { createReplyTools } = require('../../core/Reply');
const { createLogTools } = require('../../core/sendLog');
const {
    buildHoyolabCookie,
    GameCheckInAdapterError,
    createGameCheckInAdapters
} = require('../../util/gameCheckInAdapters');
const { gamesForPlatform, getGameByID } = require('../../util/gameCheckInCatalog');
const { createGameCheckInCredentialCodec } = require('../../util/gameCheckInCredentialCodec');
const { createGameCheckInRepository } = require('../../util/gameCheckInRepository');
const { dateKeyAt, nextCheckInEpoch } = require('../../util/gameCheckInSchedule');
const {
    createGameCheckInPanelBanner,
    createGameCheckInPanelEmbed,
    createGameCheckInPanelRow
} = require('../../util/gameCheckInViews');

const PLATFORM_NAMES = Object.freeze({ hoyolab: 'HoYoLAB', skport: 'SKPORT' });
const MODE_NAMES = Object.freeze({
    all: '啟用所有通知',
    failures: '僅失敗時通知',
    off: '停用所有通知'
});

function createCommand(config, {
    adapters = createGameCheckInAdapters(),
    logTools = createLogTools(config),
    repositoryFactory = createGameCheckInRepository,
    wakeCoordinator = () => {},
    now = () => Date.now()
} = {}) {
    const { errorReply, validationReply } = createReplyTools(config);
    const { sendLog } = logTools;
    const repositoryCache = new WeakMap();
    let credentialCodec = null;
    const color = config.embed.color.default;
    const emoji = config.commands.gameCheckIn.emoji;
    const toggleEmojis = config.commands.gameCheckIn.toggleEmojis;

    function repository(context) {
        const json = context?.store?.gameCheckIn;
        if (!json) throw new Error('遊戲簽到功能缺少 gameCheckIn repository context。');
        if (!repositoryCache.has(json)) {
            credentialCodec ||= createGameCheckInCredentialCodec(
                config.commands.gameCheckIn.credentialEncryptionKey
            );
            repositoryCache.set(json, repositoryFactory(json, { credentialCodec }));
        }
        return repositoryCache.get(json);
    }

    function panelScope(interaction, fallbackChannelID = '') {
        const guildID = String(interaction.guildId || '');
        if (guildID) return { type: 'guild', id: guildID };
        const channelID = String(interaction.channelId || fallbackChannelID || '');
        if (channelID) return { type: 'dm', id: channelID };
        throw new Error('遊戲簽到主面板無法判斷 Guild 或 DM scope。');
    }

    async function fetchPanelMessage(client, panel) {
        let channel = client.channels?.cache?.get(panel.channelID);
        if (!channel && typeof client.channels?.fetch === 'function') {
            channel = await client.channels.fetch(panel.channelID).catch(() => null);
        }
        return channel?.messages?.fetch?.(panel.messageID).catch(() => null) || null;
    }

    async function disableReplacedPanels(client, panels) {
        for (const panel of panels) {
            try {
                const message = await fetchPanelMessage(client, panel);
                if (message) await message.edit({ components: [createGameCheckInPanelRow(true)] });
            } catch (error) {
                sendLog(client, '⚠️ 停用被取代的遊戲自動簽到面板失敗。', 'WARN', error);
            }
        }
    }

    async function requireCurrentPanel(interaction, context) {
        const messageID = String(interaction.message?.id || '');
        const current = messageID && await repository(context).isCurrentPanel(panelScope(interaction), messageID);
        if (current) return true;
        await validationReply(interaction, '**此遊戲簽到面板已被取代，請使用最新面板。**', {
            method: 'reply', ephemeral: true
        });
        return false;
    }

    function createPanelEmbed() {
        const nextTriggerAt = nextCheckInEpoch(
            now(),
            config.commands.gameCheckIn.checkInTime,
            config.log.timezone
        );
        return createGameCheckInPanelEmbed(config, nextTriggerAt);
    }

    function createCredentialGuide(record) {
        const status = platform => record.credentials[platform] ? '已設定' : '未設定（不自動簽到）';
        return new EmbedBuilder()
            .setColor(color)
            .setTitle(`${emoji} ┃ 遊戲自動簽到（BETA） - 輸入/更新憑證`)
            .setDescription([
                '## 目前設定狀態',
                `- HoYoLAB：${status('hoyolab')}`,
                `- SKPORT：${status('skport')}`,
                '## 憑證取得方式',
                '> -# 1. 請先閱讀下方教學，再選擇對應平台輸入。',
                '> -# 2. 若曾經填寫過憑證，輸入時會覆蓋對應平台舊有憑證，留空時會清除舊有憑證，既有憑證不會重新顯示。',
                '### HoYoLAB Cookie 取得方式',
                '1. 使用瀏覽器登入 [HoYoLAB](https://www.hoyolab.com/) ，按 F12 開啟開發者工具。',
                '2. 到 Application／儲存空間 → Cookies → `https://www.hoyolab.com`。',
                '3. 分別找到 `ltoken_v2` 與 `ltuid_v2`，將瀏覽器複製出的完整內容貼到對應欄位。請勿刪除名稱、冒號或雙引號，格式如下：',
                '`ltoken_v2`：',
                '```',
                'ltoken_v2:"v2_xxxxxxxxxx"',
                '```',
                '`ltuid_v2`：',
                '```',
                'ltuid_v2:"123456789"',
                '```',
                '### SKPORT 帳號 Token 取得方式',
                '1. 使用瀏覽器登入 [Gryphline](https://user.gryphline.com/) 。',
                '2. 使用瀏覽器開啟 https://web-api.gryphline.com/cookie_store/account_token 。',
                '3. 畫面會顯示類似以下 JSON，只複製 `data.content` 的值。',
                '```json',
                '{"code":0,"data":{"content":"YourAccountTokenHere"},"msg":""}',
                '```'
            ].join('\n'));
    }

    function createCredentialPlatformRow() {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('game_checkin_credentials_hoyolab')
                .setLabel('HoYoLAB')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('game_checkin_credentials_skport')
                .setLabel('SKPORT')
                .setStyle(ButtonStyle.Primary)
        );
    }

    function createGameSettingsEmbed() {
        return new EmbedBuilder()
            .setColor(color)
            .setTitle(`${emoji} ┃ 遊戲自動簽到（BETA） - 啟用/停用簽到`)
            .setDescription([
                '點選下方按鈕可分別啟用或停用自動簽到。',
                '> 已開始或等待重試的遊戲將沿用當日設定，其餘變更可立即生效。',
                `> \`${toggleEmojis.enabled} 啟用\` \`${toggleEmojis.disabled} 停用\``
            ].join('\n'));
    }

    function createGameSettingsRows(record) {
        const disabled = new Set(record.disabledGames);
        return ['hoyolab', 'skport'].map(platform => new ActionRowBuilder().addComponents(
            gamesForPlatform(platform).map(game => {
                const enabled = !disabled.has(game.id);
                return new ButtonBuilder()
                    .setCustomId(`game_checkin_game_toggle:${game.id}`)
                    .setLabel(game.name)
                    .setStyle(enabled ? ButtonStyle.Success : ButtonStyle.Danger);
            })
        ));
    }

    function createCredentialModal(platform) {
        const isHoyolab = platform === 'hoyolab';
        const modal = new ModalBuilder()
            .setCustomId(`game_checkin_credentials_modal:${platform}`)
            .setTitle(`${PLATFORM_NAMES[platform]} 憑證`);
        if (isHoyolab) {
            return modal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('ltoken_v2')
                        .setLabel('ltoken_v2 完整內容（兩欄皆留空可停用）')
                        .setPlaceholder('ltoken_v2:"v2_xxxxxxxxxx"')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                        .setMaxLength(2064)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('ltuid_v2')
                        .setLabel('ltuid_v2 完整內容（兩欄皆留空可停用）')
                        .setPlaceholder('ltuid_v2:"123456789"')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                        .setMaxLength(64)
                )
            );
        }
        return modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('credential')
                .setLabel('account_token（留空停用）')
                .setPlaceholder('只貼上 data.content 的值')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setMaxLength(2048)
        ));
    }

    function createResultEmbed(title, description, success = true) {
        return new EmbedBuilder()
            .setColor(success ? config.embed.color.success : config.embed.color.error)
            .setTitle(`${success ? config.emoji.success : config.emoji.error} ┃ ${title}`)
            .setDescription(description);
    }

    async function showCredentialGuide(interaction, context) {
        const record = await repository(context).readUser(interaction.user.id);
        await interaction.reply({
            embeds: [createCredentialGuide(record)],
            components: [createCredentialPlatformRow()],
            flags: MessageFlags.Ephemeral
        });
    }

    async function showCredentialModal(interaction, platform) {
        return interaction.showModal(createCredentialModal(platform));
    }

    async function showGameSettings(interaction, context) {
        const record = await repository(context).readUser(interaction.user.id);
        await interaction.reply({
            embeds: [createGameSettingsEmbed()],
            components: createGameSettingsRows(record),
            flags: MessageFlags.Ephemeral
        });
    }

    async function toggleGame(interaction, context) {
        const gameID = interaction.customId.slice('game_checkin_game_toggle:'.length);
        if (!getGameByID(gameID)) {
            return validationReply(interaction, '**遊戲設定按鈕已失效，請重新開啟設定。**', {
                method: 'reply', ephemeral: true
            });
        }
        try {
            const updated = await repository(context).toggleGame(interaction.user.id, gameID, {
                date: dateKeyAt(now(), config.log.timezone)
            });
            await interaction.update({
                embeds: [createGameSettingsEmbed()],
                components: createGameSettingsRows(updated.record)
            });
            try {
                await wakeCoordinator();
            } catch (error) {
                sendLog(interaction.client, '⚠️ 喚醒遊戲自動簽到排程失敗。', 'WARN', error);
            }
        } catch (error) {
            return errorReply(interaction, error, { context: '切換單一遊戲自動簽到設定' });
        }
    }

    async function submitCredential(interaction, context) {
        const platform = interaction.customId.split(':')[1];
        if (!PLATFORM_NAMES[platform]) {
            return validationReply(interaction, '**憑證表單已失效，請重新開啟設定。**', { method: 'reply', ephemeral: true });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const value = platform === 'hoyolab'
                ? buildHoyolabCookie(
                    interaction.fields.getTextInputValue('ltoken_v2'),
                    interaction.fields.getTextInputValue('ltuid_v2')
                )
                : interaction.fields.getTextInputValue('credential').trim();
            if (value) await adapters.validate[platform](value, { http: context.http, signal: context.signal });
            const changed = await repository(context).setCredential(interaction.user.id, platform, value);
            const action = value ? (changed.changed ? '已驗證並保存' : '未變更') : '已清除並停用';
            await interaction.editReply({
                embeds: [createResultEmbed('憑證設定完成', `${PLATFORM_NAMES[platform]} 憑證${action}。`)]
            });
            const username = interaction.user?.username || interaction.user?.tag
                || String(interaction.user?.id || '未知使用者');
            sendLog(
                interaction.client,
                `🎮 遊戲簽到 ${username} 的 ${PLATFORM_NAMES[platform]} 憑證已${value ? '更新' : '停用'}。`
            );
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
            await interaction.editReply({
                embeds: [createResultEmbed('通知設定完成', `**通知模式已切換為：${MODE_NAMES[updated.mode]}。**`)]
            });
        } catch (error) {
            return errorReply(interaction, error, { context: '切換遊戲簽到通知模式' });
        }
    }

    const command = {
        data: new SlashCommandBuilder()
            .setName('遊戲簽到')
            .setDescription('開啟遊戲自動簽到設定面板'),

        async execute(interaction, context) {
            await interaction.reply({
                embeds: [createPanelEmbed()],
                components: [createGameCheckInPanelRow()],
                files: [createGameCheckInPanelBanner()]
            });
            const message = await interaction.fetchReply();
            const saved = await repository(context).savePanel(panelScope(interaction, message.channelId), message);
            await disableReplacedPanels(interaction.client, saved.replaced);
        },

        buttonHandlers: {
            game_checkin_credentials: async (interaction, context) => {
                if (await requireCurrentPanel(interaction, context)) return showCredentialGuide(interaction, context);
            },
            game_checkin_notifications: async (interaction, context) => {
                if (await requireCurrentPanel(interaction, context)) return cycleNotifications(interaction, context);
            },
            game_checkin_games: async (interaction, context) => {
                if (await requireCurrentPanel(interaction, context)) return showGameSettings(interaction, context);
            },
            game_checkin_credentials_hoyolab: interaction => showCredentialModal(interaction, 'hoyolab'),
            game_checkin_credentials_skport: interaction => showCredentialModal(interaction, 'skport'),
            game_checkin_game_toggle: toggleGame
        },

        modalSubmitHandlers: {
            game_checkin_credentials_modal: submitCredential
        }
    };

    command._test = {
        createCredentialGuide,
        createCredentialModal,
        createCredentialPlatformRow,
        createGameSettingsEmbed,
        createGameSettingsRows,
        createPanelEmbed,
        createPanelRow: createGameCheckInPanelRow,
        panelScope,
        requireCurrentPanel
    };
    return command;
}

module.exports = { MODE_NAMES, PLATFORM_NAMES, createCommand };
