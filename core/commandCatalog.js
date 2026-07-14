const { PermissionFlagsBits } = require('discord.js');
const { createInteractionRouter } = require('./router');

function commandName(command) {
    return command?.data?.toJSON?.().name || command?.data?.name;
}

function createAdminAggregate(commands, adminCommandName) {
    if (!commands.length) return null;
    const routes = new Map();
    const options = commands.map(descriptor => {
        const json = descriptor.data.toJSON();
        const nestedOptions = json.options || [];
        const hasSubcommands = nestedOptions.some(option => option.type === 1 || option.type === 2);

        if (routes.has(json.name)) throw new Error(`管理指令名稱重複：${json.name}`);
        routes.set(json.name, descriptor);

        if (hasSubcommands) {
            if (nestedOptions.some(option => option.type !== 1)) {
                throw new Error(`管理指令「${json.name}」只能包含一層子指令。`);
            }
            return { type: 2, name: json.name, description: json.description, options: nestedOptions };
        }
        return { type: 1, name: json.name, description: json.description, options: nestedOptions };
    });

    return {
        name: adminCommandName,
        access: 'admin',
        data: {
            name: adminCommandName,
            toJSON: () => ({
                name: adminCommandName,
                description: '伺服器管理功能',
                dm_permission: false,
                default_member_permissions: PermissionFlagsBits.Administrator.toString(),
                options
            })
        },
        async execute(interaction, context) {
            const group = interaction.options.getSubcommandGroup(false);
            const routeName = group || interaction.options.getSubcommand();
            const route = routes.get(routeName);
            if (!route) throw new Error(`找不到管理子指令處理器：${routeName}`);
            return route.execute(interaction, context);
        }
    };
}

/**
 * 將 enabled manifests 收斂為 runtime 與 deploy 共用的唯一 catalog。Slash 名稱、
 * feature 名稱及 handler 衝突都在 Discord Client 建立前檢查，避免部署內容和 runtime 漂移。
 */
function buildCommandCatalog(manifests, { adminCommandName }) {
    const featureNames = new Set();
    const publicCommands = [];
    const adminCommands = [];
    const interactions = [];
    const intents = new Set();

    for (const manifest of manifests) {
        if (!manifest || manifest.enabled === false) continue;
        if (typeof manifest.name !== 'string' || !manifest.name) throw new TypeError('Feature manifest 缺少 name。');
        if (featureNames.has(manifest.name)) throw new Error(`Feature manifest 名稱重複：${manifest.name}`);
        featureNames.add(manifest.name);

        for (const intent of manifest.intents || []) intents.add(intent);
        for (const descriptor of manifest.commands || []) {
            const name = commandName(descriptor);
            if (!name || typeof descriptor.execute !== 'function') {
                throw new TypeError(`Feature「${manifest.name}」包含無效 command descriptor。`);
            }
            const normalized = { access: descriptor.access || 'public', scope: descriptor.scope || 'public', ...descriptor };
            if (normalized.scope === 'admin') adminCommands.push(normalized);
            else publicCommands.push(normalized);
        }
        for (const descriptor of manifest.interactions || []) interactions.push(descriptor);
    }

    const seenPublic = new Set();
    for (const command of publicCommands) {
        const name = commandName(command);
        if (seenPublic.has(name) || name === adminCommandName) throw new Error(`Slash Command 名稱重複：${name}`);
        seenPublic.add(name);
    }

    const admin = createAdminAggregate(adminCommands, adminCommandName);
    const commands = admin ? [...publicCommands, admin] : publicCommands;
    const catalog = {
        manifests: manifests.filter(manifest => manifest?.enabled !== false),
        commands,
        interactions,
        intents: [...intents],
        commandJson: commands.map(command => command.data.toJSON())
    };
    // deploy 不會建立 runtime Router，但仍必須在 REST PUT 前得到相同的衝突結果。
    const validationRouter = createInteractionRouter();
    registerCatalog(validationRouter, catalog);
    return catalog;
}

function registerCatalog(router, catalog) {
    for (const command of catalog.commands) router.registerCommand(command);
    for (const descriptor of catalog.interactions) router.registerInteraction(descriptor);
}

module.exports = { buildCommandCatalog, registerCatalog };
