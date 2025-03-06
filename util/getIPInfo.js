const axios = require('axios');

// 請求 IP 位址資訊 API
const getIPInfo = async (address) => {
    try {
        const response = await axios.get(`http://ip-api.com/json/${address}?fields=status,message,country,city,isp,as,mobile,proxy,hosting`);
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