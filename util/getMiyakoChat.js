const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');
const { configUtil } = require(path.join(process.cwd(), 'core/config'));

// 導入設定檔內容
const PROMPT = configUtil.getMiyakoChat.prompt;
const MEXLENGTH = configUtil.getMiyakoChat.mexLength;

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
 * @param {string} modelKey - 選擇的模型鍵值
 * @returns {Promise<string>} - Deepseek AI 的回應
 */
const chatWithDeepseek = async (userId, message, modelKey = '01') => {
    try {
        // 獲取完整對話歷史
        let chatHistory = getChatHistory(userId);

        // 1. 確保 system 提示詞存在於歷史記錄開頭
        if (chatHistory.length === 0 || chatHistory[0].role !== "system") {
            chatHistory = [{ role: "system", content: PROMPT }, ...chatHistory];
        }

        // 2. 過濾出用戶與助理的對話對
        const conversationPairs = [];
        let currentPair = { user: null, assistant: null };

        // 反向遍歷歷史紀錄，組合成對話對
        for (let i = chatHistory.length - 1; i >= 0; i--) {
            const entry = chatHistory[i];
            
            if (entry.role === "user") {
                currentPair.user = entry;
            } else if (entry.role === "assistant") {
                currentPair.assistant = entry;
            }

            // 當配對完成時存入陣列並重置
            if (currentPair.user && currentPair.assistant) {
                conversationPairs.unshift({ 
                    user: currentPair.user, 
                    assistant: currentPair.assistant 
                });
                currentPair = { user: null, assistant: null };

                // 達到 MEXLENGTH 時停止
                if (conversationPairs.length >= MEXLENGTH) break;
            }
        }

        // 3. 構建最終要發送的訊息序列
        const messagesToSend = [chatHistory[0]]; // 包含 system 訊息

        // 展開對話對到訊息序列
        conversationPairs.forEach(pair => {
            messagesToSend.push(pair.user);
            messagesToSend.push(pair.assistant);
        });

        // 4. 加入最新用戶訊息
        messagesToSend.push({ role: "user", content: message });

        // 5. 根據選擇的模型初始化 OpenAI 客戶端
        const models = configUtil.getMiyakoChat.models;
        const selectedModel = models[modelKey];
        const openai = new OpenAI({
            baseURL: selectedModel.baseURL,
            apiKey: selectedModel.apiKey,
        });

        // 6. 調用 API
        const completion = await openai.chat.completions.create({
            messages: messagesToSend,
            model: selectedModel.name
        });

        // 7. 保存完整歷史紀錄（包含最新互動）
        chatHistory.push({ role: "user", content: message });
        chatHistory.push({ role: "assistant", content: completion.choices[0].message.content });
        saveChatHistory(userId, chatHistory);

        return completion.choices[0].message.content;
    } catch (error) {
        throw new Error(error.message);
    }
};

/**
 * 更新用戶的系統提示詞
 * @param {string} userId - 用戶的唯一識別符
 * @param {string} newPrompt - 新的系統提示詞
 */
const updateSystemPrompt = (userId, newPrompt) => {
    let chatHistory = getChatHistory(userId);
    if (chatHistory.length === 0 || chatHistory[0].role !== "system") {
        // 若不存在則在最前面插入
        chatHistory.unshift({ role: "system", content: newPrompt });
    } else {
        // 更新現有的系統提示詞
        chatHistory[0].content = newPrompt;
    }
    saveChatHistory(userId, chatHistory);
};

module.exports = { chatWithDeepseek, exportChatHistory, deleteChatHistory, updateSystemPrompt, getChatHistory };