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
| `/物流追蹤` | 新增、更新、封存與追蹤包裹 | 需要 Track.TW Token；資料依使用者存於本機 |
| `/音樂 管理面板` | YouTube 點播、暫停、跳過及查看播放序列 | 使用 yt-dlp、ffmpeg-static 與 Discord 語音 |
| `/admin 發送公告` | 將既有訊息製成公告並傳至指定頻道 | 僅限伺服器管理員 |
| `/admin 擷取用戶資料` | 以 ID、提及或 Username 查詢用戶 | 僅限伺服器管理員 |
| `/admin 刪除訊息` | 批次或逐筆刪除訊息 | 僅限伺服器管理員 |
| `/admin 直播通知 新增／移除` | 管理 Twitch 直播通知 | 僅限伺服器管理員 |
| `/admin 臨時語音頻道 新增／移除` | 管理加入後自動建立專屬頻道的語音入口 | 僅限伺服器管理員 |
| `/admin 抽選系統` | 建立到期後自動開獎的抽選公告 | 僅限伺服器管理員建立 |
| `/admin 資料收集` | 建立白名單限定、可覆寫提交的資料收集面板 | 僅限伺服器管理員建立 |

### 自動事件與紀錄

- 在伺服器系統頻道發送成員加入／離開訊息。
- 依關鍵字回覆訊息或加入 Reaction，支援頻道白名單／黑名單語意與冷卻時間。
- 將成員、訊息、身分組及語音活動寫入指定 Discord 日誌頻道。
- 定時檢查 Twitch 直播、發送或更新直播通知。
- 定時檢查包裹貨態，通知使用者並自動封存長期無更新的包裹。
- 由管理員設定臨時語音入口，成員加入後建立專屬頻道，空置逾時自動刪除。

## 執行環境

- Node.js 22.12 或更新版本
- npm
- Discord Bot Token 與 Application ID
- 視功能需要：Twitch Developer 憑證、Track.TW API Token

Bot 建立時會要求下列 Gateway Intents：`Guilds`、`GuildMessages`、`MessageContent`、`GuildMembers`、`GuildVoiceStates`、`DirectMessages`。請在 Discord Developer Portal 的 Bot 頁面啟用 **Server Members Intent** 與 **Message Content Intent**；邀請 Bot 時也需授予其實際功能所需的檢視頻道、讀取歷史、發送訊息、嵌入連結、管理訊息等權限。臨時語音頻道功能另需檢視頻道、連線、管理頻道及移動成員權限。

## 安裝與啟動

```bash
git clone https://github.com/miguotw/MiYako-DCB.git
cd MiYako-DCB
npm install
cp -r config_example config
```

`npm install` 會透過 `ffmpeg-static` 下載目前作業系統與 CPU 架構適用的 FFmpeg；不需要另外安裝系統 FFmpeg。首次啟動會將官方 stable yt-dlp binary 下載到 `assets/music/yt-dlp`，該目錄必須可寫。請勿將 `node_modules` 跨平台複製，改在部署目標上重新執行 `npm install`。

編輯 `config/` 中的三份 YAML：

- `config.yml`：Token、Application ID、狀態、日誌頻道、Embed 顏色與共用 Emoji。
- `configCommands.yml`：各 Slash Command、Twitch 通知及第三方 API 的設定。
- `configModules.yml`：成員事件、訊息／身分組／語音紀錄、關鍵字規則，以及臨時語音頻道的空置刪除分鐘數。

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
│   │   └── admin/              # 自動限制為僅限伺服器管理員使用的指令
│   └── modules/
│       ├── event/              # 歡迎訊息、關鍵字、Twitch、物流排程
│       └── logger/             # 成員、訊息、身分組、語音紀錄
├── util/                       # 外部 API、Minecraft 與物流資料邏輯
├── config_example/             # 可提交的完整設定範本
├── config/                     # 實際設定（不納入版本控制）
└── assets/
    ├── minecraft/              # Minecraft 預設圖示與執行期暫存檔
    ├── music/                  # yt-dlp、音訊快取與最新面板狀態（不納入版本控制）
    ├── packageTracking/        # 每位使用者的物流 JSON（不納入版本控制）
    ├── raffle/                 # 每個伺服器的抽選名單與結果（不納入版本控制）
    ├── dataCollection/         # 每個伺服器的資料收集設定與提交內容（不納入版本控制）
    └── temporaryVoice/         # 每個伺服器的入口與受管頻道 JSON（不納入版本控制）
