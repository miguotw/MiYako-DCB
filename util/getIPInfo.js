const net = require('net');
const { http } = require('../core/http');

/** 驗證並查詢單一 IPv4／IPv6；hostname 不可進入明文 HTTP provider。 */
const getIPInfo = async (address) => {
    const normalizedAddress = String(address || '').trim();
    if (!net.isIP(normalizedAddress)) throw new Error('請輸入有效的 IPv4 或 IPv6 位址。');
    try {
        const response = await http.get(`http://ip-api.com/json/${encodeURIComponent(normalizedAddress)}?fields=status,message,country,city,isp,as,mobile,proxy,hosting`);
        const {status, message, country, city, isp, as, mobile, proxy, hosting } = response.data;
        
        // 如果 API 返回錯誤狀態
        if (status === 'fail') {
            throw new Error(message);
        }

        const IPInfoMobile = mobile ? '是' : '否';
        const IPInfoHosting = hosting ? '是' : '否';
        const IPInfoProxy = proxy ? '是' : '否';
        const IPInfoCountry = country;
        const IPInfoCity = city;
        const IPInfoISP = isp;
        const IPInfoAS = as;

        return { IPInfoMobile, IPInfoHosting, IPInfoProxy, IPInfoCountry, IPInfoCity, IPInfoISP, IPInfoAS };
    } catch (error) {
        throw new Error(error.message);
    }
};

module.exports = { getIPInfo };
