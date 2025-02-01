const { Events } = require('discord.js');
const fs = require('fs');
const yaml = require('yaml');

// 讀取 YAML 設定檔
const configFile = fs.readFileSync('./config.yml', 'utf8');
const config = yaml.parse(configFile);


module.exports = (client, sendLog) => {
    // 記錄新訊息
    if (config.Logger.Type.Message.Create) {
        client.on('messageCreate', (message) => {
            if (!message.author.bot) {
                sendLog(`✏️ ${message.author.tag} 在「#${message.channel.name}」發送了訊息: ${message.content}`);
            }
        });
    }
    
    // 記錄訊息變更
    if (config.Logger.Type.Message.Update) {
        client.on('messageUpdate', async (oldMessage, newMessage) => {
            if (!oldMessage.author.bot && oldMessage.content !== newMessage.content) {
                sendLog(`✏️ ${oldMessage.author.tag} 在「#${oldMessage.channel.name}」編輯了訊息: \n 原內容: ${oldMessage.content} \n 新內容: ${newMessage.content}`);
            }
        });
    }

    // 記錄訊息刪除
    if (config.Logger.Type.Message.Delete) {
        client.on('messageDelete', async (message) => {
            if (!message.author.bot) {
                sendLog(`🗑️ ${message.author.tag} 在「#${message.channel.name}」刪除了訊息: ${message.content || "無法獲取內容"}`);
            }
        });
    }

    // 記錄語音頻道進出
    if (config.Logger.Type.Voice) {
        client.on('voiceStateUpdate', (oldState, newState) => {
            const user = newState.member.user; // 取得使用者資料

            // 使用者加入語音頻道
            if (!oldState.channel && newState.channel) {
                sendLog(`🔊 ${user.tag} 加入了語音頻道「${newState.channel.name}」`);
            }

            // 使用者離開語音頻道
            else if (oldState.channel && !newState.channel) {
                sendLog(`🔇 ${user.tag} 離開了語音頻道「${oldState.channel.name}」`);
            }

            // 使用者切換語音頻道
            else if (oldState.channel && newState.channel && oldState.channel.id !== newState.channel.id) {
                sendLog(`🔊 ${user.tag} 從「${oldState.channel.name}」切換到「${newState.channel.name}」`);
            }
        });
    }

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

            sendLog(`${roleChanges}\n ${user.tag} 擁有的身分組: ${roles}\n ${user.tag} 擁有的權限: ${permissions}`);
        });
    }

    // 成員加入與離開
    if (config.Logger.Type.Member) {
        client.on(Events.GuildMemberAdd, async (member) => {
            sendLog(`🚧 ${member.user.username} 已加入「${member.guild.name}」`);
        });

        client.on(Events.GuildMemberRemove, async (member) => {
            sendLog(`🚧 ${member.user.username} 已離開「${member.guild.name}」`);
        });

    }
};
