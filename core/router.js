const { Events, PermissionFlagsBits } = require('discord.js');
const { createReplyTools } = require('./Reply');

const INTERACTION_KINDS = new Set(['button', 'modal', 'select']);
const MATCH_TYPES = new Set(['exact', 'prefix']);
const ACCESS_TYPES = new Set(['public', 'admin']);

function createRegistry() {
    return { exact: new Map(), prefix: new Map() };
}

function assertDescriptor(descriptor, label) {
    if (!descriptor || typeof descriptor !== 'object') throw new TypeError(`${label} descriptor 不可為空。`);
    if (!ACCESS_TYPES.has(descriptor.access)) throw new TypeError(`${label} 必須宣告 access: public | admin。`);
    if (typeof descriptor.execute !== 'function') throw new TypeError(`${label} 必須提供 execute。`);
}

function assertInteractionDescriptor(descriptor) {
    assertDescriptor(descriptor, 'Interaction handler');
    if (!INTERACTION_KINDS.has(descriptor.kind)) throw new TypeError(`不支援的 interaction kind：${descriptor.kind}`);
    if (!MATCH_TYPES.has(descriptor.match)) throw new TypeError(`不支援的 interaction match：${descriptor.match}`);
    if (typeof descriptor.id !== 'string' || !descriptor.id.trim()) throw new TypeError('Interaction handler id 不可為空。');
    if (descriptor.id !== descriptor.id.trim()) throw new TypeError(`Interaction handler id 不可包含首尾空白：${descriptor.id}`);
    if (descriptor.match === 'prefix' && descriptor.id.includes(':')) {
        throw new TypeError(`Prefix handler id 不可包含冒號：${descriptor.id}`);
    }
}

function formatRoute(descriptor) {
    return `${descriptor.kind}:${descriptor.match}:${descriptor.id} (${descriptor.access})`;
}

/**
 * 註冊時同時檢查 exact 與 prefix namespace。執行期 prefix 只需取冒號前第一段，
 * 因此仍維持 O(1)，且不會因檔案載入順序讓 public handler 覆蓋 admin handler。
 */
function registerInteractionDescriptor(registry, descriptor) {
    assertInteractionDescriptor(descriptor);
    const kindRegistry = registry[descriptor.kind];

    if (descriptor.match === 'exact') {
        if (kindRegistry.exact.has(descriptor.id)) {
            throw new Error(`Interaction 路由重複：${formatRoute(descriptor)}`);
        }
        const separatorIndex = descriptor.id.indexOf(':');
        const prefix = separatorIndex === -1 ? descriptor.id : descriptor.id.slice(0, separatorIndex);
        if (kindRegistry.prefix.has(prefix)) {
            throw new Error(`Interaction exact/prefix namespace 衝突：${descriptor.kind}:${descriptor.id}`);
        }
        kindRegistry.exact.set(descriptor.id, Object.freeze({ ...descriptor }));
        return;
    }

    if (kindRegistry.prefix.has(descriptor.id)) {
        throw new Error(`Interaction prefix 路由重複：${formatRoute(descriptor)}`);
    }
    for (const exactId of kindRegistry.exact.keys()) {
        if (exactId === descriptor.id || exactId.startsWith(`${descriptor.id}:`)) {
            throw new Error(`Interaction exact/prefix namespace 衝突：${descriptor.kind}:${descriptor.id}`);
        }
    }
    kindRegistry.prefix.set(descriptor.id, Object.freeze({ ...descriptor }));
}

function resolveInteractionKind(interaction) {
    if (interaction.isButton?.()) return 'button';
    if (interaction.isModalSubmit?.()) return 'modal';
    if (interaction.isAnySelectMenu?.() || interaction.isStringSelectMenu?.()) return 'select';
    return null;
}

function resolveComponentDescriptor(kindRegistry, customId) {
    const exact = kindRegistry.exact.get(customId);
    if (exact) return exact;
    const separatorIndex = customId.indexOf(':');
    if (separatorIndex <= 0 || separatorIndex === customId.length - 1) return null;
    return kindRegistry.prefix.get(customId.slice(0, separatorIndex)) || null;
}