```

## 架構與載入流程

1. `index.js` 載入設定與共用工具，建立 Discord `Client`。
2. `loadModules('./src/modules')` 遞迴 `require` 所有 `.js`，並以 `module(client)` 註冊事件。
3. `loadCommands('./src/commands')` 遞迴載入指令，將 `data` 放入待註冊清單、將指令放入 `client.commands`。
4. REST API 以 `Routes.applicationCommands(clientID)` 覆寫全域指令清單。
5. `interactionCreate` 依序分派 Slash Command、Modal、Button 與 String Select Menu。
6. Client ready 後設定 Hitokoto 活動狀態；Twitch 與物流模組也在 ready 後啟動各自的輪詢排程。

程式大量使用 `process.cwd()` 與相對路徑，因此工作目錄必須是儲存庫根目錄。載入器沒有功能開關：放進 `src/modules/` 或 `src/commands/` 的每個 `.js` 都會被執行；個別模組是否啟用應由設定與模組本身控制。

`src/commands/admin/` 是管理指令聚合與權限政策目錄。載入器不會個別註冊其中的頂層指令，而會自動組合成 `/admin`：一般指令成為 `/admin <指令>`，原本已有子指令的模組成為 `/admin <指令群組> <子指令>`。`admin` 是 `config.yml` 內 `Startup.adminCommandName` 的預設值，可依部署需求變更；名稱需符合 Discord Slash Command 規則。管理指令的日誌路徑應以 `core/commandPolicy.js` 的 `getAdminCommandPath()` 組合，禁止硬編碼 `/admin`，讓設定變更能同步反映在指令註冊與日誌。聚合後的子指令名稱直接沿用模組 `data.name`，不套用額外別名。

聚合後會自動禁止私訊、將 Discord 預設成員權限設為 Administrator，並在執行 Slash Command、一般 Modal、Button 或 String Select Menu handler 前再次驗證管理員權限。需要讓一般用戶操作管理功能建立的面板時，模組可明確匯出 `publicButtonHandlers`／`publicModalSubmitHandlers`；這些公開 handler 必須自行驗證資格。將指令檔移入此目錄即可同時套用 `/admin` 命名與建立／管理權限限制。

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

需要設定時，將可公開的預設欄位同步加入 `config_example/`，並由 `core/config.js` 匯出的 `config`、`configCommands` 或 `configModules` 讀取。操作與錯誤紀錄使用 `core/sendLog.js`。

### 使用者回覆規範

除指令功能本身需要呈現的 Embed 外，所有向使用者表示**成功、失敗或錯誤**的訊息，都必須使用 `core/Reply.js` 提供的共用函式包裝成 Embed：

```js
const { errorReply, infoReply } = require(path.join(process.cwd(), 'core/Reply'));

await infoReply(interaction, '**操作已完成！**');
await errorReply(interaction, '**操作失敗，請稍後再試！**');
```

- 成功訊息使用 `infoReply(interaction, message, files?)`。
- 失敗、驗證不通過及執行錯誤使用 `errorReply(interaction, message, files?)`。
- 不要在個別指令中為這類狀態回覆自行建立 `EmbedBuilder`，也不要硬編碼其顏色或 Emoji。
- 共用樣式的顏色與 Emoji 由 `config.yml` 的 `embed.color.success`、`embed.color.error`、`emoji.success`、`emoji.error` 定義；新增或調整預設值時，必須同步更新 `config_example/config.yml`。
- `infoReply` 與 `errorReply` 已兼容尚未回覆、已 `deferReply()` 及已回覆的 Interaction，呼叫端不需自行切換 `reply()`／`editReply()`。

## 資料與外部服務

| 功能 | 服務／位置 | 注意事項 |
| --- | --- | --- |
| 活動狀態、一言 | `https://v1.hitokoto.cn` | 啟動時無法取得只會記錄錯誤 |
| IP 查詢 | `http://ip-api.com` | 第三方服務限制與隱私政策由服務方決定 |
| Minecraft 狀態 | `https://api.mcsrvstat.us` | 伺服器圖示會短暫寫入 `assets/minecraft/temp/`，指令完成後清理 |
| Minecraft 外觀 | Minotar | 由指令組合遠端圖片網址 |
| 物流追蹤 | `https://track.tw/api/v1` | Token 存於 YAML；本機狀態存於 `assets/packageTracking/<userID>.json` |
| Twitch 通知 | Twitch OAuth／Helix API | 憑證存於 YAML；模組以記憶體維護當次執行狀態 |
| YouTube 音樂 | yt-dlp、ffmpeg-static | FFmpeg 隨 npm 依賴安裝；yt-dlp 每 24 小時節流檢查 stable 更新，抽取失效時更新並重試一次 |
| 臨時語音頻道 | `assets/temporaryVoice/<guildID>.json` | 保存入口、受管頻道及空置起始時間，重啟後恢復管理 |
| 抽選系統 | `assets/raffle/<guildID>.json` | 保存參加名單與結果，重啟後補開 |
| 資料收集 | `assets/dataCollection/<guildID>.json` | 保存白名單、欄位與提交內容，含可能的敏感資料 |

