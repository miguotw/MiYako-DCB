'use strict';

const GAME_CHECK_IN_GAMES = Object.freeze([
    Object.freeze({ id: 'hoyolab:genshin', platform: 'hoyolab', adapterID: 'genshin', name: '原神' }),
    Object.freeze({ id: 'hoyolab:starRail', platform: 'hoyolab', adapterID: 'starRail', name: '崩壞：星穹鐵道' }),
    Object.freeze({ id: 'hoyolab:honkai3', platform: 'hoyolab', adapterID: 'honkai3', name: '崩壞3rd' }),
    Object.freeze({ id: 'hoyolab:tearsOfThemis', platform: 'hoyolab', adapterID: 'tearsOfThemis', name: '未定事件簿' }),
    Object.freeze({ id: 'hoyolab:zenlessZoneZero', platform: 'hoyolab', adapterID: 'zenlessZoneZero', name: '絕區零' }),
    Object.freeze({ id: 'skport:arknights', platform: 'skport', adapterID: 'arknights', name: '明日方舟' }),
    Object.freeze({ id: 'skport:endfield', platform: 'skport', adapterID: 'endfield', name: '明日方舟：終末地' })
]);

const GAME_BY_ID = new Map(GAME_CHECK_IN_GAMES.map(game => [game.id, game]));

function getGameByID(gameID) {
    return GAME_BY_ID.get(String(gameID || '')) || null;
}

function gamesForPlatform(platform) {
    return GAME_CHECK_IN_GAMES.filter(game => game.platform === platform);
}

function gameIDsForPlatform(platform) {
    return gamesForPlatform(platform).map(game => game.id);
}

function normalizeGameIDs(value, platform = null) {
    const selected = new Set(Array.isArray(value) ? value.map(String) : []);
    return GAME_CHECK_IN_GAMES
        .filter(game => (!platform || game.platform === platform) && selected.has(game.id))
        .map(game => game.id);
}

function enabledGameIDs(disabledGames, platform) {
    const disabled = new Set(normalizeGameIDs(disabledGames));
    return gameIDsForPlatform(platform).filter(gameID => !disabled.has(gameID));
}

module.exports = {
    GAME_CHECK_IN_GAMES,
    enabledGameIDs,
    gameIDsForPlatform,
    gamesForPlatform,
    getGameByID,
    normalizeGameIDs
};
