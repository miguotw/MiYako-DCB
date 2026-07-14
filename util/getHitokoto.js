const OpenCC = require('opencc-js');
const { http } = require('../core/http');

/** 透過共用 timeout／retry policy 取得一言並轉換成台灣繁體。 */
const getHitokoto = async ({ http: httpClient = http, signal } = {}) => {
    try {
        const response = await httpClient.get('https://v1.hitokoto.cn/?c=a&encode=json', { signal });
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
