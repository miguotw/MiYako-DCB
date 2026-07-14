const { Client, Events } = require('discord.js');
const { loadConfig } = require('./config');
const { buildCommandCatalog, registerCatalog } = require('./commandCatalog');
const { createHttpClient, setDefaultHttpClient } = require('./http');
const { createLogger } = require('./logger');
const { createProcessManager } = require('./processManager');
const { createInteractionRouter } = require('./router');
const { createScheduler } = require('./scheduler');
const { createStoreRegistry } = require('./storeRegistry');
const { createFeatureManifests } = require('../src/features');
const { snapshotAllGuildStates, shutdownAllPlayers } = require('../util/musicPlayer');

const DEFAULT_READY_TIMEOUT_MS = 30000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 20000;

function waitUntilReady(client, signal, timeoutMs = DEFAULT_READY_TIMEOUT_MS) {
    if (signal.aborted) return Promise.reject(signal.reason || new Error('啟動已取消。'));
    if (client.isReady?.()) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(reject, new Error(`Discord Client 在 ${timeoutMs} 毫秒內未 ready。`)), timeoutMs);
        const onReady = () => finish(resolve);
        const onAbort = () => finish(reject, signal.reason || new Error('啟動已取消。'));
        function finish(callback, value) {
            clearTimeout(timer);
            client.off(Events.ClientReady, onReady);
            signal.removeEventListener('abort', onAbort);
            callback(value);
        }
        client.once(Events.ClientReady, onReady);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * 建立可測試的 Bot runtime；建構本身不登入 Discord，也不發布 Slash Commands。
 * 所有外部工作共用同一 root AbortSignal，確保 shutdown 能先阻止新工作再逐層 drain。
 */
function createRuntime({
    config = loadConfig(),
    manifests = null,
    clientFactory = options => new Client(options),
    logger = createLogger(config),
    httpFactory = options => createHttpClient(options),
    schedulerFactory = options => createScheduler(options),
    processManagerFactory = options => createProcessManager(options),
    storeFactory = createStoreRegistry,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS
} = {}) {
    const controller = new AbortController();
    const http = httpFactory({ signal: controller.signal });
    setDefaultHttpClient(http);
    // Scheduler 與 process manager 由 runtime 依序顯式停止；不可綁 root signal，
    // 否則 HTTP abort 會讓兩者同時開始關閉而破壞 lifecycle 順序。
    const scheduler = schedulerFactory({ logger });
    const processManager = processManagerFactory();
    const store = storeFactory();
    const enabledManifests = manifests || createFeatureManifests(config);
    const catalog = buildCommandCatalog(enabledManifests, { adminCommandName: config.startup.adminCommandName });
    const router = createInteractionRouter({ logger, config });
    registerCatalog(router, catalog);
    const client = clientFactory({ intents: catalog.intents });
    logger.attachClient?.(client);

    const context = Object.freeze({
        client,
        config,
        logger,
        router,
        http,
        store,
        scheduler,
        processManager,
        signal: controller.signal
    });
    const startedFeatures = [];
    let startPromise = null;
    let shutdownPromise = null;
    let inFlightFeatureStart = null;

    async function stopFeatures() {
        const errors = [];
        for (const feature of [...startedFeatures].reverse()) {
            try { await feature.stop?.(context); }
            catch (error) {
                errors.push(error);
                logger.error?.(`停止 feature「${feature.name}」時發生錯誤。`, error);
            }
        }
        startedFeatures.length = 0;
        return errors;
    }

    async function performShutdown(reason) {
        const errors = [];
        const shutdownReason = reason instanceof Error ? reason : new Error(String(reason || '應用程式關閉'));
        const phase = async (name, action) => {
            try { await action(); }
            catch (error) {
                errors.push(error);
                logger.error?.(`關機階段「${name}」失敗。`, error);
            }
        };

        await phase('router', async () => router.close());
        await phase('http', async () => {
            if (!controller.signal.aborted) controller.abort(shutdownReason);
        });
        await phase('scheduler', async () => scheduler.stop());
        await phase('process', async () => processManager.stopAll());
        await phase('musicSnapshot', async () => snapshotAllGuildStates());
        await phase('featureStartDrain', async () => {
            if (!inFlightFeatureStart) return;
            try { await inFlightFeatureStart; }
            catch (error) {
                if (error !== controller.signal.reason) throw error;
            }
        });
        await phase('features', async () => {
            const featureErrors = await stopFeatures();
            if (featureErrors.length) throw new AggregateError(featureErrors, '一或多個 feature 停止失敗。');
        });
        await phase('musicPlayers', async () => shutdownAllPlayers());
        await phase('routerDetach', async () => router.detach());
        await phase('client', async () => client.destroy?.());

        if (errors.length) throw new AggregateError(errors, 'Graceful shutdown 有階段失敗。');
    }

    /** 冪等 graceful shutdown；超過總期限會拒絕，讓可執行 entrypoint 決定強制退出。 */
    function shutdown(reason = new Error('收到關機要求。')) {
        if (shutdownPromise) return shutdownPromise;
        let timer;
        const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Graceful shutdown 超過 ${shutdownTimeoutMs} 毫秒。`)), shutdownTimeoutMs);
        });
        shutdownPromise = Promise.race([performShutdown(reason), deadline]).finally(() => clearTimeout(timer));
        return shutdownPromise;
    }

    function start() {
        if (startPromise) return startPromise;
        if (shutdownPromise || controller.signal.aborted) {
            startPromise = Promise.reject(controller.signal.reason || new Error('Runtime 已開始關閉，不能再次啟動。'));
            return startPromise;
        }
        startPromise = (async () => {
            router.attach(client, context);
            try {
                const ready = waitUntilReady(client, controller.signal, readyTimeoutMs);
                await Promise.all([client.login(config.startup.token), ready]);
                for (const feature of catalog.manifests) {
                    if (controller.signal.aborted) throw controller.signal.reason || new Error('啟動已取消。');
                    const featureStart = (async () => {
                        await feature.start?.(context);
                        if (controller.signal.aborted) {
                            await feature.stop?.(context);
                            throw controller.signal.reason || new Error('啟動已取消。');
                        }
                        startedFeatures.push(feature);
                    })();
                    inFlightFeatureStart = featureStart;
                    try { await featureStart; }
                    finally { if (inFlightFeatureStart === featureStart) inFlightFeatureStart = null; }
                }
                logger.info?.(`✅ 機器人已啟動！以「${client.user.tag}」身分登入！在 ${client.guilds.cache.size} 個伺服器提供服務！`);
                return context;
            } catch (error) {
                logger.error?.('Bot runtime 啟動失敗，正在回滾。', error);
                await shutdown(error).catch(shutdownError => logger.error?.('啟動回滾未完整結束。', shutdownError));
                throw error;
            }
        })();
        return startPromise;
    }

    return { start, shutdown, context, catalog, get started() { return startedFeatures.length > 0; } };
}

module.exports = {
    DEFAULT_READY_TIMEOUT_MS,
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
    createRuntime,
    waitUntilReady
};