async function assertAccess(interaction, descriptor, validationReply) {
    if (descriptor.access !== 'admin') return true;
    const allowed = interaction.inGuild?.()
        && interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
    if (allowed) return true;
    const message = interaction.inGuild?.()
        ? '**你必須是伺服器管理員才能使用此功能。**'
        : '**此功能僅能在伺服器中使用。**';
    await validationReply(interaction, message, { ephemeral: true });
    return false;
}

/**
 * 建立中央 Discord Interaction Router。所有 registry 在 attach 前即完成，避免 Client
 * 已登入後才發現路由衝突；close 只拒絕新工作，不中斷已進入 handler 的互動。
 */
function createInteractionRouter({ logger = null, config } = {}) {
    const replies = config ? createReplyTools(config) : null;
    const commands = new Map();
    const interactions = {
        button: createRegistry(),
        modal: createRegistry(),
        select: createRegistry()
    };
    let accepting = true;
    let attachedClient = null;
    let attachedContext = null;

    function registerCommand(descriptor) {
        assertDescriptor(descriptor, 'Command');
        const name = descriptor.name || descriptor.data?.toJSON?.().name || descriptor.data?.name;
        if (typeof name !== 'string' || !name) throw new TypeError('Command descriptor 缺少名稱。');
        if (commands.has(name)) throw new Error(`Slash Command 名稱重複：${name}`);
        commands.set(name, Object.freeze({ ...descriptor, name }));
    }

    function registerInteraction(descriptor) {
        registerInteractionDescriptor(interactions, descriptor);
    }

    async function rejectUnavailable(interaction, message) {
        if (!replies) throw new Error('Interaction Router dispatch 需要 config。');
        try {
            await replies.validationReply(interaction, `**${message}**`, { ephemeral: true });
        } catch (error) {
            logger?.error?.('Discord 互動拒絕回覆失敗。', error);
        }
    }

    async function dispatch(interaction, context = attachedContext) {
        if (!accepting) return rejectUnavailable(interaction, '服務正在關閉，請稍後再試。');

        let descriptor = null;
        if (interaction.isChatInputCommand?.() || interaction.isCommand?.()) {
            descriptor = commands.get(interaction.commandName) || null;
        } else {
            const kind = resolveInteractionKind(interaction);
            if (!kind) return false;
            descriptor = resolveComponentDescriptor(interactions[kind], String(interaction.customId || ''));
        }

        if (!descriptor) return rejectUnavailable(interaction, '此操作已過期或目前無法使用。');

        try {
            if (!replies) throw new Error('Interaction Router dispatch 需要 config。');
            if (!await assertAccess(interaction, descriptor, replies.validationReply)) return false;
            await descriptor.execute(interaction, context);
            return true;
        } catch (error) {
            logger?.error?.('執行 Discord 互動時發生錯誤。', error);
            try {
                await replies.errorReply(interaction, error, { context: '執行 Discord 互動' });
            } catch (replyError) {
                logger?.error?.('Discord 系統錯誤回覆失敗。', replyError);
            }
            return false;
        }
    }

    const listener = interaction => {
        void dispatch(interaction, attachedContext).catch(error => {
            logger?.error?.('Discord 互動分派發生未處理錯誤。', error);
        });
    };

    function attach(client, context) {
        if (attachedClient) throw new Error('Interaction Router 已附加 Discord Client。');
        attachedClient = client;
        attachedContext = context;
        client.on(Events.InteractionCreate, listener);
    }

    function detach() {
        if (!attachedClient) return;
        attachedClient.off(Events.InteractionCreate, listener);
        attachedClient = null;
        attachedContext = null;
    }

    function close() {
        accepting = false;
    }

    return {
        registerCommand,
        registerInteraction,
        dispatch,
        attach,
        detach,
        close,
        get commandCount() { return commands.size; },
        get commandNames() { return [...commands.keys()]; },
        get accepting() { return accepting; },
        _registries: { commands, interactions }
    };
}

module.exports = { createInteractionRouter };
