const axios = require('axios');
const OpenCC = require('opencc-js');

// 請求短句 API
const getHitokoto = async () => {
    try {
        const response = await axios.get('https://v1.hitokoto.cn/?c=a&encode=json');
        const { hitokoto, from } = response.data;

        // 使用 OpenCC 將簡體中文轉為繁體中文
        const converter = OpenCC.Converter({ from: 'cn', to: 'twp' });
        const hitokotoText = converter(hitokoto);
        const hitokotoFrom = converter(from);

        return { hitokotoText, hitokotoFrom };
    } catch (error) {
        throw new Error(error.message);
    }
};

module.exports = { getHitokoto };