# MiYako-DCB

MiYako-DCB（みやこ機器人第三代）是以 [discord.js](https://discord.js.org/) v14 製作的多功能 Discord Bot。專案採 CommonJS，啟動時自動探索並載入指令與事件模組，適合作為持續加入社群工具的單體 Bot 專案。

> 專案仍在開發中。本文同時是使用說明與開發導覽；開始新需求前，建議先閱讀「架構與載入流程」及「擴充方式」。

## 功能概覽

### Slash Commands

| 指令 | 功能 | 備註 |
| --- | --- | --- |
| `/關於みやこ` | 顯示 Bot、維護者與伺服器資訊 | 指令名稱受 `botNickname` 設定影響 |
| `/延遲` | 顯示 WebSocket 延遲 |  |
| `/一言` | 取得隨機動漫短句 | 使用 Hitokoto API |
| `/時間戳` | 產生目前或指定時間的 Discord 時間戳 | 使用 Modal |
| `/網際協定位址資訊` | 查詢 IPv4／IPv6 資訊 | 使用 ip-api.com |
| `/麥塊` | 查詢 Minecraft 玩家外觀或伺服器狀態 | 使用 Minotar、mcsrvstat.us |
| `/物流 管理面板` | 新增、更新、封存與追蹤包裹 | 需要 Track.TW Token；資料依使用者存於本機 |
| `/公告` | 將既有訊息製成公告並傳至指定頻道 | 僅限伺服器管理員 |
| `/刪除訊息` | 批次或逐筆刪除訊息 | 伺服器內僅限管理員；支援清除 Bot 私訊 |
| `/用戶資料` | 以 ID、提及或 Username 查詢用戶 |  |

### 自動事件與紀錄

- 在伺服器系統頻道發送成員加入／離開訊息。
- 依關鍵字回覆訊息或加入 Reaction，支援頻道白名單／黑名單語意與冷卻時間。
- 將成員、訊息、身分組及語音活動寫入指定 Discord 日誌頻道。
- 定時檢查 Twitch 直播、發送或更新直播通知。
- 定時檢查包裹貨態，通知使用者並自動封存長期無更新的包裹。

## 執行環境

- Node.js 18 或更新版本（專案原先以 Node.js 18 為建議版本）
- npm
- Discord Bot Token 與 Application ID
- 視功能需要：Twitch Developer 憑證、Track.TW API Token

Bot 建立時會要求下列 Gateway Intents：`Guilds`、`GuildMessages`、`MessageContent`、`GuildMembers`、`GuildVoiceStates`、`DirectMessages`。請在 Discord Developer Portal 的 Bot 頁面啟用 **Server Members Intent** 與 **Message Content Intent**；邀請 Bot 時也需授予其實際功能所需的檢視頻道、讀取歷史、發送訊息、嵌入連結、管理訊息等權限。

## 安裝與啟動

```bash
git clone https://github.com/miguotw/MiYako-DCB.git
cd MiYako-DCB
npm install
cp -r config_example config
```

編輯 `config/` 中的三份 YAML：

- `config.yml`：Token、Application ID、狀態、日誌頻道、Embed 顏色與共用 Emoji。
- `configCommands.yml`：各 Slash Command、Twitch 通知及第三方 API 的設定。
- `configModules.yml`：成員事件、訊息／身分組／語音紀錄及關鍵字規則。

設定完成後，務必在專案根目錄啟動：

```bash
node index.js
```

啟動過程會向 Discord 註冊**全域** Application Commands，接著登入 Bot。全域指令的新增或變更可能不會立刻出現在所有伺服器。三份設定檔會在模組載入時一次讀取，修改設定後需要重新啟動。

`config/` 含敏感資料且已被 `.gitignore` 排除；請勿提交 Token 或 API Secret。

## 專案結構

```text
MiYako-DCB/
├── index.js                    # 程式入口、模組／指令載入、互動分派、指令註冊
├── core/
│   ├── config.js               # 同步讀取並解析三份 YAML 設定
│   ├── Reply.js                # 統一成功／錯誤 Embed 回覆
│   └── sendLog.js              # 終端與 Discord 頻道日誌
├── src/
│   ├── commands/               # Slash Commands
│   │   └── admin/              # 管理用途指令（權限仍由各指令自行檢查）
│   └── modules/
│       ├── event/              # 歡迎訊息、關鍵字、Twitch、物流排程
│       └── logger/             # 成員、訊息、身分組、語音紀錄
├── util/                       # 外部 API、Minecraft 與物流資料邏輯
├── config_example/             # 可提交的完整設定範本
├── config/                     # 實際設定（不納入版本控制）
└── assets/
    ├── images/                 # 靜態圖片
    └── packageTracking/        # 每位使用者的物流 JSON（不納入版本控制）
```

## 架構與載入流程

1. `index.js` 載入設定與共用工具，建立 Discord `Client`。
2. `loadModules('./src/modules')` 遞迴 `require` 所有 `.js`，並以 `module(client)` 註冊事件。
3. `loadCommands('./src/commands')` 遞迴載入指令，將 `data` 放入待註冊清單、將指令放入 `client.commands`。
4. REST API 以 `Routes.applicationCommands(clientID)` 覆寫全域指令清單。
5. `interactionCreate` 依序分派 Slash Command、Modal、Button 與 String Select Menu。
6. Client ready 後設定 Hitokoto 活動狀態；Twitch 與物流模組也在 ready 後啟動各自的輪詢排程。

程式大量使用 `process.cwd()` 與相對路徑，因此工作目錄必須是儲存庫根目錄。載入器沒有功能開關：放進 `src/modules/` 或 `src/commands/` 的每個 `.js` 都會被執行；個別模組是否啟用應由設定與模組本身控制。

## 擴充方式

### 新增指令

在 `src/commands/`（或其子目錄）建立 CommonJS 模組：

```js
const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('範例')
        .setDescription('範例指令'),
    async execute(interaction) {
        await interaction.reply('Hello!');
    }
};
```

若指令包含互動元件，可在同一個匯出物件加入：

- `modalSubmitHandlers`
- `buttonHandlers`
- `componentHandlers`（String Select Menu）

各欄位皆為 `{ [customId]: async interaction => {} }`。分派器也支援 `customId:payload`，會先找完整 ID，再退回冒號前的 handler 名稱。Modal handlers 會合併到 Client；不同指令應避免使用相同 Modal `customId`。

### 新增事件模組

在 `src/modules/` 下匯出接收 Client 的函式：

```js
const { Events } = require('discord.js');

module.exports = client => {
    client.on(Events.MessageCreate, async message => {
        // 處理事件
    });
};
```

需要設定時，將可公開的預設欄位同步加入 `config_example/`，並由 `core/config.js` 匯出的 `config`、`configCommands` 或 `configModules` 讀取。共用 Discord 回覆優先使用 `core/Reply.js`，操作與錯誤紀錄使用 `core/sendLog.js`。

## 資料與外部服務

| 功能 | 服務／位置 | 注意事項 |
| --- | --- | --- |
| 活動狀態、一言 | `https://v1.hitokoto.cn` | 啟動時無法取得只會記錄錯誤 |
| IP 查詢 | `http://ip-api.com` | 第三方服務限制與隱私政策由服務方決定 |
| Minecraft 狀態 | `https://api.mcsrvstat.us` | 伺服器圖示會短暫寫入專案根目錄，指令完成後清理 |
| Minecraft 外觀 | Minotar | 由指令組合遠端圖片網址 |
| 物流追蹤 | `https://track.tw/api/v1` | Token 存於 YAML；本機狀態存於 `assets/packageTracking/<userID>.json` |
| Twitch 通知 | Twitch OAuth／Helix API | 憑證存於 YAML；模組以記憶體維護當次執行狀態 |

部署物流功能時，`assets/packageTracking/` 必須可寫且需納入獨立備份；該目錄不會進入 Git。多個 Bot 程序共用同一目錄也沒有檔案鎖定機制，不建議以多程序模式執行。

## 開發與驗證現況

目前 `package.json` 沒有 `start`、lint 或可用的自動測試腳本；`npm test` 會刻意以錯誤結束。變更至少應進行：

```bash
# 檢查所有 JavaScript 語法
find . -path ./node_modules -prune -o -name '*.js' -print -exec node --check {} \;

# 使用測試 Bot／測試伺服器從根目錄啟動，驗證事件與互動
node index.js
```

啟動會連線 Discord、覆寫全域指令並啟動排程，不應將它當成無副作用的本機語法測試。開發新功能時，也請同步更新設定範本與本 README 的功能、資料或外部服務說明。

## 授權

原始碼採 [MIT License](LICENSE) 授權。
