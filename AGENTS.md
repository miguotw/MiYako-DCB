# AGENTS.md

本文件適用於整個儲存庫，供後續 Codex 工作階段安全地修改與驗證專案。若未來子目錄出現更具體的 `AGENTS.md` 或 `AGENTS.override.md`，該子目錄以較接近的規範為準。

## 專案概述

- MiYako-DCB 是以 `discord.js` 建立的繁體中文 Discord Bot，採單一 Node.js 程序與 CommonJS。
- `index.js` 只建立 runtime、登入 Discord 並處理 SIGINT/SIGTERM；Slash Command 發布與撤銷由獨立腳本處理。
- 設定、manifest/catalog、Router、scheduler、HTTP、子程序與 JSON persistence 都是可注入、可獨立測試的元件。
- 功能持久資料只存於專案根目錄的 `runtime/`；舊 `assets/` 功能資料不讀取、不搬移、不刪除。

## 重要目錄與檔案

- `index.js`：runtime 入口與 signal lifecycle。
- `core/`：共用基礎設施。修改前優先閱讀 `config.js`、`commandCatalog.js`、`router.js`、`runtime.js`、`scheduler.js`、`http.js`、`processManager.js`、`jsonRepository.js`、`storeRegistry.js`、`Reply.js` 與 `sendLog.js`。
- `src/features/`：功能 manifest 與 lifecycle 組裝；`src/features/index.js` 是 runtime/deploy 共用的 feature catalog 來源。
- `src/commands/`：Slash Command、Button、Modal、Select controller 與 Discord view。
- `src/modules/event/`、`src/modules/logger/`：listener、reconcile、週期／deadline 工作與背景日誌。
- `util/`：功能 repository、service、view、player 與外部 adapter。
- `scripts/`：command deploy/undeploy 與 coverage gate；模組被 require 時不得有外部副作用。
- `test/`：Node 內建 test runner 的單元、整合、lifecycle、concurrency 與 smoke 測試。
- `config_example/`：可提交的 strict YAML 範例；`config/` 是忽略且含憑證的部署設定。
- `runtime/`：忽略的持久資料、cache、binary 與暫存檔。
- `assets/minecraft/default_icon.png`：目前唯一受版本控制且仍被 production 使用的靜態 asset；其餘 legacy assets 視為使用者資料。

## 執行環境、套件與命令

- 目標環境是 Linux/POSIX；`.nvmrc` 固定 Node.js `22.12.0`，`package.json` 要求 `>=22.12.0`。
- 套件管理器是 npm；`package-lock.json` 為 lockfileVersion 3。安裝使用 `npm ci`，不要以未鎖定安裝取代 CI 流程。
- `.npmrc` 的 `omit=peer` 與 `package.json` 的 `undici` override 是現有依賴／安全決策；變更前必須說明影響並驗證 dependency tree 與 audit。

可用命令均來自 `package.json`：

```bash
npm ci
npm start
npm test
npm run lint
npm run test:smoke
npm run test:coverage
npm run check
npm run deploy:global
npm run deploy:guild
npm run undeploy:global
npm run undeploy:guild
```

- `npm start` 會登入 Discord 並可能啟動外部工作；只在使用者明確要求且已確認安全設定時執行。
- 四個 command deploy/undeploy 指令都不接受參數；guild 入口使用選填的 `startup.guildId`。deploy 會以單次 PUT 取代固定 scope 的 command catalog；undeploy 會 PUT 空陣列。兩者都會改變真實 Discord 狀態，不得作為一般驗證命令。
- 儲存庫沒有 build、dev-server 或格式化 script，也沒有 Prettier、TypeScript、Docker 或資料庫設定；不要捏造對應流程。

## 程式碼風格與命名

- 使用 CommonJS：`require(...)` 與 `module.exports`；production module 必須可安全 require，不得在 import time 登入、發布指令或呼叫外部 HTTP。
- 遵循鄰近檔案的四空格縮排、分號與換行方式。ESLint 未規定引號或 formatter；不要做無關的全檔格式化。
- 一般變數、函式與設定鍵使用 camelCase；class/error/builder 類型使用 PascalCase；模組常數使用 `UPPER_SNAKE_CASE`。
- Factory 採 `createX`；feature 匯出 `createManifest(config)`；事件模組通常匯出 `createInitializer(config)`；command 匯出 `createCommand(config)`。
- 未使用但為介面保留的參數以 `_` 開頭，符合 ESLint 規則。
- Discord、Guild、channel、message、user 與 repository key 的 ID 在持久層邊界正規化為字串。
- 現有檔名同時包含 camelCase、snake_case 與歷史名稱（例如 `Reply.js`）；新增檔案跟隨所在目錄慣例，不做批次改名。
- 中文註釋只說明原因、不變量、競態或補償流程，不逐行重述程式碼。

## 模組與架構邊界

