const { createLogTools } = require('./sendLog');

/** 建立可在 Client 初始化前使用、登入後再接上 Discord log channel 的 logger。 */
function createLogger(config) {
    const { sendLog } = createLogTools(config);
    let client = null;
    return {
        attachClient(value) { client = value; },
        info(message, details) { return sendLog(client, message, 'INFO', details?.error); },
        warn(message, details) { return sendLog(client, message, 'WARN', details?.error); },
        error(message, errorOrDetails) {
            const error = errorOrDetails?.error || errorOrDetails;
            return sendLog(client, message, 'ERROR', error instanceof Error ? error : null);
        }
    };
}

module.exports = { createLogger };
