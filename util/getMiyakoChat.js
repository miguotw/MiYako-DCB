const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');
const { config } = require(path.join(process.cwd(), 'core/config'));

// 導入設定檔內容
const API_key = config.API.Deepseek.API_key;
const PROMPT = config.Commands.Miyako_Chat.prompt;


// 初始化 OpenAI 客戶端
const openai = new OpenAI({
    baseURL: 'https://api.deepseek.com',
    apiKey: API_key,
});

// 定義保存對話歷史的資料夾路徑
const CHAT_HISTORY_DIR = path.join(process.cwd(), 'assets', 'miyako_chat');

// 確保資料夾存在
if (!fs.existsSync(CHAT_HISTORY_DIR)) {
    fs.mkdirSync(CHAT_HISTORY_DIR, { recursive: true });
}

/**
 * 獲取用戶的對話歷史
 * @param {string} userId - 用戶的唯一識別符
 * @returns {Array} - 用戶的對話歷史
 */
const getChatHistory = (userId) => {
    const filePath = path.join(CHAT_HISTORY_DIR, `${userId}.json`);
    if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(data);
    }
    return [];
};

/**
 * 保存用戶的對話歷史
 * @param {string} userId - 用戶的唯一識別符
 * @param {Array} chatHistory - 用戶的對話歷史
 */
const saveChatHistory = (userId, chatHistory) => {
    const filePath = path.join(CHAT_HISTORY_DIR, `${userId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(chatHistory, null, 2), 'utf8');
};

/**
 * 匯出用戶的對話歷史
 * @param {string} userId - 用戶的唯一識別符
 * @returns {string} - 對話歷史的檔案路徑
 */
const exportChatHistory = (userId) => {
    const filePath = path.join(CHAT_HISTORY_DIR, `${userId}.json`);
    if (fs.existsSync(filePath)) {
        return filePath;
    }
    throw new Error('找不到該用戶的聊天歷史紀錄');
};

/**
 * 刪除用戶的對話歷史
 * @param {string} userId - 用戶的唯一識別符
 */
const deleteChatHistory = (userId) => {
    const filePath = path.join(CHAT_HISTORY_DIR, `${userId}.json`);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    } else {
        throw new Error('找不到該用戶的聊天歷史紀錄');
    }
};

/**
 * 與 Deepseek AI 進行聊天（支援上下文）
 * @param {string} userId - 用戶的唯一識別符（例如 Discord 用戶 ID）
 * @param {string} message - 用戶輸入的訊息
 * @returns {Promise<string>} - Deepseek AI 的回應
 */
const chatWithDeepseek = async (userId, message) => {
    try {
        // 獲取該用戶的對話歷史
        const chatHistory = getChatHistory(userId);

        // 如果是第一次對話，添加系統提示詞
        if (chatHistory.length === 0) {
            chatHistory.push({ role: "system", content: PROMPT });
        }

        // 將用戶的新訊息加入對話歷史
        chatHistory.push({ role: "user", content: message });

        // 調用 Deepseek API
        const completion = await openai.chat.completions.create({
            messages: chatHistory, // 傳遞完整的對話歷史
            model: "deepseek-chat", // 使用的模型
        });

        // 獲取 AI 的回應
        const aiResponse = completion.choices[0].message.content;

        // 將 AI 的回應加入對話歷史
        chatHistory.push({ role: "assistant", content: aiResponse });

        // 保存用戶的對話歷史
        saveChatHistory(userId, chatHistory);

        // 返回 AI 的回應
        return aiResponse;
    } catch (error) {
        throw new Error(error.message);
    }
};

module.exports = { chatWithDeepseek, exportChatHistory, deleteChatHistory };