- `loadConfig()` 一次載入三份 YAML，回傳 `{ startup, log, embed, emoji, commands, modules }`；production 不得使用測試專用的 config cache reset。
- Runtime 與 deploy 必須透過 `createFeatureManifests(config)` 和 `buildCommandCatalog(...)` 共用 enabled catalog。不要在 `index.js` 或 deploy script 建立第二份指令清單。
- Feature manifest 的原子邊界是 `{ name, enabled, intents, commands, interactions, start, stop }`；listener、scheduler 與 controller 由擁有它的 feature 啟停。
- 固定 runtime context 是 `{ client, config, logger, router, http, store, scheduler, processManager, signal }`。Command 與 interaction handler 維持 `(interaction, context)`，不得依賴全域 config、`client.commands` 或新的動態 client 屬性。
- Router 統一處理 admin gate。Interaction descriptor 使用 exact/prefix namespace；新增或修改 customId 時必須同步檢查 `src/features/factory.js` 的 `PREFIX_ROUTES`／`EXACT_VARIANTS` 與 Router 衝突測試。Prefix 只匹配 `prefix:<非空 payload>`。
- 管理指令由 catalog 聚合成設定的 `/admin` 名稱。Slash 結構或 enable toggle 改變後需要重新 deploy，但除非使用者明確要求，不得實際發布。
- Feature 停用時不得留下 command、component route、listener、scheduler、background poll 或額外 Gateway Intent。
- 功能資料透過 `context.store` 與 `util/*Repository.js` 存取。不要讓 command 直接讀寫 JSON 檔或重新使用 legacy `assets/` store。
- `jsonRepository.update(key, updater)` 的 updater 必須同步且只修改資料；Discord、HTTP、timer 或其他外部 I/O 不得放在 repository mutex 內。
- 第三方 HTTP 優先使用 `context.http`／`core/http.js`，保留 timeout、GET-only retry、Retry-After 與 AbortSignal。外部程序透過 `context.processManager`，不得繞過其 timeout、bounded output 與程序樹終止。
- 週期與截止工作使用中央 scheduler；保持 awaited、single-flight、trigger coalescing、取消寬限、stuck 停用與退避語意，不以裸 `setInterval` 取代。

## 設定、環境變數與執行資料

- 唯一由 production 讀取的環境變數是 `MIYAKO_CONFIG_DIR`。相對值仍以專案根目錄解析；沒有已確認的 `.env` loader。
- `core/config.js` 使用 Zod strict schema。選填的 `startup.guildId` 只供 guild command deploy/undeploy 使用，runtime 不依賴它。新增或修改設定時，同步更新 schema、`config_example/`、config tests，以及受影響的 README 說明。
- 不得讀取、列印、修改或提交 `config/` 中的 token、secret、ID 或部署值；除非使用者明確授權針對本機設定的操作。POSIX 上三份實際 YAML 必須精確為 `0600`。
- 測試一律透過 `MIYAKO_CONFIG_DIR` 使用由 `test/helpers/configFixture.js` 建立的臨時 `0600` fixture，不得讀真實設定。
- `runtime/data/` 是唯一持久資料來源；repository 目錄／檔案權限為 `0700`／`0600`。cache、binary、tmp 可重建，但仍不得在一般修改中任意清除。
- 壞 repository 會建立 blocked marker 並移入 `.quarantine/`。解除封鎖與資料遷移只能人工處理；不要新增靜默修復、覆寫或自動 migration。
- 只支援單一 Node.js writer。不得引入 PM2 cluster、Node cluster 或多主機共同寫入同一 `runtime/data/`。

## 錯誤處理、日誌與非同步規則

- 互動成功、可預期驗證錯誤與未知錯誤分別使用 `infoReply`、`validationReply`、`errorReply`；內容面板、查詢結果與播放進度可使用專用 Embed。
- 使用者輸入錯誤應標記 `isValidationError` 或直接走 validation，不建立系統事件 ID，也不寫 ERROR 日誌。
- `errorReply()` 是互動系統錯誤的唯一 ERROR 記錄入口；command catch 或 Router 不得先重複 `sendLog`。沒有 interaction 的背景工作才自行記錄。
- 日誌必須走 `sendLog`／runtime logger，以沿用 secret、Discord token 與控制字元遮罩。物流單號、IP 或其他執行期敏感值用 `sensitiveValues` 顯式傳入；不得輸出憑證或完整使用者資料。
- Discord mention 必須用明確 `allowedMentions` 白名單；找不到角色時不可退回 `@everyone`。
- 影響狀態的外部 I/O 要 await，並在已有介面中傳遞 AbortSignal。刻意背景觸發的 Promise 必須明確處理 rejection 並由 feature/scheduler lifecycle 擁有；取消、timeout 與 shutdown 不得留下失控工作或啟動重疊工作。
- 涉及遠端操作與本機資料的流程要保留補償語意，例如 package reservation/outbox、deadline persisted state、notification locator 與音樂 snapshot；不要把遠端 I/O 移進 mutex。
- Runtime shutdown 順序是 Router → HTTP abort → scheduler → process tree → music snapshot → 等待 in-flight feature start → reverse feature stop → music players → Router detach → Client destroy。修改 lifecycle 時必須保留冪等、rollback 與 20 秒總期限測試。

## 測試與驗證要求

