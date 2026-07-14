'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');
const { z } = require('zod');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_FILES = Object.freeze({
    base: 'config.yml',
    commands: 'configCommands.yml',
    modules: 'configModules.yml'
});

const DISCORD_COMMAND_NAME = /^[-_\p{L}\p{N}\p{sc=Devanagari}\p{sc=Thai}]{1,32}$/u;
const SNOWFLAKE = /^[1-9]\d{16,19}$/;

let cachedConfig;

class ConfigError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'ConfigError';
    }
}

const strictObject = shape => z.strictObject(shape);
const trimmedText = (label, maximum = 2000) => z.string()
    .trim()
    .min(1, `${label}不得空白`)
    .max(maximum, `${label}不得超過 ${maximum} 個字元`);
const optionalSecret = maximum => z.string()
    .trim()
    .max(maximum, `憑證不得超過 ${maximum} 個字元`);
const snowflake = label => z.string()
    .trim()
    .regex(SNOWFLAKE, `${label}必須是有效的 Discord Snowflake`);
const httpUrl = label => z.string()
    .trim()
    .url(`${label}必須是有效網址`)
    .refine(value => value.startsWith('http://') || value.startsWith('https://'), `${label}只允許 HTTP(S) 網址`);
const integerRange = (label, minimum, maximum) => z.number()
    .int(`${label}必須是整數`)
    .min(minimum, `${label}不得小於 ${minimum}`)
    .max(maximum, `${label}不得大於 ${maximum}`);
const nonnegativeInteger = label => z.number()
    .int(`${label}必須是整數`)
    .min(0, `${label}不得小於 0`);
const color = label => integerRange(label, 0x000000, 0xffffff);
const messageList = label => z.array(trimmedText(`${label}內容`))
    .min(1, `${label}至少需要一筆內容`);
const emoji = label => trimmedText(label, 100);
const commandEnable = () => z.boolean().default(true);

const commandName = label => trimmedText(label, 32)
    .refine(value => DISCORD_COMMAND_NAME.test(value), `${label}不符合 Discord Slash Command 名稱規則`)
    .refine(value => value === value.toLocaleLowerCase(), `${label}中的英文必須為小寫`);

const baseConfigSchema = strictObject({
    startup: strictObject({
        token: trimmedText('startup.token', 512),
        clientId: snowflake('startup.clientId'),
        adminCommandName: commandName('startup.adminCommandName'),
        activityType: z.union([
            z.literal(0),
            z.literal(1),
            z.literal(2),
            z.literal(3),
            z.literal(5)
        ], { error: 'startup.activityType 必須是 Discord 支援的活動類型' }),
        statusType: z.enum(['online', 'idle', 'dnd', 'invisible'], {
            error: 'startup.statusType 必須是 online、idle、dnd 或 invisible'
        })
    }),
    log: strictObject({
        channel: snowflake('log.channel'),
        timezone: integerRange('log.timezone', -12, 14)
    }),
    embed: strictObject({
        color: strictObject({
            default: color('embed.color.default'),
            success: color('embed.color.success'),
            error: color('embed.color.error')
        })
    }),
    emoji: strictObject({
        success: emoji('emoji.success'),
        error: emoji('emoji.error'),
        loading: emoji('emoji.loading')
    })
});

