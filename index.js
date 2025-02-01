const { Client, GatewayIntentBits, REST, Routes, Collection } = require('discord.js');
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const axios = require('axios');
const OpenCC = require('opencc-js');

// 讀取 YAML 設定檔
const configFile = fs.readFileSync('./config.yml', 'utf8');
const config = yaml.parse(configFile);

// Discord bot 設定
const TOKEN = config.Start.Token; // 讀取機器人 TOKEN
const CLIENT_ID = config.Start.Client_ID; //應用程式ID
const LOG_CHANNEL = config.Logger.Settings.Channel; // 讀取日誌頻道 ID
const TIMEZONE_OFFSET = config.Logger.Settings.Time_Zone; // 讀取時區偏移
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
console.log("✅ 創建 Discord 客戶端成功！");

// 取得當前時間，並格式化
function getTimePrefix() {
    const now = new Date();
    now.setHours(now.getHours() + TIMEZONE_OFFSET); // 应用时区偏移
    const days = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
    const day = days[now.getDay()];
    const time = now.toLocaleTimeString('zh-TW', { hour12: false });
    return `[${day} ${time} INFO ]`;
}

// 發送日誌訊息到指定頻道
function sendLog(message) {
    const logChannel = client.channels.cache.get(LOG_CHANNEL);
    if (logChannel) {
        logChannel.send(`\`\`\`diff\n ${getTimePrefix()} ${message}\n\`\`\``);
    } else {
        console.error("❌ 無法找到日誌頻道，請檢查 config.yml 中的 logChannel 是否正確。");
    }
}

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
        console.log('🚀 開始註冊斜線指令...');
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('✅ 斜線指令註冊完成！');
    } catch (error) {
        console.error('❌ 註冊斜線指令時發生錯誤：', error);
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
require('./src/logger')(client, sendLog);
require('./src/event/member_join.js')(client);
require('./src/event/member_leave.js')(client);



// 當機器人啟動時，發送日誌訊息到指定頻道
client.once('ready', async () => {
    console.log(`✅ 機器人已啟動！以「${client.user.tag}」身分登入！`);
    sendLog(`✅ 機器人已啟動！以「${client.user.tag}」身分登入！`);

    try {
        // 使用 axios 獲取一言內容
        const response = await axios.get(HITOKOTO);
        let hitokotoText = response.data.hitokoto;
        
        // 使用 OpenCC 進行簡體到繁體轉換
        const converter = OpenCC.Converter({ from: 'cn', to: 'twp' });
        hitokotoText = converter(hitokotoText);

        // 設定機器人活動狀態
        client.user.setActivity(hitokotoText, { type: READY_TYPE });
        console.log(`✅ 已設定活動狀態：${READY_TYPE} ${hitokotoText}`);
    } catch (error) {
        console.error("❌ 無法獲取 Hitokoto API 資料：", error);
    }
});


client.login(TOKEN);