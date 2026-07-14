# MiYako-DCB

MiYako-DCB（みやこ機器人第三代）是以 [discord.js](https://discord.js.org/) v14 製作的多功能 Discord Bot。專案使用 CommonJS、單一 Node.js 程序與本機 JSON 持久化；功能由 manifest 載入，Bot runtime 與 Application Commands 發布已完全分離。

這份文件同時是部署說明與後續需求的專案基礎知識。開始修改前，至少先閱讀「架構與載入流程」、「強制開發規範」和「共用工具索引」。

> [!IMPORTANT]
> - 執行期資料目前仍以儲存庫根目錄為基準；設定檔則固定由專案根目錄解析，測試可用 `MIYAKO_CONFIG_DIR` 覆寫。
> - 除指令本身用來呈現功能內容的 Embed 外，成功、失敗、驗證不通過與執行錯誤等狀態消息，一律使用 `core/Reply.js` 的樣式，以 Embed 回覆。
> - 新增解析器、資料存取、API adapter、view builder 或播放器邏輯前，必須先搜尋 `util/`；已有能力應直接重用或擴充，不得重複實作。
> - 新增設定欄位時同步更新 `config_example/`；新增或改變功能時同步更新測試與本文件。

## 功能概覽

### Slash Commands

| 指令 | 功能 | 備註 |
| --- | --- | --- |
| `/關於みやこ` | 顯示 Bot、維護者與伺服器資訊 | 名稱中的暱稱來自 `about.botNickname` |
| `/延遲` | 顯示 Discord WebSocket 延遲 |  |
| `/一言` | 取得隨機動漫短句 | Hitokoto API，並轉為台灣繁體用語 |
| `/時間戳` | 產生現在或指定時間的 Discord 時間戳 | 指定時間透過 Modal 輸入 |
| `/網際協定位址資訊` | 查詢 IPv4／IPv6 資訊 | ip-api.com |
| `/麥塊` | 查詢 Minecraft 玩家外觀或伺服器狀態 | Minotar、mcsrvstat.us |
| `/物流追蹤` | 新增、更新、封存與追蹤包裹 | 需要 Track.TW API Token |
| `/音樂 管理面板` | YouTube 點播、插播、暫停、跳過與序列管理 | 使用 yt-dlp、FFmpeg 與 Discord 語音 |
| `/admin 發送公告` | 將既有訊息製成公告並發至指定頻道 | 管理員功能 |
| `/admin 擷取用戶資料` | 依 ID、提及或 Username 查詢用戶 | 管理員功能 |
| `/admin 刪除訊息` | 批次或逐筆刪除訊息 | 管理員功能 |
| `/admin 直播通知 新增／移除` | 管理 Twitch 直播通知 | 管理員功能 |
| `/admin 臨時語音頻道 新增／移除` | 管理加入後自動建立專屬頻道的語音入口 | 管理員功能 |
| `/admin 抽選系統` | 建立到期後可自動開獎的抽選公告 | 管理員建立，一般用戶操作公開按鈕 |
| `/admin 資料收集` | 建立白名單限定、可覆寫提交的資料收集面板 | 管理員建立，一般用戶操作公開按鈕 |

`/admin` 是 `config.yml` 的 `startup.adminCommandName` 預設值，可依部署環境更名，因此程式不得硬編碼管理指令路徑。

### 自動事件與日誌

- 在伺服器系統頻道發送成員加入／離開 Embed。
- 依設定的關鍵字回覆訊息或加入 Reaction，支援頻道白名單／黑名單語意與冷卻時間。
- 將成員、訊息、身分組與語音活動寫入終端及指定 Discord 日誌頻道。
- 定時檢查 Twitch 直播與包裹貨態，發送或更新通知。
- 定時關閉到期抽選、資料收集面板，並處理重啟期間錯過的項目。
- 建立及回復臨時語音頻道管理，空置逾時後自動刪除受管頻道。
- 檢查音樂依賴、維護語音狀態，並從本機快照恢復未完成的播放序列。

## 執行環境與安裝

### 必要環境

- Node.js `>=22.12.0`；`.nvmrc` 固定為 `22.12.0`。
- npm。
- Discord Bot Token 與 Application ID。
- 視啟用功能需要：Twitch Developer 憑證、Track.TW API Token。

Bot 依啟用的 feature 推導 Gateway Intents；預設完整功能使用 `Guilds`、`GuildMessages`、`MessageContent`、`GuildMembers`、`GuildVoiceStates`。請在 Discord Developer Portal 啟用 **Server Members Intent** 與 **Message Content Intent**。

邀請 Bot 時需依功能授予檢視頻道、讀取歷史訊息、發送訊息、嵌入連結、附加檔案、加入／發言於語音頻道、管理訊息等權限。臨時語音功能另需管理頻道與移動成員權限。

### 安裝

```bash
git clone https://github.com/miguotw/MiYako-DCB.git
cd MiYako-DCB
nvm use
npm install
cp -R config_example config
chmod 600 config/config.yml config/configCommands.yml config/configModules.yml
```

接著編輯 `config/` 內三份 YAML。先發布 Slash Commands：

```bash
npm run deploy:commands -- --scope guild --guild-id <測試伺服器ID>
# 或正式發布至全域
npm run deploy:commands -- --scope global
```

再啟動只負責登入與執行功能的 Bot runtime：

```bash
npm start
```

`npm start` 不會新增、更新或刪除 Application Commands。`npm install` 會由 `ffmpeg-static` 安裝符合平台與架構的 FFmpeg；請勿跨平台複製 `node_modules`。

音樂模組首次啟動會下載 yt-dlp 至 `assets/music/yt-dlp`，並定期執行更新檢查。內建下載網址目前是 Linux binary；非 Linux 部署應先準備相容的 yt-dlp 執行檔，並以 `configCommands.yml` 的 `music.ytDlpPath` 指向它。`assets/music/` 必須可寫。

全域發布可能不會立即出現在所有伺服器；開發時優先使用 guild scope。部署 CLI 僅更新指定 scope，不會登入 Bot 或啟動排程。

## 設定檔

實際設定位於被 `.gitignore` 排除的 `config/`，可提交的預設範本位於 `config_example/`：

| 檔案 | 內容 |
| --- | --- |
| `config.yml` | Token、Application ID、管理指令名稱、Bot 狀態、日誌、共用 Embed 顏色與 Emoji |
| `configCommands.yml` | 各 Slash Command、音樂、Twitch、Track.TW 與其他第三方服務設定 |
| `configModules.yml` | 成員事件、訊息／身分組／語音日誌、關鍵字規則、臨時語音清理時間 |

`core/config.js` 會從專案根目錄一次讀取、以 Zod 驗證三份 YAML，並合併為 `{ startup, log, embed, emoji, commands, modules }`：

- 所有區段與鍵使用 camelCase，未知鍵、錯誤型別及超界值會拒絕啟動。
- POSIX 上三份檔案權限必須精確為 `0600`。
- 測試使用 `MIYAKO_CONFIG_DIR` 指向臨時 fixture，不讀取真正 secrets。
- 修改設定後必須重新啟動程序。
- 新增設定時必須同時提供安全、可理解的 `config_example/` 預設值與註解。
- `config/`、Token、API Token 與 Secret 不得提交；專案目前沒有從 `.env` 載入設定。

## 專案結構

```text
MiYako-DCB/
├── .nvmrc                         # 開發用 Node.js 版本
├── index.js                       # Runtime entrypoint 與 signal handler
├── core/
│   ├── config.js                  # Zod 設定載入與 0600 檢查
│   ├── runtime.js                 # Client 啟動、回滾與 graceful shutdown
│   ├── router.js                  # O(1) Interaction registries
│   ├── scheduler.js               # 可取消、無重疊的共用排程器
│   ├── Reply.js                   # 統一成功／失敗／錯誤狀態 Embed
│   ├── commandPolicy.js           # 管理指令聚合、權限政策與動態路徑
│   └── sendLog.js                 # 終端與 Discord 頻道日誌
├── src/
│   ├── features/                  # Manifest、Intents 與功能生命週期
│   ├── commands/                  # 一般 Slash Commands
│   │   └── admin/                 # 聚合到可設定的 /admin 根指令
│   └── modules/
│       ├── event/                 # 業務事件、ready 初始化與排程
│       └── logger/                # 成員、訊息、身分組與語音紀錄
├── util/                          # 共用解析、API、Store、View 與狀態機
├── test/                          # Node 內建 test runner 測試
├── config_example/                # 可提交的完整設定範本
├── config/                        # 實際設定，不納入版本控制
└── assets/
    ├── minecraft/                 # 預設圖示與狀態查詢暫存圖示
    ├── music/                     # yt-dlp、音訊 cache、序列快照、面板索引
    ├── packageTracking/           # 每位使用者的物流資料
    ├── twitch_stream/             # 每個伺服器的訂閱與通知狀態
    ├── temporaryVoice/            # 每個伺服器的入口與受管頻道
    ├── raffle/                    # 每個伺服器的抽選資料
    └── dataCollection/            # 每個伺服器的資料收集與提交內容
```

除 `assets/minecraft/default_icon.png` 外，上述執行期資料大多不納入 Git。`assets/music/guilds/` 目前沒有程式碼引用，不是現行資料格式。

## 架構與載入流程

1. `loadConfig()` 由專案根目錄讀取並嚴格驗證設定。
2. Feature manifests 宣告 commands、interaction descriptors、Intents、`start()` 與 `stop()`。
3. Command catalog 在建立 Client 前檢查重複名稱與 handler namespace 衝突，並聚合 `/admin`。
4. Runtime 以 enabled manifests 的最小 Intents 建立 Client，中央 Router 以 O(1) registry 分派 Slash、Modal、Button 與 Select。
5. Client ready 後依序啟動 features；任何啟動錯誤會反向停止已啟動功能。
6. SIGINT／SIGTERM 會停止新互動、取消 HTTP、停止 scheduler、終止子程序樹、保存音樂快照，再反向停止 features、關閉語音與 Discord Client。

### 指令模組契約

一般指令以 factory 接收已驗證設定，避免在 module scope 讀取真實設定：

```js
function createCommand(config) {
    return {
        data: new SlashCommandBuilder()
            .setName('範例')
            .setDescription('範例指令'),
        async execute(interaction, context) {
            // 指令處理
        }
    };
}

module.exports = { createCommand };
```

既有 command 模組仍可匯出下列 handler map，由 feature manifest 轉成中央 Router descriptor：

| 欄位 | 互動類型 |
| --- | --- |
| `modalSubmitHandlers` | Modal submit |
| `buttonHandlers` | Button |
| `componentHandlers` | String Select Menu |

新功能應直接在 manifest 宣告 `{ kind, id, match: 'exact'|'prefix', access: 'public'|'admin', execute }`。Prefix 只匹配 `id:<非空 payload>`；同 interaction 類型的重複、exact/prefix 覆蓋或 admin/public namespace 衝突都會讓啟動失敗。

### 管理指令政策

`core/commandCatalog.js` 對管理指令套用下列規則；`core/commandPolicy.js` 只負責依設定組合顯示路徑：

- 沒有子指令的模組聚合成 `/<adminName> <command>`。
- 已包含子指令的模組聚合成 `/<adminName> <group> <subcommand>`，只允許一層子指令。
- 自動禁止私訊、設定 Discord 預設 Administrator 權限，並在執行 `execute`、Modal、Button、Select handler 前再次驗證管理員資格。
- 管理功能建立的公開面板若要讓一般用戶操作，只能明確匯出 `publicButtonHandlers` 或 `publicModalSubmitHandlers`；公開 handler 必須自行驗證使用者資格與資料狀態。
- 日誌或文字中的管理指令路徑使用 `getAdminCommandPath()` 組合，不得硬編碼 `/admin`。

## 強制開發規範

### 使用者狀態回覆一律使用 `core/Reply.js`

指令本身的查詢結果、公告、管理面板、播放面板與下載進度屬功能內容，可以建立專用 Embed。除此之外，向使用者表示下列狀態時必須使用共用樣式：

- 操作成功。
- 業務失敗或找不到資料。
- 輸入驗證不通過或權限不足。
- 執行過程發生錯誤。

標準 Interaction 回覆：

```js
const { createReplyTools } = require('../../core/Reply');

function createCommand(config) {
    const { errorReply, infoReply, validationReply } = createReplyTools(config);
    return {
        async execute(interaction, context) {
            try {
                if (!isValid) return validationReply(interaction, '**設定內容不正確。**', { ephemeral: true });
                return infoReply(interaction, '**設定已儲存。**');
            } catch (error) {
                return errorReply(interaction, error, { context: '儲存設定' });
            }
        }
    };
}
```

共用 API：

| API | 用途 |
| --- | --- |
| `infoReply(interaction, message, options?)` | 成功狀態；標題固定為「操作成功」 |
| `validationReply(interaction, message, options?)` | 可預期的輸入、權限、過期狀態與業務失敗 |
| `errorReply(interaction, error, options?)` | 未知系統錯誤；原始 Error 只進入遮罩日誌，使用者只看到事件 ID |
| `createStatusEmbed({ status, message, eventId })` | 建立 `success`、`validation` 或 `error` 狀態 Embed |

需要元件的狀態回覆仍應使用 builder，而不是重新製作樣式：

```js
const { createReplyTools } = require('../../core/Reply');
const { infoReply } = createReplyTools(config);

return infoReply(interaction, '**設定已移除。**', {
    method: 'update',
    content: null,
    components: []
});
```

樣式來源是執行期的 `config/config.yml`，可提交的預設值定義在 `config_example/config.yml`：

| 設定鍵 | 用途 |
| --- | --- |
| `embed.color.default` | 指令功能本身的一般 Embed |
| `embed.color.success` | `success`／`infoReply` |
| `embed.color.error` | `validation`、`error`／對應 Reply helper |
| `emoji.success` | 成功標題 Emoji |
| `emoji.error` | 錯誤標題 Emoji |
| `emoji.loading` | 功能本身的載入／進度顯示 |

不得在新程式中用純文字回覆成功／失敗／錯誤，也不得自行建立這些狀態的 `EmbedBuilder`、硬編碼顏色或 Emoji。

Reply 的互動生命週期注意事項：

- `options.method` 支援 `auto`、`reply`、`editReply`、`update`、`followUp`；`auto` 在未回覆時使用 `reply`，已 defer/reply 時使用 `editReply`。
- 私密耗時操作必須在一開始 `deferReply({ ephemeral: true })`；defer 後才傳入 `ephemeral` 無法改變可見性。
- `options` 可傳 `content`、`files`、`components`、`ephemeral` 與日誌用 `context`；`ephemeral` 只能搭配 `reply`／`followUp`。
- 元件 `deferUpdate()` 後若驗證失敗，必須使用 `{ method: 'followUp', ephemeral: true }`，不得覆寫原公開訊息。
- 預期錯誤使用 `validationReply`；未知例外把原始 `Error` 傳給 `errorReply`，不得把 `error.message` 拼入公開訊息。
- Reply 傳送失敗會寫入遮罩日誌並重新拋出，呼叫端與測試都能觀察，不得以空 `catch` 吞掉。

### 日誌與第三方 HTTP 安全規則

- `sendLog(client, message, level, error, { sensitiveValues })` 會清理控制字元、code fence 與 Token；物流單號、IP 等執行期敏感值必須透過 `sensitiveValues` 明確宣告。
- Discord 日誌一律使用 `allowedMentions: { parse: [] }`，訊息中的 `@everyone`、用戶或身分組文字不可實際觸發 mention。
- Bot 直接呼叫的第三方 HTTP API 一律使用 `core/http.js`：單次 15 秒 timeout；GET 只對網路錯誤、408、429、5xx 額外重試兩次；POST／PATCH 不自動重試。

### 優先重用 `util/`，拒絕重複造輪子

開始實作前先以 `rg` 搜尋 `util/` 與 `core/`。若能力已存在，直接引用；若僅缺少通用的一小部分，擴充原模組並補測試，不要在新指令內複製一份。

尤其是「每個 Guild 一份 JSON」的功能，一律優先使用 `util/guildJsonStore.js` 的 `createGuildJsonStore({ directory, createEmpty, normalize })`。它已統一處理 Guild ID 驗證、資料正規化、目錄建立、讀寫、列舉，以及 temporary file + rename 的原子替換。

## 共用工具索引

| 模組 | 已有能力；新增功能應優先使用 |
| --- | --- |
| `core/http.js` | 第三方 HTTP 15 秒 timeout、GET 限定重試與 `Retry-After` 處理 |
| `discordCommandInput.js` | Discord API timeout、截止時間解析、用戶／身分組提及、訊息 ID／官方連結解析與抓取、將身分組展開為真人成員 |
| `guildJsonStore.js` | 通用 per-guild JSON Store factory：`getFile`、`listGuildIDs`、`read`、`update`、`write` |
| `dataCollectionStore.js` | 資料收集 CRUD、全域尋找／列舉、同一 collection 的程序內 Promise lock |
| `dataCollectionViews.js` | 白名單提及分批、公開／管理 Embed、內容清理與分頁、管理面板同步／刪除 |
| `raffleStore.js` | 抽選 CRUD、列舉、去重後使用 `crypto.randomInt` 抽出得獎者 |
| `raffleViews.js` | 抽選公告 Embed 與參加／取消按鈕 |
| `temporaryVoiceStore.js` | 入口與受管頻道的 per-guild 新增、更新、移除與恢復資料 |
| `twitchStreamStore.js` | Twitch 訂閱、通知訊息與 stream 狀態的 per-guild 持久化 |
| `getPackageTracking.js` | Track.TW adapter、per-user Store、carrier／貨態工具、物流 Embed 與元件 builder |
| `getHitokoto.js` | Hitokoto API 與 OpenCC 簡體轉台灣繁體 |
| `getIPInfo.js` | ip-api IP 資訊查詢 |
| `getServerStatus.js` | Minecraft 狀態查詢、回應清理、錯誤診斷與伺服器圖示暫存 |
| `musicHelpers.js` | yt-dlp 輸入、Track 正規化／驗證、時間、進度條與序列分頁等純函式 |
| `ytDlpManager.js` | 安全 spawn、yt-dlp 下載／節流更新、metadata／播放清單、音訊下載清理、FFmpeg 檢查與錯誤重試 |
| `musicPlayer.js` | Per-guild 語音連線與播放器狀態機、序列、暫停／跳過、恢復、閒置退出與 UI hooks |
| `musicQueueStore.js` | 每個 Guild 的播放快照原子儲存、全域載入與刪除 |
| `musicPanelStore.js` | 每個 Guild 最新音樂面板的 Discord ID 索引 |

跨功能輸入應先使用 `discordCommandInput.js`；跨功能資料模式應先使用 `guildJsonStore.js`。功能專用的 Store、View 與 API adapter 也應由 command/event 層呼叫，避免讓指令檔同時承擔 UI、網路、持久化與排程邏輯。

## 重要業務規則

### 截止時間、提及與公開面板

- `parseDeadline()` 先把 `yyyy-mm-dd hh:mm` 按 Node 程序的本機時區解析，再扣除 `config.yml` 的 `log.timezone` 小時作人工校正。程序與輸入皆為台灣時間時使用 `0`；程序是 UTC、輸入是台灣時間時使用 `+8`。
- 抽選與資料收集的用戶／身分組資格會在建立當下展開成真人成員快照；之後的成員或身分組異動不會回溯更新。展開身分組需要 Server Members Intent。
- 抽選和資料收集每 30 秒檢查一次；Bot 離線期間到期的現存資料會在重啟後補處理。
- 抽選白名單用戶無須參加、黑名單用戶不可參加，兩者不得重疊。自動抽選關閉時只停止登記，不產生得獎者。
- 資料收集允許重複提交並覆寫；資料保留至管理面板執行確認刪除。管理面板若送至伺服器頻道，該頻道的可見權限就是提交資料的可見範圍。

### 音樂

- 支援文字搜尋第一筆，以及 HTTPS 的 YouTube／youtu.be 單曲、Shorts、直播頁、Embed 與播放清單 URL；不支援直播內容。
- URL 必須使用精確 YouTube hostname，禁止帳密、自訂 port、redirect、localhost、IP、相似網域及其他 yt-dlp 網站；yt-dlp 固定忽略主機設定檔。
- 音訊先下載至 `assets/music/cache/` 再播放，完成、移除、跳過或失敗後清理；播放清單中任一曲目驗證或下載失敗會取消整批操作。
- 目前歌曲、秒數、點播者與待播序列會寫入 `assets/music/queues/<guildID>.json`。Bot 重啟或語音連線中斷後會嘗試重連，成功時自動繼續原先因斷線暫停的播放。
- 最新控制面板索引位於 `assets/music/panels.json`；新面板建立後，舊面板視為過期。
- 空序列或語音頻道沒有真人時會暫停／啟動閒置計時，超過 `music.inactivityTimeoutMinutes` 後退出並清理狀態。範例值為 5 分鐘。
- `music.volumePercent` 範例值為 20；程式缺少設定時的 fallback 是 50。`queueTitleMaxLength` 需介於 1～97，播放清單單次上限程式會限制在 1～100。
- 語音編碼優先使用 `@discordjs/opus`；原生 binary 不相容時可由 `opusscript` fallback。

### 臨時語音、物流與 Twitch

- 臨時語音入口可有各自前綴。真人加入後，Bot 在相同分類建立繼承入口權限的專屬頻道並移動成員；移除入口只停止建立新頻道，既有受管頻道仍會清理。
- Track.TW Token 未設定時物流背景監聽不啟動；資料按 Discord 使用者分檔，不是按 Guild 分檔。操作按鈕攜帶 package ID，handler 在 acknowledgement 前以點擊者 ID 核對 owner。
- Twitch Client ID／Secret 不完整時直播監聽不啟動；訂閱、Discord 通知位置與最近 stream 狀態會持久化，排程執行旗標才只存在記憶體。

## 資料與外部服務

| 功能 | 服務／資料位置 | 說明 |
| --- | --- | --- |
| 活動狀態、一言 | `https://v1.hitokoto.cn` | API 失敗會寫日誌，不阻止 Bot 啟動 |
| IP 查詢 | `http://ip-api.com` | 受第三方服務限制與隱私政策約束 |
| Minecraft 狀態 | `https://api.mcsrvstat.us`、`assets/minecraft/temp/` | 查詢圖示短暫落盤後清理 |
| Minecraft 外觀 | Minotar | 指令組合遠端圖片網址 |
| 物流追蹤 | `https://track.tw/api/v1`、`assets/packageTracking/<userID>.json` | Token 位於 YAML |
| Twitch | Twitch OAuth／Helix、`assets/twitch_stream/<guildID>.json` | 保存訂閱與通知狀態 |
| 音樂 | yt-dlp、ffmpeg-static、`assets/music/` | cache、queue snapshot、panel index 與 binary |
| 臨時語音 | `assets/temporaryVoice/<guildID>.json` | 入口、受管頻道與空置時間 |
| 抽選 | `assets/raffle/<guildID>.json` | 參加名單、資格與結果 |
| 資料收集 | `assets/dataCollection/<guildID>.json` | 白名單、欄位及可能含敏感資訊的提交內容 |

這些 JSON Store 沒有跨程序檔案鎖，部署模型應維持單一 Bot 程序。持久化目錄必須可寫，並應依資料重要性獨立備份；音樂 cache 與 Minecraft temp 則是可重建的暫存資料。

第三方 HTTP 每次嘗試均有 15 秒 timeout；GET 最多額外重試兩次並遵守最長 60 秒的 `Retry-After`。IP 查詢另限制每位使用者同時一筆、每分鐘五筆，且只接受 `net.isIP()` 驗證通過的位址。

## 新需求實作順序

1. 先用 `rg` 找出相近 command、event、core 與 util，確認資料格式、custom ID 與設定鍵。
2. 判斷變更應放在 command、event/logger、Store/API、View 或共用 helper，避免把所有邏輯堆進指令檔。
3. 直接重用或擴充既有 util；per-guild JSON 優先以 `createGuildJsonStore` 建立。
4. 指令功能內容使用自己的 Embed；所有成功、失敗、驗證與錯誤狀態使用 `core/Reply.js`。
5. 新互動 ID 加功能前綴；管理功能若開放公共按鈕／Modal，明確匯出 public handler 並自行驗證資格。
6. 新設定同步修改 `config_example/`，新持久化資料同步修改 `.gitignore`、備份說明與本文件。
7. 為純函式、解析、Store 正規化與重要狀態轉換補上 `node:test`，再執行完整驗證。

## 開發與驗證

常用 npm scripts：

```bash
npm start
npm run deploy:commands -- --scope guild --guild-id <ID>
npm test
```

目前測試涵蓋 Discord 輸入解析、Reply 生命週期、Logger 遮罩、HTTP retry、物流 owner 邊界、IP 限流、音樂 URL、共用 Store、抽選、資料收集、FFmpeg 與播放快照。安全回歸測試不連線 Discord 或真實第三方 API；完整 Discord 互動仍需測試 Bot／測試伺服器驗證。

專案沒有 lint 或 format script。變更至少執行：

```bash
# 所有 JavaScript 語法檢查
find . -path ./node_modules -prune -o -name '*.js' -print -exec node --check {} \;

# 單元測試
npm test
```

`npm start` 會連線 Discord 並啟動排程，但不會改動 Application Commands；發布指令仍須明確執行 `deploy:commands`。

## 授權

原始碼依根目錄 [MIT License](LICENSE) 授權。`package.json` 的 `license` metadata 目前仍標示 `ISC`，後續發布套件前應與 `LICENSE` 統一。`ffmpeg-static` 及其散布的 FFmpeg binary 採 GPL-3.0-or-later；重新散布 Bot 或打包後 binary 時需另外確認授權義務。