const commandsConfigSchema = strictObject({
    announcement: strictObject({ enable: commandEnable(), emoji: emoji('announcement.emoji') }),
    raffle: strictObject({ enable: commandEnable(), emoji: emoji('raffle.emoji') }),
    dataCollection: strictObject({
        enable: commandEnable(),
        emoji: emoji('dataCollection.emoji'),
        titleMaxLength: integerRange('dataCollection.titleMaxLength', 1, 45),
        submissionMaxLength: integerRange('dataCollection.submissionMaxLength', 1, 700)
    }),
    messageDelete: strictObject({
        enable: commandEnable(),
        emoji: emoji('messageDelete.emoji'),
        deleteLimit: integerRange('messageDelete.deleteLimit', 1, 100)
    }),
    userInfo: strictObject({ enable: commandEnable(), emoji: emoji('userInfo.emoji') }),
    stream: strictObject({
        enable: commandEnable(),
        twitchClientId: optionalSecret(255),
        twitchClientSecret: optionalSecret(255),
        checkInterval: integerRange('stream.checkInterval', 1, 1440),
        editInterval: integerRange('stream.editInterval', 1, 1440),
        notifyOnStartupLive: z.boolean(),
        message: z.array(trimmedText('stream.message 內容', 1900))
            .min(1, 'stream.message 至少需要一筆內容')
    }).superRefine((stream, context) => {
        if (Boolean(stream.twitchClientId) !== Boolean(stream.twitchClientSecret)) {
            context.addIssue({
                code: 'custom',
                path: ['twitchClientId'],
                message: 'Twitch Client ID 與 Client Secret 必須同時填寫或同時留空'
            });
        }
    }),
    about: strictObject({
        enable: commandEnable(),
        emoji: emoji('about.emoji'),
        botNickname: trimmedText('about.botNickname', 30),
        introduce: trimmedText('about.introduce', 4096),
        provider: snowflake('about.provider'),
        repository: httpUrl('about.repository')
    }).superRefine((about, context) => {
        const fullName = `關於${about.botNickname}`;
        if (!DISCORD_COMMAND_NAME.test(fullName) || fullName !== fullName.toLocaleLowerCase()) {
            context.addIssue({
                code: 'custom',
                path: ['botNickname'],
                message: '完整的「關於」指令名稱不符合 Discord Slash Command 名稱規則'
            });
        }
    }),
    ping: strictObject({ enable: commandEnable(), emoji: emoji('ping.emoji') }),
    hitokoto: strictObject({ enable: commandEnable(), emoji: emoji('hitokoto.emoji') }),
    packageTracking: strictObject({
        enable: commandEnable(),
        emoji: emoji('packageTracking.emoji'),
        trackTwToken: optionalSecret(512),
        checkInterval: integerRange('packageTracking.checkInterval', 1, 1440),
        historyStatusMaxLength: integerRange('packageTracking.historyStatusMaxLength', 1, 1024),
        archiveAfterDays: integerRange('packageTracking.archiveAfterDays', 1, 3650),
        maxActivePackages: integerRange('packageTracking.maxActivePackages', 1, 100).default(20)
    }),
    ipQuery: strictObject({ enable: commandEnable(), emoji: emoji('ipQuery.emoji') }),
    minecraft: strictObject({
        enable: commandEnable(),
        emoji: emoji('minecraft.emoji'),
        defaultServer: z.record(
            trimmedText('minecraft.defaultServer 的伺服器名稱', 100),
            trimmedText('minecraft.defaultServer 的伺服器位址', 100)
        ).refine(servers => Object.keys(servers).length >= 1, 'minecraft.defaultServer 至少需要一筆伺服器')
            .refine(servers => Object.keys(servers).length <= 25, 'minecraft.defaultServer 最多只能有 25 筆伺服器')
    }),
    unixTimestamp: strictObject({ enable: commandEnable(), emoji: emoji('unixTimestamp.emoji') }),
    music: strictObject({
        enable: commandEnable(),
        emoji: emoji('music.emoji'),
        panelUpdateSeconds: integerRange('music.panelUpdateSeconds', 5, 3600),
        inactivityTimeoutMinutes: integerRange('music.inactivityTimeoutMinutes', 1, 1440),
        volumePercent: integerRange('music.volumePercent', 0, 100),
        queueTitleMaxLength: integerRange('music.queueTitleMaxLength', 1, 97),
        maxDurationMinutes: nonnegativeInteger('music.maxDurationMinutes').max(1440, 'music.maxDurationMinutes 不得大於 1440'),
        minDurationMinutes: nonnegativeInteger('music.minDurationMinutes').max(1440, 'music.minDurationMinutes 不得大於 1440'),
        allowPlaylists: z.boolean(),
        maxPlaylistTracks: integerRange('music.maxPlaylistTracks', 1, 100),
        ytDlpUpdateHours: integerRange('music.ytDlpUpdateHours', 1, 720),
        maxQueueTracks: integerRange('music.maxQueueTracks', 1, 1000).default(100),
        maxFileSizeMiB: integerRange('music.maxFileSizeMiB', 1, 4096).default(256),
        maxCacheSizeMiB: integerRange('music.maxCacheSizeMiB', 1, 102400).default(2048)
    }).superRefine((music, context) => {
        if (music.maxDurationMinutes > 0 && music.maxDurationMinutes < music.minDurationMinutes) {
            context.addIssue({
                code: 'custom',
                path: ['maxDurationMinutes'],
                message: 'music.maxDurationMinutes 啟用限制時不得小於 minDurationMinutes'
            });
        }
        if (music.maxCacheSizeMiB < music.maxFileSizeMiB) {
            context.addIssue({
                code: 'custom',
                path: ['maxCacheSizeMiB'],
                message: 'music.maxCacheSizeMiB 不得小於 maxFileSizeMiB'
            });
        }
    })
});

const triggerSchema = strictObject({
    keywords: messageList('keywords.triggers.keywords'),
    message: messageList('keywords.triggers.message').optional(),
    reaction: messageList('keywords.triggers.reaction').optional()
}).refine(trigger => trigger.message || trigger.reaction, {
    message: '每個關鍵字觸發器至少需要 message 或 reaction',
    path: ['message']
});

