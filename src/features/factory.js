const { GatewayIntentBits, PermissionFlagsBits } = require('discord.js');

const PREFIX_ROUTES = new Set([
    'button:music_queue_open', 'button:music_queue_page', 'select:music_queue_remove',
    'modal:music_queue_clear_modal', 'button:package_panel_refresh', 'button:package_panel_note',
    'button:package_panel_archive', 'button:package_panel_delete', 'button:package_panel_wake',
    'button:package_panel_delete_archived_page', 'modal:package_panel_delete_confirm',
    'modal:package_panel_note_modal', 'button:data_collection_submit', 'button:data_collection_delete',
    'modal:data_collection_delete_modal', 'modal:data_collection_modal', 'button:raffle_join',
    'select:twitch_stream_remove', 'select:package_panel_select_carrier',
    'select:package_panel_select_carrier_2', 'button:package_panel_extra_fields',
    'modal:package_panel_extra_fields_modal', 'button:temporary_voice_remove_page',
    'modal:game_checkin_credentials_modal', 'button:game_checkin_game_toggle'
]);

const EXACT_VARIANTS = new Map([
    ['button:package_panel_add', ['package_panel_add', 'package_panel_add:detached']],
    ['modal:package_panel_add_modal', ['package_panel_add_modal', 'package_panel_add_modal:detached']],
    ['modal:music_request_modal', ['music_request_modal', 'music_request_modal:next']]
]);

function routeDescriptors(kind, handlers, access) {
    const descriptors = [];
    for (const [id, handler] of Object.entries(handlers || {})) {
        const routeKey = `${kind}:${id}`;
        const variants = EXACT_VARIANTS.get(routeKey);
        if (variants) {
            for (const variant of variants) {
                descriptors.push({ kind, id: variant, match: 'exact', access, execute: (interaction, context) => handler(interaction, context) });
            }
            continue;
        }
        descriptors.push({
            kind,
            id,
            match: PREFIX_ROUTES.has(routeKey) ? 'prefix' : 'exact',
            access,
            execute: (interaction, context) => handler(interaction, context)
        });
    }
    return descriptors;
}

function commandInteractions(command, access) {
    return [
        ...routeDescriptors('button', command.buttonHandlers, access),
        ...routeDescriptors('modal', command.modalSubmitHandlers, access),
        ...routeDescriptors('select', command.componentHandlers, access),
        ...routeDescriptors('button', command.publicButtonHandlers, 'public'),
        ...routeDescriptors('modal', command.publicModalSubmitHandlers, 'public')
    ];
}

function captureListeners(client) {
    return new Map(client.eventNames().map(event => [event, new Set(client.listeners(event))]));
}

function addedListeners(client, before) {
    const added = [];
    for (const event of client.eventNames()) {
        const existing = before.get(event) || new Set();
        for (const listener of client.listeners(event)) {
            if (!existing.has(listener)) added.push([event, listener]);
        }
    }
    return added;
}

function createFeature({ name, command, scope = 'public', intents = [], enabled = true, initializer = null }) {
    let started = false;
    let cleanup = null;
    let listeners = [];
    const access = scope === 'admin' ? 'admin' : 'public';

    if (scope === 'admin') {
        command?.data?.setDMPermission?.(false);
        command?.data?.setDefaultMemberPermissions?.(PermissionFlagsBits.Administrator);
    }

    return {
        name,
        enabled,
        intents: [GatewayIntentBits.Guilds, ...intents],
        commands: command ? [{
            data: command.data,
            scope,
            access,
            execute: (interaction, context) => command.execute(interaction, context)
        }] : [],
        interactions: command ? commandInteractions(command, access) : [],
        async start(context) {
            if (started || !initializer) return;
            const before = captureListeners(context.client);
            try {
                const result = await initializer(context.client, context);
                listeners = addedListeners(context.client, before);
                cleanup = typeof result === 'function' ? result : result?.stop;
                started = true;
            } catch (error) {
                for (const [event, listener] of addedListeners(context.client, before)) context.client.off(event, listener);
                throw error;
            }
        },
        async stop(context) {
            if (!started) return;
            started = false;
            const currentCleanup = cleanup;
            cleanup = null;
            try {
                if (currentCleanup) await currentCleanup.call(null, context);
            } finally {
                for (const [event, listener] of listeners) context.client.off(event, listener);
                listeners = [];
            }
        }
    };
}

module.exports = { createFeature };
