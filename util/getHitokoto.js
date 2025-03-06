const path = require('path');
const axios = require('axios');
const OpenCC = require('opencc-js');
const { config } = require(path.join(process.cwd(), 'core/config'));

// 導入設定檔內容
const HITOKOTO = config.API.Hitokoto;

// 請求短句 API
const getHitokoto = async () => {
    try {
        const response = await axios.get(HITOKOTO);
        const { hitokoto, from } = response.data;

        // 使用 OpenCC 將簡體中文轉為繁體中文
        const converter = OpenCC.Converter({ from: 'cn', to: 'twp' });
        const hitokotoText = converter(hitokoto);
        const hitokotoFrom = converter(from);

        return { hitokotoText, hitokotoFrom };
    } catch (error) {
        throw new Error(`無法獲取 Hitokoto API 資料：${error.message}`);
    }
};

module.exports = { getHitokoto };