部署物流功能時，`assets/packageTracking/` 必須可寫且需納入獨立備份；該目錄不會進入 Git。多個 Bot 程序共用同一目錄也沒有檔案鎖定機制，不建議以多程序模式執行。

`/admin 臨時語音頻道 新增` 可設定多個語音入口及個別前綴；省略前綴會清除該入口原有前綴。真人成員加入入口後，Bot 會在相同分類建立繼承入口權限的 `前綴暱稱` 頻道（前綴與暱稱直接相連）並移動成員。`/admin 臨時語音頻道 移除` 只停止入口建立新頻道，既有頻道仍會繼續管理。空頻道經 `configModules.yml` 的 `temporaryVoice.deleteAfterMinutes`（預設 5 分鐘）後刪除；入口與受管頻道資料會在 Bot 重啟後恢復。`assets/temporaryVoice/` 必須可寫並應獨立備份。

`/admin 抽選系統` 會從指定訊息建立公告。單一 `yyyy-mm-dd hh:mm` 截止時間先按 Node 程序的本機時區解析，再扣除 `config.yml` 的 `log.timezone` 小時作為人工校正：程序已在台灣時區時使用 `0`；程序使用 UTC、但管理員輸入台灣時間時使用 `+8`。若程序實際採用其他時區，校正量需依該程序時區與輸入時區的差值設定。公告只顯示相對倒數，footer 以「唯一 ID • 時間」呈現。一般用戶透過「參加/取消抽選」按鈕切換登記，公告會即時列出已登記用戶。白名單與黑名單只接受 `@用戶` 或 `@身分組`，建立時展開為當下的真人成員快照且不公開；使用身分組需要在 Discord Developer Portal 啟用 Server Members Intent。白名單用戶無須抽選，黑名單用戶不可參與，兩者不得重疊。截止後按鈕一律停用。啟用自動抽選時，「抽選人數」會標示「已啟用自動抽選」，每 30 秒排程會自動抽出中選者並直接更新原公告 Embed；停用時只關閉登記，不產生中選結果。Bot 離線期間逾期的活動會在重啟後補處理。公告更新成功後，該抽選 ID 會立即從 `assets/raffle/` 移除；若更新失敗則暫時保留供排程重試。若公告訊息或所在頻道已不存在，也會自動刪除該筆資料。

`/admin 資料收集` 會在指定頻道以一般訊息直接提及白名單中的 `@用戶`／`@身分組`，再建立公開提交面板；不會把身分組拆成多個用戶提及，名單過長時會依 Discord 訊息限制分批。「管理面板」必選參數可將含完整回答的管理分頁送到指令目前頻道或建立者私訊；選擇目前頻道時，頻道可見權限即為資料可見範圍，請只在私密管理頻道執行。私訊管理面板的刪除按鈕只允許建立者操作；伺服器頻道內則允許建立者或管理員操作。提交資格仍在建立時將身分組展開為成員快照。截止時間使用與抽選相同的主機本機時間及人工校正量，每 30 秒停用逾期按鈕。每個 Modal 欄位為必填單行文字；`configCommands.yml` 的 `dataCollection.titleMaxLength` 可設定資料標題上限（1～45），`submissionMaxLength` 可設定每欄提交上限（1～700），預設分別為 10 與 20。重複提交會覆寫，並嘗試私訊提交者副本。資料保存於 `assets/dataCollection/`，直到管理員在管理面板按下紅色刪除按鈕並於確認 Modal 輸入 `y`。公開面板在截止前遺失時會重新提及白名單並在原頻道重建；截止後遺失時不執行任何動作。任一管理分頁被刪除時，系統會停用公開提交按鈕、刪除其餘管理分頁與本機資料。

