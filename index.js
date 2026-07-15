global.crypto = require('node:crypto');

const { createRuntime } = require('./core/runtime');

function forceExit(error, {
    exit = code => process.exit(code),
    log = value => console.error(value)
} = {}) {
    log(error);
    process.exitCode = 1;
    exit(1);
}

async function main({
    runtime = createRuntime(),
    processApi = process,
    forceExitFn = forceExit
} = {}) {
    let signalCount = 0;

    const onSignal = signal => {
        signalCount += 1;
        if (signalCount > 1) {
            processApi.exitCode = 1;
            processApi.exit(1);
            return;
        }
        runtime.shutdown(new Error(`收到 ${signal}，開始 graceful shutdown。`))
            .then(() => {
                processApi.exitCode = 0;
                processApi.off('SIGINT', onSigint);
                processApi.off('SIGTERM', onSigterm);
            })
            .catch(error => forceExitFn(error));
    };

    const onSigint = () => onSignal('SIGINT');
    const onSigterm = () => onSignal('SIGTERM');
    processApi.on('SIGINT', onSigint);
    processApi.on('SIGTERM', onSigterm);
    await runtime.start();
    return runtime;
}

if (require.main === module) {
    main().catch(error => forceExit(error));
}

module.exports = { forceExit, main };
