# MiYako-DCB

MiYako-DCB 是以 discord.js 建立的繁體中文 Discord Bot。現行版本將設定驗證、互動路由、排程、程序生命週期與 JSON 持久層拆成可獨立測試的元件，並以單一 Node.js 程序執行。

## 功能概覽

公開 Slash Commands：

- `/關於みやこ`、`/一言`、`/網際協定位址資訊`、`/麥塊`、`/延遲`、`/時間戳`
- `/音樂`：點播、插播、暫停、跳過、序列管理及重啟快照恢復
- `/物流追蹤`：新增、查詢、更新、封存、喚醒及刪除包裹

管理功能集中在設定的管理指令名稱下，包含公告、訊息刪除、用戶資料、資料收集、抽選、臨時語音與 Twitch 通知。另有關鍵字回應、成員生命週期、活動狀態與四種 Discord 事件 logger。

## 執行環境與安裝

- Linux/POSIX
- Node.js `22.12.0`；版本固定於 `.nvmrc`
- 單一 Node.js 程序；不支援 PM2 cluster、多程序或多主機共同寫入
- Discord Application 的 Bot Token、Application ID 與所需 Gateway Intents

安裝時使用 lockfile 重現相同依賴：

```bash
nvm use
npm ci
```

`ffmpeg-static` 會安裝目前平台適用的 FFmpeg。yt-dlp 不由 npm 管理；音樂功能首次需要時會下載 Linux binary 至 `runtime/bin/yt-dlp`，之後依設定週期檢查更新。`music.ytDlpPath` 已移除，若設定檔仍含此舊鍵，strict schema 會拒絕啟動。

## 設定檔

從範例建立三份設定：

```bash
cp -R config_example config
chmod 600 config/config.yml config/configCommands.yml config/configModules.yml
```

填入部署環境的 Token、Discord ID、頻道與功能設定後再啟動。三份 YAML 都採 strict schema；未知鍵、舊式大小寫鍵、錯誤 Snowflake、URL、色碼、Discord enum、長度、範圍或跨欄位關係都會使啟動失敗。POSIX 上三份實際設定必須精確為 `0600`，程式不會自動修改權限。

設定路徑預設為專案根目錄的 `config/`。可用 `MIYAKO_CONFIG_DIR` 指定其他目錄；相對路徑仍以專案根目錄解析，不受啟動 CWD 影響。

重要容量設定：

- `packageTracking.maxActivePackages`：每位使用者 active 加 reserved 包裹上限，預設 20，範圍 1–100。
- `music.maxQueueTracks`：每個 Guild 的序列上限。
- `music.maxFileSizeMiB`：單一下載檔案上限。
- `music.maxCacheSizeMiB`：整體音樂 cache 上限，必須不小於單檔上限。

Twitch Client ID／Secret 必須同時有值或同時空白。兩者全空時只停用 Twitch 輪詢；Track.TW token 空白時只停用物流背景輪詢，對應指令會回報尚未設定。

## 啟動與指令部署

Bot runtime 與 Application Commands 發布是兩個獨立流程：

```bash
# 只建立 runtime 並登入 Bot，不發布指令
npm start

# 發布全域指令
npm run deploy:commands -- --scope global

# 發布單一測試伺服器指令
npm run deploy:commands -- --scope guild --guild-id 123456789012345678
```

部署 CLI 嚴格驗證 scope 與參數；guild scope 必須提供 Guild ID，global scope 不接受 Guild ID。guild deploy 不會自動刪除 global commands。部署流程只建立 enabled manifest 的 command catalog，不建立 Discord Client、不登入、不啟動 feature 或 scheduler；REST 失敗會以非零狀態結束。

## 專案結構