跨功能的 Discord 輸入解析集中於 `util/discordCommandInput.js`，包含訊息 ID／連結、提及與截止時間；每個 Guild 一份 JSON 的功能資料則優先使用 `util/guildJsonStore.js`，統一 Guild ID 驗證、資料正規化及暫存檔原子替換。新增相同類型功能時應擴充這些共用模組，避免重新複製解析或檔案讀寫流程。

## 開發與驗證現況

目前使用 Node 內建測試驗證音樂資料與 yt-dlp 更新策略，尚未提供 lint 腳本。變更至少應進行：

```bash
# 檢查所有 JavaScript 語法
find . -path ./node_modules -prune -o -name '*.js' -print -exec node --check {} \;

# 執行單元測試
npm test

# 使用測試 Bot／測試伺服器從根目錄啟動，驗證事件與互動
node index.js
```

啟動會連線 Discord、覆寫全域指令並啟動排程，不應將它當成無副作用的本機語法測試。開發新功能時，也請同步更新設定範本與本 README 的功能、資料或外部服務說明。

每個伺服器的目前歌曲、播放秒數、點播者與待播序列會分別保存於 `assets/music/queues/<guildID>.json`。Bot 重啟或語音連線意外中斷時，會驗證本機音訊檔、重新加入原語音頻道，並嘗試從最近保存的進度恢復；斷線後維持暫停，由使用者手動按「繼續」。斷線或語音頻道沒有真人使用者時會立即暫停並發送狀態 Embed。最新面板的位置保存於 `assets/music/panels.json`；新面板出現後，舊面板會被判定為過期。公開序列面板只顯示待播歌曲，可用僅顯示歌曲名稱的選單移除指定歌曲；清空所有待播序列時須在確認 Modal 輸入 `y`。點播時會先將音訊下載到 `assets/music/cache/` 再從本機播放，期間以 Embed 顯示目前曲目、播放清單項次及下載百分比；進度訊息最多每秒更新一次。檔案在播放完成、移除、跳過、失敗或正常清理時刪除。支援單一 YouTube 影片、文字搜尋第一筆，以及依設定決定是否展開播放清單；不支援直播。最後一首結束後會另發待命面板並保留舊面板的最終進度，Bot 會留在語音頻道；目前沒有離場或停止按鈕。

主面板的「插播」使用與點播相同的解析及下載流程，但會把歌曲放到待播序列最前方；插播播放清單時仍維持播放清單原有順序。

音樂設定可用 `minDurationMinutes`／`maxDurationMinutes` 限制單首長度（`0` 表示不限制），以 `allowPlaylists` 控制是否接受 YouTube 播放清單，並用 `maxPlaylistTracks` 限制一次最多取播放清單前幾首歌曲。播放清單內任一曲目不符合長度限制或下載失敗時，整批點播會取消。

`volumePercent` 設定送入 Discord 前的播放音量，可設定 `0`～`100`，預設為 `50`；超出範圍的設定會自動限制到最近的有效值。

`queueTitleMaxLength` 控制「接下來」、完整序列及移除選單中的歌曲標題最大字符數，預設為 `25`，可設定 `1`～`97`；超過時會截斷並附加 `...`。上限預留三個字符給省略號，以符合 Discord 選單標籤的 100 字符限制。

`ffmpeg-static` 套件及其發佈的 FFmpeg binary 採 GPL-3.0-or-later；重新散布 Bot 或打包後的 binary 時，請確認符合其授權條款。

語音編碼優先使用原生 `@discordjs/opus`；若目前 Node ABI 沒有可用的預編譯 binary，prism-media 會自動改用純 JavaScript 的 `opusscript`，避免重啟恢復播放時因原生模組不相容而中斷。

## 授權

原始碼採 [MIT License](LICENSE) 授權。
