const { Client, GatewayIntentBits, REST, Routes, Collection } = require('discord.js');
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const axios = require('axios');
const OpenCC = require('opencc-js');
const { sendLog } = require(path.join(process.cwd(), 'core/log'));

// 讀取 YAML 設定檔
const configFile = fs.readFileSync('./config.yml', 'utf8');
const config = yaml.parse(configFile);

// Discord bot 設定
const TOKEN = config.Start.Token; // 讀取機器人 TOKEN
const CLIENT_ID = config.Start.Client_ID; //應用程式ID
const READY_TYPE = config.Message.Ready_Type; // 讀取狀態類型
const HITOKOTO = config.API.Hitokoto; // 讀取 Hitokoto API 連結

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates
    ]
});
sendLog(client, '✅ 創建 Discord 客戶端成功！');

// 儲存指令
client.commands = new Collection();
const commands = [];

function loadCommands(dir) {
    const files = fs.readdirSync(dir, { withFileTypes: true });
    for (const file of files) {
        const fullPath = path.join(dir, file.name);
        if (file.isDirectory()) {
            loadCommands(fullPath);
        } else if (file.isFile() && file.name.endsWith('.js')) {
            const command = require(path.resolve(fullPath)); // 使用 `path.resolve()`
            client.commands.set(command.data.name, command);
            commands.push(command.data.toJSON());
        }
    }
}

loadCommands('./src/commands');

// 註冊斜線指令
const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
    try {
        sendLog(client, '🚀 開始註冊斜線指令...');
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        sendLog(client, '✅ 斜線指令註冊完成！');
    } catch (error) {
        sendLog(client, '❌ 註冊斜線指令時發生錯誤：', "ERROR", error);
    }
})();

// 事件：處理斜線指令
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
        await command.execute(interaction);
    } catch (error) {
        console.error(error);
        await interaction.reply({ content: '執行指令時發生錯誤！', ephemeral: true });
    }
});

// 載入外部模組 
require('./src/logger/member.js')(client);
require('./src/logger/message.js')(client);
require('./src/logger/role.js')(client);
require('./src/logger/voice.js')(client);
require('./src/event/member_join.js')(client);
require('./src/event/member_leave.js')(client);



// 當機器人啟動時，發送日誌訊息到指定頻道
client.once('ready', async () => {
    sendLog(client, `✅ 機器人已啟動！以「${client.user.tag}」身分登入！`);


    try {
        // 使用 axios 獲取一言內容
        const response = await axios.get(HITOKOTO);
        let hitokotoText = response.data.hitokoto;
        
        // 使用 OpenCC 進行簡體到繁體轉換
        const converter = OpenCC.Converter({ from: 'cn', to: 'twp' });
        hitokotoText = converter(hitokotoText);

        // 設定機器人活動狀態
        client.user.setActivity(hitokotoText, { type: READY_TYPE });
        sendLog(client, `✅ 已設定活動狀態：${READY_TYPE} ${hitokotoText}`);
    } catch (error) {
        sendLog(client, "❌ 無法獲取 Hitokoto API 資料：", "ERROR", error);
    }
});


client.login(TOKEN);