```text
.
├── index.js                     # runtime 入口與 signal lifecycle
├── core/
│   ├── config.js                # YAML 載入、strict schema 與專案固定路徑
│   ├── router.js                # Slash／Button／Modal／Select exact/prefix 路由
│   ├── scheduler.js             # interval 與 deadline scheduler
│   ├── runtime.js               # 啟動 rollback 與 graceful shutdown
│   ├── http.js                  # timeout、retry、Retry-After 與 AbortSignal
│   ├── processManager.js        # 子程序與 POSIX process group 終止
│   ├── jsonRepository.js        # 原子 JSON repository
│   ├── storeRegistry.js         # 所有 runtime repository 的唯一入口
│   └── Reply.js                 # 統一成功、驗證與未知錯誤回覆
├── src/
│   ├── features/                # manifest、command、interaction 與 feature lifecycle
│   ├── commands/                # Slash Command controller 與 views
│   └── modules/                 # event controller、scheduler job 與 logger
├── util/                        # 功能 repository、service、view、player 與 adapter
├── scripts/
│   ├── deployCommands.js        # 獨立指令發布 CLI
│   └── verifyCoverage.js        # 完整 coverage gate
├── test/                        # node:test 單元、整合、smoke 與 lifecycle 測試
├── config_example/              # 無 secret 的 strict 設定範例
└── runtime/                     # 執行期資料；完全忽略於 Git
```

## 架構與不變量

### Config、Manifest 與 Router

`loadConfig()` 一次載入三份 YAML，回傳 `{ startup, log, embed, emoji, commands, modules }`。runtime 與 deploy 都使用 enabled feature manifests 產生相同 command catalog；manifest 的 `start(context)`／`stop(context)` 擁有自己的 controller 與週期工作。

固定 context 為：

```text
{ client, config, logger, router, http, store, scheduler, processManager, signal }
```

Router 對 Slash、Modal、Button 與所有 Select 分別維護 exact/prefix Map。prefix 只匹配 `prefix:<非空 payload>`；啟動時會拒絕重複 route、namespace 覆蓋與 admin/public 衝突。管理員權限由 Router 統一檢查，Discord default permissions 只作介面 gate。未知、過期或關機中的互動會立即收到私密 validation Embed。

### JSON repository

`core/jsonRepository.js` 提供非同步 `read`、`write`、`update`、`listKeys`：

- 每個 key 使用獨立 mutex，並行更新不會遺失。
- envelope 固定為 `{ schemaVersion, updatedAt, data }`。
- 寫入同目錄 UUID 暫存檔，flush、close 後 atomic rename；目錄與檔案權限分別為 `0700`、`0600`。
- key 只能是安全的單一路徑片段。
- 壞 JSON、錯誤 envelope 或版本不符會先建立 blocked marker，再移至 `.quarantine/`。
- blocked key 的所有讀寫都會拋出 `RepositoryBlockedError`，不會自動遷移或解除封鎖。

Store registry 的資料位置：

```text
runtime/data/package-tracking/<ownerId>.json
runtime/data/twitch/<guildId>.json
runtime/data/raffle/<guildId>.json
runtime/data/data-collection/<guildId>.json
runtime/data/temporary-voice/<guildId>.json
runtime/data/music/queues/<guildId>.json
runtime/data/music/panels/<guildId>.json
```

### Scheduler、HTTP 與 shutdown

Interval scheduler 每輪 awaited 完成後才排下一輪，手動 trigger 在工作中只合併一個 pending run。失敗由 5 秒開始倍增退避，成功重設；timeout 使用 AbortSignal。不合作的工作在取消寬限後標記 stuck 並停用，舊工作未結束前不會啟動新工作。

Deadline scheduler 用於抽選、資料收集、臨時語音刪除及其他持久截止狀態。抽選會先原子保存固定 winners；資料收集會先保存 pending-sync，再更新 Discord。重啟只重送同一結果，不重新抽選。

SIGINT 與 SIGTERM 共用一個冪等 shutdown promise，依序停止 Router、取消 HTTP、停止 scheduler、終止程序樹、flush 音樂快照、反向停止 features，最後 destroy Discord Client。總期限 20 秒；第二次 signal 或逾時會以失敗狀態強制結束。

### 音樂

- 每 Guild 一個準備流程、每 user 一個 pending request、全域最多兩個 yt-dlp child。
- 下載完成後重新驗證操作人仍在原 Guild 與原 voice channel。
- Voice connection 必須 Ready 才播放；generation token 防止舊事件控制新曲目。
- cache 位於 `runtime/cache/music/`，只刪除未被快照或下載流程引用的檔案。
- queue 與 panel snapshot 位於 `runtime/data/music/`；shutdown 先立即 flush，再關閉播放器並保留 queue/cache。
- yt-dlp 位於 `runtime/bin/yt-dlp`，由 process manager 套用 timeout、取消、bounded output 與完整程序樹終止。

### 物流、Twitch 與臨時語音

