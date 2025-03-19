const path = require('path');
const fs = require('fs');
const { Client, GatewayIntentBits, REST, Routes, Collection } = require('discord.js');
const { config } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));
const { errorReply } = require(path.join(process.cwd(), 'core/errorReply'));
const { getHitokoto } = require(path.join(process.cwd(), 'util/getHitokoto'));

// Discord bot 設定
const TOKEN = config.Start.Token; // 讀取機器人 TOKEN
const CLIENT_ID = config.Start.Client_ID; //應用程式ID
const READY_TYPE = config.Message.Ready_Type; // 讀取狀態類型

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

// 載入模組
function loadModules(dir) {
    const files = fs.readdirSync(dir, { withFileTypes: true });
    for (const file of files) {
        const fullPath = path.join(dir, file.name);
        if (file.isDirectory()) {
            loadModules(fullPath);
        } else if (file.isFile() && file.name.endsWith('.js')) {
            const module = require(path.resolve(fullPath));
            module(client); // 將 client 傳遞給模組
            sendLog(client, `✅ 已載入模組：${file.name}`);
        }
    }
}

loadModules('./src/modules');

// 載入指令
client.commands = new Collection();
const commands = [];

function loadCommands(dir) {
    const files = fs.readdirSync(dir, { withFileTypes: true });
    for (const file of files) {
        const fullPath = path.join(dir, file.name);
        if (file.isDirectory()) {
            loadCommands(fullPath);
        } else if (file.isFile() && file.name.endsWith('.js')) {
            const command = require(path.resolve(fullPath));
            client.commands.set(command.data.name, command);
            commands.push(command.data.toJSON());
            sendLog(client, `✅ 已載入指令：${file.name}`);
        }
    }
}

loadCommands('./src/commands');

// 註冊指令
const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
    try {
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        sendLog(client, '✅ 指令註冊完成！');
    } catch (error) {
        sendLog(client, '❌ 註冊指令時發生錯誤：', "ERROR", error);
    }
})();

// 事件：處理指令
client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isCommand()) {
            // 處理 Slash Command
            const command = client.commands.get(interaction.commandName);
            if (!command) return;

            await command.execute(interaction);
        } else if (interaction.isModalSubmit()) {
            // 處理 Modal 提交
            const command = client.commands.find(cmd => cmd.modalSubmit);
            if (command && command.modalSubmit) {
                await command.modalSubmit(interaction);
            }
        }
    } catch (error) {
        console.error(error);
        errorReply(interaction, '**執行指令時發生錯誤**');
    }
});

// 當機器人啟動時，發送日誌訊息到指定頻道
client.once('ready', async () => {
    sendLog(client, `✅ 機器人已啟動！以「${client.user.tag}」身分登入！在 ${client.guilds.cache.size} 個伺服器提供服務！`);

    try {
        // 獲取短句
        const { hitokotoText } = await getHitokoto();

        // 設定機器人活動狀態
        client.user.setActivity(hitokotoText, { type: READY_TYPE });
        sendLog(client, `✅ 已設定活動狀態：${READY_TYPE} ${hitokotoText}`);
    } catch (error) {
        sendLog(client, "❌ 無法獲取 Hitokoto API 資料：", "ERROR", error);
    }
});

client.login(TOKEN);