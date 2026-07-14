'use strict';

function createMusicRepository({ queueRepository, panelRepository }) {
    async function saveQueue(guildID, snapshot) { return queueRepository.write(String(guildID), snapshot); }
    async function deleteQueue(guildID) { return queueRepository.write(String(guildID), null); }
    async function loadQueues() {
        const result = [];
        for (const guildID of await queueRepository.listKeys()) {
            const snapshot = await queueRepository.read(guildID);
            if (snapshot) result.push({ ...snapshot, guildID: String(snapshot.guildID || guildID) });
        }
        return result;
    }
    async function savePanel(guildID, message) {
        const panel = {
            guildID: String(guildID), channelID: String(message.channelId), messageID: String(message.id),
            updatedAt: new Date().toISOString()
        };
        await panelRepository.write(String(guildID), panel);
        return panel;
    }
    async function getPanel(guildID) { return panelRepository.read(String(guildID)); }
    async function listPanels() {
        const result = [];
        for (const guildID of await panelRepository.listKeys()) {
            const panel = await panelRepository.read(guildID);
            if (panel) result.push(panel);
        }
        return result;
    }
    return Object.freeze({ saveQueue, deleteQueue, loadQueues, savePanel, getPanel, listPanels });
}

module.exports = { createMusicRepository };
