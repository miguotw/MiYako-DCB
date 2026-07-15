/** 組合管理指令顯示路徑；權限與聚合均由 command catalog／Router 統一處理。 */
function createCommandPolicy(config) {
    return {
        getAdminCommandPath(...segments) {
            return `/${[config.startup.adminCommandName, ...segments].filter(Boolean).join(' ')}`;
        }
    };
}

module.exports = { createCommandPolicy };
