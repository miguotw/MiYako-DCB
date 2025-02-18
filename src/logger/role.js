const fs = require('fs');
const yaml = require('yaml');
const path = require('path');
const { sendLog } = require(path.join(process.cwd(), 'core/log'));

// 讀取 YAML 設定檔
const configFile = fs.readFileSync('./config.yml', 'utf8');
const config = yaml.parse(configFile);


module.exports = (client) => {
    // 記錄成員身分組變更
    if (config.Logger.Type.Role) {
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
