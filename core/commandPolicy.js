const path = require('path');
const { PermissionFlagsBits } = require('discord.js');
const { config } = require(path.join(process.cwd(), 'core/config'));
const { validationReply } = require(path.join(process.cwd(), 'core/Reply'));

const ADMIN_COMMAND_NAME = String(config.Startup.adminCommandName || 'admin').trim();
const COMMAND_NAME_PATTERN = /^[-_\p{L}\p{N}\p{sc=Devanagari}\p{sc=Thai}]{1,32}$/u;

if (!COMMAND_NAME_PATTERN.test(ADMIN_COMMAND_NAME) || ADMIN_COMMAND_NAME !== ADMIN_COMMAND_NAME.toLocaleLowerCase()) {
    throw new Error('Startup.adminCommandName 不符合 Discord Slash Command 名稱規則：長度須為 1～32 個字元，且英文必須為小寫。');
}

function getAdminCommandPath(...segments) {
    return `/${[ADMIN_COMMAND_NAME, ...segments].filter(Boolean).join(' ')}`;
}

function isAdminCommandPath(filePath, commandsRoot) {
    const relativePath = path.relative(path.resolve(commandsRoot), path.resolve(filePath));
    return relativePath.split(path.sep)[0] === 'admin';
}

async function denyAdminInteraction(interaction) {
    const message = interaction.inGuild()
        ? '**你必須是伺服器管理員才能使用此功能。**'
        : '**此功能僅能在伺服器中使用。**';
    return validationReply(interaction, message, { ephemeral: true });
}

function wrapAdminHandler(handler) {
    return async interaction => {
        const isAdministrator = interaction.inGuild()
            && interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
        if (!isAdministrator) return denyAdminInteraction(interaction);
        return handler(interaction);
    };
}

function applyAdminCommandPolicy(command) {
    if (!command?.data || typeof command.execute !== 'function') {
        throw new TypeError('管理指令必須匯出 data 與 execute。');
    }

    command.data
        .setDMPermission(false)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

    command.execute = wrapAdminHandler(command.execute);
    for (const handlerType of ['modalSubmitHandlers', 'buttonHandlers', 'componentHandlers']) {
        if (!command[handlerType]) continue;
        command[handlerType] = Object.fromEntries(
            Object.entries(command[handlerType]).map(([customId, handler]) => [customId, wrapAdminHandler(handler)])
        );
    }

    return command;
}

function mergeHandlers(commands, handlerType) {
    const handlers = {};
    for (const command of commands) {
        for (const [customId, handler] of Object.entries(command[handlerType] || {})) {
            if (handlers[customId]) throw new Error(`管理指令的互動元件 ID 重複：${customId}`);
            handlers[customId] = handler;
        }
    }
    return handlers;
}

function createAdminCommand(commands) {
    if (!commands.length) return null;

    const routes = new Map();
    const options = commands.map(command => {
        const json = command.data.toJSON();
        const nestedOptions = json.options || [];
        const hasSubcommands = nestedOptions.some(option => option.type === 1 || option.type === 2);

        if (hasSubcommands) {
            if (nestedOptions.some(option => option.type !== 1)) {
                throw new Error(`管理指令「${json.name}」只能包含一層子指令。`);
            }
            if (routes.has(json.name)) throw new Error(`管理指令名稱重複：${json.name}`);
            routes.set(json.name, command);
            return {
                type: 2,
                name: json.name,
                description: json.description,
                options: nestedOptions
            };
        }

        const name = json.name;
        if (routes.has(name)) throw new Error(`管理指令名稱重複：${name}`);
        routes.set(name, command);
        return {
            type: 1,
            name,
            description: json.description,
            options: nestedOptions
        };
    });

    const data = {
        name: ADMIN_COMMAND_NAME,
        toJSON: () => ({
            name: ADMIN_COMMAND_NAME,
            description: '伺服器管理功能',
            dm_permission: false,
            default_member_permissions: PermissionFlagsBits.Administrator.toString(),
            options
        })
    };

    return {
        data,
        async execute(interaction) {
            const group = interaction.options.getSubcommandGroup(false);
            const routeName = group || interaction.options.getSubcommand();
            const command = routes.get(routeName);
            if (!command) throw new Error(`找不到管理子指令處理器：${routeName}`);
            return command.execute(interaction);
        },
        modalSubmitHandlers: {
            ...mergeHandlers(commands, 'modalSubmitHandlers'),
            ...mergeHandlers(commands, 'publicModalSubmitHandlers')
        },
        buttonHandlers: {
            ...mergeHandlers(commands, 'buttonHandlers'),
            ...mergeHandlers(commands, 'publicButtonHandlers')
        },
        componentHandlers: mergeHandlers(commands, 'componentHandlers')
    };
}

module.exports = { applyAdminCommandPolicy, createAdminCommand, getAdminCommandPath, isAdminCommandPath };
