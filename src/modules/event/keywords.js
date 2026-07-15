'use strict';

const { Events } = require('discord.js');
const { createLogTools } = require('../../../core/sendLog');

function createInitializer(config) {
const { sendLog } = createLogTools(config);
const settings = config.modules.keywords;
const cooldowns = new Map();
const pending = new Set();

function cooldownKey(message, groupName) {
    return `${message.guildId || 'dm'}:${message.channel.id}:${groupName}`;
}

function shouldRespondInChannel(channelID) {
    const listed = settings.channels.includes(channelID);
    return settings.whitelist ? listed : !listed;
}

async function respond(message, groupName, group, foundKeyword) {
    const key = cooldownKey(message, groupName);
    const now = Date.now();
    if (pending.has(key) || now < (cooldowns.get(key) || 0)) return false;

    // 在第一個 await 前取得 slot；同一批 MessageCreate 不會同時進入同一回應組。
    pending.add(key);
    cooldowns.set(key, now + settings.cooldown);
    let response = null;
    try {
        for (const emoji of group.reaction || []) await message.react(emoji).catch(() => {});
        if (group.message?.length) {
            response = group.message[Math.floor(Math.random() * group.message.length)];
            await message.channel.send(response);
        }
        if (settings.enable) {
            sendLog(message.client, `🔍 ${message.author.tag} 在「#${message.channel.name}」觸發「${groupName}」關鍵字組：${foundKeyword}(${response})`, 'INFO');
        }
        return true;
    } finally {
        pending.delete(key);
        if (settings.cooldown === 0) cooldowns.delete(key);
    }
}

const initializer = client => {
    const listener = async message => {
        try {
            if (message.author.bot || !shouldRespondInChannel(message.channel.id)) return;
            const content = message.content.toLowerCase();
            for (const [groupName, group] of Object.entries(settings.triggers)) {
                const found = group.keywords.find(keyword => content.includes(keyword.toLowerCase()));
                if (!found) continue;
                await respond(message, groupName, group, found);
                break;
            }
        } catch (error) {
            sendLog(client, `❌ 關鍵字回應失敗 (頻道: ${message.channel.name})`, 'ERROR', error);
        }
    };
    client.on(Events.MessageCreate, listener);
    return () => {
        client.off(Events.MessageCreate, listener);
        cooldowns.clear();
        pending.clear();
    };
};
initializer._test = { cooldownKey, respond };
return initializer;
}

module.exports = { createInitializer };