- 修改前找出對應測試；開發時先跑最小相關測試，再跑維護門檻。
- 提交或交付 production JavaScript 變更前至少執行 `npm run check`。它會跑 ESLint、全部 production coverage 與核心個別 gate。
- `npm test` 是一次完整 `node:test` 執行；`npm run test:smoke` 用於驗證所有 production module 無 import-time side effect。入口、scripts、module discovery 或依賴載入變更時要明確執行 smoke。
- Coverage 門檻不可透過排除 production 檔案規避：整體 line/function/branch 分別至少 80%/80%/70%；`core/config.js`、`core/router.js`、`core/Reply.js`、`core/jsonRepository.js` 各自 line 至少 90%。
- 外部 HTTP、Discord Client/REST、clock、filesystem root 與 child process 使用 fake/injected dependency；測試不得登入 Discord、發布／撤銷指令或呼叫真實第三方 API。
- Config 變更測 strict/default/permission/path；Router/manifest 變更測 namespace、access、enabled catalog/intents；repository 與 scheduler 變更測 concurrency、rollback、abort、timeout、retry 與 idempotent stop。
- Dependency/lockfile 變更需執行 `npm ci`、`npm ls --depth=0`，並在可連線時執行 `npm audit`；不得未經評估直接執行可能造成大版本變動的 `npm audit fix`。
- 若驗證因 sandbox、網路、憑證或平台限制無法執行，最終回覆必須列出未執行命令、原因與剩餘風險，不得宣稱已通過。

## 修改完成標準

- 行為變更有對應成功、驗證失敗、未知錯誤及必要 concurrency/lifecycle 測試。
- Config example、README、catalog/routes、store registry 或備份說明已隨實際介面同步；不相關文件不要順手改寫。
- `npm run check` 與所有適用的額外測試通過，`git diff --check` 無 whitespace error。
- 工作樹只包含本任務授權的變更，沒有 secret、runtime 資料、cache、binary、quarantine 或 legacy user data。
- 最終回覆列出修改檔案、行為變化、實際驗證結果及仍存在的風險；不要只回報「完成」。

## 禁止事項與高風險區域

- 修改前先閱讀實作、呼叫端、manifest 與測試，不得只依檔名猜測。
- 未經要求不得做無關的大規模重構、批次改名、格式化、依賴升級或資料格式變更。
- 不得刪除看似未使用但尚未查清 import、manifest、dynamic route、snapshot 或 migration 用途的程式碼／資料。
- 不得修改或提交密鑰、憑證、真實設定、使用者資料、`runtime/` 或忽略的 legacy assets。
- 新增 production dependency 前先說明現有能力為何不足、套件用途、runtime/security 影響；獲准後同步更新 lockfile。
- 不得在一般驗證中執行 `npm start`、deploy、undeploy、真實 API、yt-dlp 下載或會寫入正式資料的操作。
- 高風險修改包括：Router exact/prefix namespace、admin aggregate、Gateway Intents、runtime shutdown 順序、scheduler single-flight、JSON envelope/quarantine、package reservation/outbox、music generation/cache/snapshot、Twitch OAuth/mentions、deadline reconcile、temporary voice generation。修改時必須先讀取其專用測試與補償流程。

## Codex 工作流程

1. 先讀本文件、`git status`、相關設定、實作、呼叫端與測試；使用 `rg` 搜尋共用能力及所有引用。
2. 確認行為邊界與資料所有權，再提出最小修改方案。優先沿用既有 factory、context、Reply、HTTP、scheduler、process manager 與 repository。
3. 保留使用者既有工作樹變更；若範圍重疊且無法安全整合，先回報，不得覆寫。
4. 只修改任務需要的檔案；不要因鄰近程式碼較舊而擴張成未授權重構。
5. 以 fake dependency 補測並執行最小相關測試；完成後執行適用的完整 gate。
6. 重讀 diff，檢查 lifecycle、access、customId、資料格式、secret、外部副作用與文件是否一致。
7. 若本文件與程式碼實況衝突，指出具體檔案與差異；不得把推測當作規範。詳細架構若持續增長，可建議另建 `docs/ARCHITECTURE.md`，但不要自行建立。

## Git 與提交

- 修改前後檢查 `git status`；不要清除、reset、revert 或重寫不屬於本任務的變更。
- `package-lock.json` 已受版本控制；依賴變更必須與 `package.json` 同步提交。
- `config/`、`runtime/`、`.env` 與多數 legacy `assets/` 已忽略；不得使用 force-add。受追蹤的 Minecraft 預設圖示是例外。
- 只有使用者明確要求時才建立 commit 或 push；不要自行改寫歷史或執行 destructive Git 命令。
- 待確認：儲存庫沒有 CONTRIBUTING、Git hook 或一致的 branch／commit message／release 規範；不要自行宣稱採用 Conventional Commits。

## 待確認事項

- npm 精確版本未在 `package.json` 鎖定；只確認 Node 版本與 npm lockfile 格式。
- 未提供 systemd、PM2、container 或其他正式部署服務設定；只確認 Linux/POSIX 與單程序限制。