物流以 owner ID 與 package ID 直接定位。active 加 reserved 不得超過設定上限；匯入或喚醒會在遠端 I/O 前原子保留名額，失敗則釋放。降低上限不會刪除既有資料，但超額使用者在降回上限以下前不能新增或喚醒。通知採 persisted outbox，新通知成功後才提交 signature 與 locator。

Twitch OAuth token provider 與 Helix client 使用共用 HTTP policy；Helix ID 每批最多 100 筆，401 最多失效 token 並重取一次。沒有角色或角色遺失時不提及任何人，絕不退回 `@everyone`。移除訂閱只更新該 Guild 的舊通知與 locator。

臨時語音對每個受管頻道使用 mutex 與持久化 generation。刪除前重新讀取 repository、抓取成員並比對 generation；成員返回會使舊 deadline 失效。暫時性 Discord 錯誤會退避，未知頻道視為已刪除。

## 執行期路徑與 legacy 資料

現行版本只讀寫：

- 持久資料：`runtime/data/`
- 音樂 cache：`runtime/cache/music/`
- yt-dlp binary：`runtime/bin/yt-dlp`
- Minecraft 暫存：`runtime/tmp/minecraft/`
- Minecraft 預設靜態圖示：專案根目錄的 `assets/minecraft/default_icon.png`

舊 `assets/` JSON、音樂 cache、binary 與功能 Store 是 legacy 資料；新版本不讀取、不搬移也不刪除。只有 Minecraft 的版本控制內預設圖示仍是靜態 asset，路徑由 `PROJECT_ROOT` 解析，不受 CWD 影響。

## 資料備份與恢復

一致性備份前必須先 graceful shutdown，避免複製到跨多個 repository 操作的中間狀態。只需要備份 `runtime/data/`；`runtime/cache/`、`runtime/bin/` 與 `runtime/tmp/` 都可重建。

恢復流程：

1. 確認 Bot 已停止，且沒有其他程序會寫入 runtime。
2. 將備份恢復至專案根目錄的 `runtime/data/`。
3. 將所有資料目錄設為 `0700`，JSON 與 marker 檔設為 `0600`。
4. 啟動前檢查 `.quarantine/` 與 blocked marker。
5. 若 key 被封鎖，人工檢查 quarantine，恢復正確資料或移除原資料後，最後才刪除 marker。

程式不提供自動資料遷移或自動解除封鎖。禁止 PM2 cluster、Node cluster、多個 Bot 程序或多台主機共同寫入同一個 `runtime/data/`。

## 開發與驗證

常用命令：

```bash
npm test                 # 完整 node:test 測試
npm run lint             # ESLint flat config，全專案正確性檢查
npm run test:smoke       # 臨時設定下 require 全部 production modules
npm run test:coverage    # 整體與核心模組 coverage gate
npm run check            # 依序執行 lint 與完整 coverage gate
```

Coverage 明確包含 `index.js`、`core/`、`src/`、`util/`、`scripts/` 的全部 production JavaScript：整體 line ≥80%、function ≥80%、branch ≥70%；`core/router.js`、`core/Reply.js`、`core/jsonRepository.js`、`core/config.js` 各自 line ≥90%。smoke test 攔截 Discord login、REST PUT 與外部 HTTP，import-time side effect 會使測試失敗。

`.github/workflows/ci.yml` 在 `ubuntu-latest` 使用 `.nvmrc`、唯讀 repository 權限與 npm cache，依序執行 `npm ci` 和 `npm run check`。CI 不提供 secrets 或 `config/`，測試不得登入 Discord、發布指令或呼叫真實第三方 API。

### 開發 checklist

- 修改前先搜尋 `core/`、`util/` 與既有 controller/view，優先重用共用能力。
- 新設定同步修改 strict schema、`config_example/`、測試與 README。
- 新 runtime 資料同步修改 store registry、測試、備份與恢復說明。
- Command 與 interaction handler 維持 `(interaction, context)`，不得重新引入全域 config、`client.commands` 或動態 client 屬性。
- 成功、驗證與未知錯誤使用 `infoReply`、`validationReply`、`errorReply`；功能內容與進度可使用專用 Embed。
- 中文註釋只解釋原因、不變量與補償流程，不逐行重述程式碼。
- 提交前執行 `npm run check`；依賴變更必須同步提交 `package-lock.json`。

## 授權

MIT
