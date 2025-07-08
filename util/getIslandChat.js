const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');
const { configCommands } = require(path.join(process.cwd(), 'core/config'));

// 導入設定檔內容
const CONTEXT_LIMIT = configCommands.islandChat.limit.context;
const SESSION_LIMIT = configCommands.islandChat.limit.session;
const BASE_URL = configCommands.islandChat.models.baseURL;
const API_KEY = configCommands.islandChat.models.apiKey;
const MODEL = configCommands.islandChat.models.name;
const ARCHIVE_PATH = path.join(process.cwd(), configCommands.islandChat.path.archive);
const PROMPT_PATH = configCommands.islandChat.path.prompt.map(p => path.join(process.cwd(), p));

// 會話計數器
const sessionCounters = new Map();

/**
 * 讀取並合併所有提示詞檔案
 * @returns {string} 合併後的提示詞內容
 */
const loadPrompts = () => {
    let combinedPrompt = '';
    
    for (const promptPath of PROMPT_PATH) {
        try {
            const content = fs.readFileSync(promptPath, 'utf8');
            combinedPrompt += `\n\n${content}`;
        } catch (error) {
            console.error(`無法讀取提示詞檔案: ${promptPath}`);
            throw new Error(`提示詞檔案讀取失敗: ${promptPath}`);
        }
    }
    
    return combinedPrompt.trim();
};

// 預先載入提示詞
const PROMPT = loadPrompts();

// 確保存檔資料夾存在
if (!fs.existsSync(ARCHIVE_PATH)) {
    fs.mkdirSync(ARCHIVE_PATH, { recursive: true });
}

/**
 * 獲取用戶的對話歷史
 * @param {string} userId - 用戶的唯一識別符
 * @returns {Array} - 用戶的對話歷史
 */
const getChatHistory = (userId) => {
    const filePath = path.join(ARCHIVE_PATH, `${userId}.json`);
    if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(data);
    }
    return [];
};

/**
 * 檢查並更新會話計數
 * @param {string} userId - 用戶ID
 * @returns {boolean} - 是否超過限制
 */
const checkSessionLimit = (userId) => {
    // 如果未設定限制則直接通過
    if (!SESSION_LIMIT || SESSION_LIMIT <= 0) return false;
    
    const count = sessionCounters.get(userId) || 0;
    if (count >= SESSION_LIMIT) {
        return true;
    }
    sessionCounters.set(userId, count + 1);
    return false;
};

/**
 * 重置會話計數
 * @param {string} userId - 用戶ID
 */
const resetSessionCounter = (userId) => {
    sessionCounters.delete(userId);
};

/**
 * 保存用戶的對話歷史
 * @param {string} userId - 用戶的唯一識別符
 * @param {Array} chatHistory - 用戶的對話歷史
 */
const saveChatHistory = (userId, chatHistory) => {
    const filePath = path.join(ARCHIVE_PATH, `${userId}.json`);
    // 過濾掉系統提示詞後再存檔
    const historyWithoutSystem = chatHistory.filter(msg => msg.role !== "system");
    fs.writeFileSync(filePath, JSON.stringify(historyWithoutSystem, null, 2), 'utf8');
};

/**
 * 與 AI 進行對話
 * @param {string} userId - 用戶的唯一識別符
 * @param {string} message - 用戶輸入的訊息
 * @returns {Promise<string>} - AI 的回應
 */
const chatWithAI = async (userId, message) => {
    try {
        // 檢查會話限制
        if (checkSessionLimit(userId)) {
            throw new Error(`已達到本工作階段對話次數上限 (${SESSION_LIMIT} 次)`);
        }

        // 獲取對話歷史（不包含系統提示詞）
        let chatHistory = getChatHistory(userId);

        // 準備完整的對話記錄（包含系統提示詞）
        let fullChatHistory = [{ role: "system", content: PROMPT }, ...chatHistory];

        // 限制歷史記錄長度
        if (fullChatHistory.length > CONTEXT_LIMIT * 2 + 1) {  // +1 是為了系統提示詞
            fullChatHistory = [
                fullChatHistory[0], // 保留系統提示
                ...fullChatHistory.slice(-CONTEXT_LIMIT * 2) // 保留最近的對話
            ];
        }

        // 添加用戶新訊息
        fullChatHistory.push({ role: "user", content: message });

        // 初始化 OpenAI 客戶端
        const openai = new OpenAI({
            apiKey: API_KEY,
            baseURL: BASE_URL
        });

        // 調用 API
        const completion = await openai.chat.completions.create({
            messages: fullChatHistory,
            model: MODEL
        });

        // 添加 AI 回應到歷史記錄
        const aiResponse = completion.choices[0].message.content;
        fullChatHistory.push({ role: "assistant", content: aiResponse });

        // 保存更新後的歷史記錄（不包含系統提示詞）
        saveChatHistory(userId, fullChatHistory);

        return aiResponse;
    } catch (error) {
        throw new Error(error.message);
    }
};

module.exports = { chatWithAI, getChatHistory, resetSessionCounter };
