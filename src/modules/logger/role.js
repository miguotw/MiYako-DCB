const { createLogTools } = require('../../../core/sendLog');

function createInitializer(config) {
const { sendLog } = createLogTools(config);
const configModules = config.modules;

// 記錄成員身分組變更
const initializer = (client) => {
    
    if (configModules.role.enable) {
        client.on('guildMemberUpdate', async (oldMember, newMember) => {
            const user = newMember.user;
            const oldRoles = oldMember.roles.cache.map(role => role.name);
            const newRoles = newMember.roles.cache.map(role => role.name);

            // 找出新增的身分組
            const addedRoles = newRoles.filter(role => !oldRoles.includes(role));
            
            // 找出移除的身分組
            const removedRoles = oldRoles.filter(role => !newRoles.includes(role));

            let roleChanges = '';

            if (addedRoles.length > 0) {
                roleChanges += `🏷️ ${user.tag} 獲得了新身分組: ${addedRoles.join(', ')}`;
            }
            if (removedRoles.length > 0) {
                roleChanges += `🏷️ ${user.tag} 失去了身分組: ${removedRoles.join(', ')}`;
            }
            
            // 列出所有擁有的身分組
            const roles = newMember.roles.cache.map(role => role.name).join(', ') || '無角色';

            // 列出所有擁有權限
            const permissions = newMember.roles.cache.reduce((acc, role) => {
                role.permissions.toArray().forEach(permission => {
                    if (!acc.includes(permission)) {
                        acc.push(permission);
                    }
                });
                return acc;
            }, []).join(', ') || '無權限';

            sendLog(client, `${roleChanges}\n ${user.tag} 擁有的身分組: ${roles}\n ${user.tag} 擁有的權限: ${permissions}`);
        });
    }
};
return initializer;
}

module.exports = { createInitializer };
