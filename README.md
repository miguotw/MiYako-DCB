# MiYako-DCB

みやこ機器人第三代！本專案目前仍在積極開發中！

## 🔰 功能介紹

這是一個基於 discord.js 集合許多功能的綜合型機器人，目前集合了以下功能

- **斜線指令**
  - 發送公告：發送公告到指定頻道並提及指定身分組
  - 刪除訊息：批量刪除訊息
  - 直播通知：發送自定義直播通知
  - 一言：傳送隨機語句（使用 [Hitokoto API](https://hitokoto.cn/)）
  - 麥塊：查詢 Minecraft 伺服器狀態，或查詢 Minecraft 玩家的外觀
  - 網際協定位址資訊：取得 IP 位址的詳細資訊
  - 與みやこ聊天：透過 AI 語言模型與みやこ聊天
  - > 更多有趣功能可在部屬後查看

- **事件活動：** 成員 加入/離開 伺服器時，自動在「系統訊息頻道」傳送隨機訊息

- **日誌紀錄：** 記錄伺服器成員的以下操作
  - 成員 加入/離開 伺服器
  - 成員 發送/變更/刪除 訊息
  - 成員 新增/移除 身分組
  - 成員 加入/離開 語音頻道

## 🚀 使用方式

**推薦使用 [Node JS](https://nodejs.org/) (`v18`)**

1. **Clone 儲存庫：** 將本儲存庫 clone 到本地

    ```bash
    git clone https://github.com/miguotw/MiYako-DCB.git
    ```

2. **設定配置文件：** 填妥 `config_example.yml` 所有空缺項目，並將其重新命名為 `config.yml`

4. **安裝依賴項目：** 在終端輸入以下指令以安裝必要依賴項目

    ```bash
    npm install
    ```

5. **啟動機器人：** 在終端輸入以下指令以啟動機器人

    ```bash
    node index.js
    ```

6. **完成！** 您可以將機器人部屬到本地或雲端主機！

## 📜 授權

本專案採用 [MIT 授權](LICENSE)