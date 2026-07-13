const path = require('path');
const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown
} = require('discord.js');
const { config, configCommands } = require(path.join(process.cwd(), 'core/config'));
const { updateDataCollection } = require(path.join(process.cwd(), 'util/dataCollectionStore'));

const COLOR = config.embed.color.default;
const EMOJI = configCommands.dataCollection?.emoji || '📝';
const PAGE_DESCRIPTION_LIMIT = 3800;

function submitRow(record, disabled = false) {
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`data_collection_submit:${record.id}`)
            .setLabel('提交資料').setStyle(ButtonStyle.Primary).setDisabled(disabled)
    )];
}

function deleteRow(record) {
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`data_collection_delete:${record.id}`)
            .setLabel('刪除資料').setStyle(ButtonStyle.Danger)
    )];
}

function createPublicEmbed(record) {
    const embed = new EmbedBuilder().setColor(COLOR).setTitle(`${EMOJI} ┃ 資料收集（BETA）`)
        .setDescription(record.description)
        .addFields({ name: '截止倒數', value: `<t:${record.deadline}:R>` })
        .setFooter({ text: record.id })
        .setTimestamp(record.createdAt ? new Date(record.createdAt) : new Date());
    if (record.imageURL) embed.setImage(record.imageURL);
    return embed;
}

function sanitizeCell(value) {
    return escapeMarkdown(String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '｜').trim());
}

function createSubmissionLines(record) {
    return Object.entries(record.submissions || {}).sort(([, a], [, b]) =>
        Date.parse(a.submittedAt || 0) - Date.parse(b.submittedAt || 0)
    ).map(([userID, submission]) => `- <@${userID}> | ${submission.values.map(sanitizeCell).join(' | ')}`);
}

function paginateLines(lines, limit = PAGE_DESCRIPTION_LIMIT) {
    if (!lines.length) return ['尚未收到資料。'];
    const pages = [];
    let page = '';
    const safeLines = lines.flatMap(line => {
        if (line.length <= limit) return [line];
        const chunks = [];
        for (let index = 0; index < line.length; index += limit) chunks.push(line.slice(index, index + limit));
        return chunks;
    });
    for (const line of safeLines) {
        const next = page ? `${page}\n${line}` : line;
        if (next.length > limit && page) {
            pages.push(page);
            page = line;
        } else page = next;
    }
    if (page) pages.push(page);
    return pages;
}

function createAdminEmbed(record, description, page, totalPages) {
    return new EmbedBuilder().setColor(COLOR).setTitle(`${EMOJI} ┃ 資料收集管理面板（BETA）`)
        .setDescription(description)
        .setFooter({ text: `${record.id} • 第 ${page + 1}/${totalPages} 頁` })
        .setTimestamp();
}

async function syncAdminPanels(client, record) {
    const channel = await client.channels.fetch(record.adminChannelID).catch(() => null);
    if (!channel || typeof channel.send !== 'function') throw new Error('找不到資料收集管理面板頻道。');
    const pages = paginateLines(createSubmissionLines(record));
    const oldIDs = [...(record.adminPageMessageIDs || [])];
    const nextIDs = [];

    for (let index = 0; index < pages.length; index++) {
        const payload = {
            embeds: [createAdminEmbed(record, pages[index], index, pages.length)],
            components: index === 0 ? deleteRow(record) : []
        };
        const existing = oldIDs[index]
            ? await channel.messages?.fetch(oldIDs[index]).catch(() => null)
            : null;
        const message = existing ? await existing.edit(payload) : await channel.send(payload);
        nextIDs.push(message.id);
        updateDataCollection(record.guildID, record.id, current => { current.adminPageMessageIDs = [...nextIDs]; });
    }
    for (const obsoleteID of oldIDs.slice(pages.length)) {
        const message = await channel.messages?.fetch(obsoleteID).catch(() => null);
        if (message) await message.delete().catch(() => {});
    }
    updateDataCollection(record.guildID, record.id, current => {
        current.adminPageMessageIDs = nextIDs;
        current.adminSyncPending = false;
    });
    return nextIDs;
}

async function deleteAdminPanels(client, record) {
    const channel = await client.channels.fetch(record.adminChannelID).catch(() => null);
    for (const messageID of record.adminPageMessageIDs || []) {
        const message = await channel?.messages?.fetch(messageID).catch(() => null);
        if (message) await message.delete().catch(() => {});
    }
}

module.exports = {
    createPublicEmbed, createSubmissionLines, deleteAdminPanels, paginateLines,
    sanitizeCell, submitRow, syncAdminPanels
};