const modulesConfigSchema = strictObject({
    member: strictObject({
        emoji: strictObject({
            join: emoji('member.emoji.join'),
            leave: emoji('member.emoji.leave')
        }),
        message: strictObject({
            join: z.array(trimmedText('member.message.join 內容', 1024)).min(1, 'member.message.join 至少需要一筆內容'),
            leave: z.array(trimmedText('member.message.leave 內容', 1024)).min(1, 'member.message.leave 至少需要一筆內容')
        }),
        enable: z.boolean()
    }),
    message: strictObject({
        enable: strictObject({
            create: z.boolean(),
            update: z.boolean(),
            delete: z.boolean()
        })
    }),
    role: strictObject({ enable: z.boolean() }),
    voice: strictObject({ enable: z.boolean() }),
    temporaryVoice: strictObject({
        enable: commandEnable(),
        deleteAfterMinutes: integerRange('temporaryVoice.deleteAfterMinutes', 1, 1440)
    }),
    keywords: strictObject({
        whitelist: z.boolean(),
        channels: z.array(snowflake('keywords.channels 的頻道 ID'))
            .min(1, 'keywords.channels 至少需要一筆頻道 ID'),
        cooldown: integerRange('keywords.cooldown', 0, 600000),
        enable: z.boolean(),
        triggers: z.record(trimmedText('keywords.triggers 的名稱', 100), triggerSchema)
            .refine(triggers => Object.keys(triggers).length >= 1, 'keywords.triggers 至少需要一筆觸發器')
    })
});

function resolveConfigDirectory() {
    const configured = process.env.MIYAKO_CONFIG_DIR;
    if (!configured) return path.join(PROJECT_ROOT, 'config');
    return path.isAbsolute(configured)
        ? path.normalize(configured)
        : path.resolve(PROJECT_ROOT, configured);
}

function assertSecurePermissions(filePath, displayName) {
    if (process.platform === 'win32') return;

    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch (error) {
        throw new ConfigError(`無法存取設定檔 ${displayName}，請確認檔案存在且可讀取。`, { cause: error });
    }

    const permissions = stat.mode & 0o777;
    if (!stat.isFile() || permissions !== 0o600) {
        throw new ConfigError(`設定檔 ${displayName} 必須是一般檔案，且權限必須精確設為 0600。`);
    }
}

function readYaml(filePath, displayName) {
    assertSecurePermissions(filePath, displayName);

    let source;
    try {
        source = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        throw new ConfigError(`無法讀取設定檔 ${displayName}，請確認檔案權限。`, { cause: error });
    }

    try {
        const parsed = yaml.parse(source);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new ConfigError(`設定檔 ${displayName} 的最上層必須是物件。`);
        }
        return parsed;
    } catch (error) {
        if (error instanceof ConfigError) throw error;
        throw new ConfigError(`設定檔 ${displayName} 不是有效的 YAML，請檢查格式。`, { cause: error });
    }
}

function describeIssue(issue) {
    const location = issue.path.length ? issue.path.join('.') : '最上層';
    if (issue.code === 'unrecognized_keys') {
        return `${location} 含有不支援的設定鍵：${issue.keys.join('、')}`;
    }
    if (issue.code === 'invalid_type') return `${location} 的資料型別不正確`;
    return `${location}：${issue.message}`;
}

function parseSection(schema, value, displayName) {
    const result = schema.safeParse(value);
    if (result.success) return result.data;

    const issues = result.error.issues.map(describeIssue).join('；');
    throw new ConfigError(`設定檔 ${displayName} 驗證失敗：${issues}`);
}

function loadConfig() {
    if (cachedConfig) return cachedConfig;

    const directory = resolveConfigDirectory();
    const baseRaw = readYaml(path.join(directory, CONFIG_FILES.base), CONFIG_FILES.base);
    const commandsRaw = readYaml(path.join(directory, CONFIG_FILES.commands), CONFIG_FILES.commands);
    const modulesRaw = readYaml(path.join(directory, CONFIG_FILES.modules), CONFIG_FILES.modules);

    const base = parseSection(baseConfigSchema, baseRaw, CONFIG_FILES.base);
    const commands = parseSection(commandsConfigSchema, commandsRaw, CONFIG_FILES.commands);
    const modules = parseSection(modulesConfigSchema, modulesRaw, CONFIG_FILES.modules);

    cachedConfig = Object.freeze({
        startup: base.startup,
        log: base.log,
        embed: base.embed,
        emoji: base.emoji,
        commands,
        modules
    });
    return cachedConfig;
}

/** 僅供隔離測試在切換 MIYAKO_CONFIG_DIR 後重設單次載入快取。 */
function _resetConfigCacheForTests() {
    cachedConfig = undefined;
}

module.exports = {
    ConfigError,
    PROJECT_ROOT,
    loadConfig,
    _resetConfigCacheForTests
};
