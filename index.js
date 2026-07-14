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

async function main() {
    const runtime = createRuntime();
    let signalCount = 0;

    const onSignal = signal => {
        signalCount += 1;
        if (signalCount > 1) {
            process.exitCode = 1;
            process.exit(1);
        }
        runtime.shutdown(new Error(`收到 ${signal}，開始 graceful shutdown。`))
            .then(() => {
                process.exitCode = 0;
                process.off('SIGINT', onSigint);
                process.off('SIGTERM', onSigterm);
            })
            .catch(error => forceExit(error));
    };

    const onSigint = () => onSignal('SIGINT');
    const onSigterm = () => onSignal('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    await runtime.start();
    return runtime;
}

if (require.main === module) {
    main().catch(error => forceExit(error));
}

module.exports = { forceExit, main };
