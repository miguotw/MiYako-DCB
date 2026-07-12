const path = require('path');
const { SlashCommandBuilder, EmbedBuilder, escapeMarkdown } = require('discord.js');
const { config, configCommands } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));
const { errorReply } = require(path.join(process.cwd(), 'core/Reply'));

const EMBED_COLOR = config.embed.color.default;
const EMBED_EMOJI = configCommands.admin.userInfo.emoji;
const DISCORD_ID_PATTERN = /^\d{17,20}$/;

function normalizeQuery(query) {
    const value = query.trim();
    const mention = value.match(/^<@!?(\d{17,20})>$/);
    return mention ? mention[1] : value.replace(/^@/, '');
}

function displayValue(value) {
    return escapeMarkdown(String(value));
}

async function findMemberByName(guild, query) {
    const normalizedQuery = query.toLowerCase();
    const fetchedMembers = await guild.members.fetch({ query, limit: 100 });
    const members = [...fetchedMembers.values()];

    const usernameMatches = members.filter(member =>
        member.user.username.toLowerCase() === normalizedQuery
        || member.user.tag.toLowerCase() === normalizedQuery
    );

    if (usernameMatches.length === 1) return usernameMatches[0];
    if (usernameMatches.length > 1) throw new Error('AMBIGUOUS_USER');

    const nameMatches = members.filter(member =>
        member.displayName.toLowerCase() === normalizedQuery
        || member.user.globalName?.toLowerCase() === normalizedQuery
    );

    if (nameMatches.length === 1) return nameMatches[0];
    if (nameMatches.length > 1) throw new Error('AMBIGUOUS_USER');
    return null;
}

async function resolveUser(interaction, rawQuery) {
    const query = normalizeQuery(rawQuery);

    if (DISCORD_ID_PATTERN.test(query)) {
        const member = interaction.inGuild()
            ? await interaction.guild.members.fetch(query).catch(() => null)
            : null;
        const user = await interaction.client.users.fetch(query, { force: true });
        return { user, member };
    }

    if (!interaction.inGuild()) throw new Error('NAME_LOOKUP_REQUIRES_GUILD');

    const member = await findMemberByName(interaction.guild, query);
    if (!member) throw new Error('USER_NOT_FOUND');

    const user = await interaction.client.users.fetch(member.id, { force: true });
    return { user, member };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('擷取用戶資料')
        .setDescription('透過 Discord 數字 ID 或英文 Username 查詢用戶基本資料')
        .addStringOption(option =>
            option.setName('用戶')
                .setDescription('輸入數字 ID、@提及或英文 Username（不含 @ 亦可）')
                .setRequired(true)),

    async execute(interaction) {
        await interaction.deferReply();

        const rawQuery = interaction.options.getString('用戶', true);
        sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：/管理 擷取用戶資料 用戶(${rawQuery})`, 'INFO');

        try {
            const { user, member } = await resolveUser(interaction, rawQuery);
            const avatarURL = user.displayAvatarURL({ extension: 'png', size: 1024, forceStatic: false });
            const bannerURL = user.bannerURL({ extension: 'png', size: 1024, forceStatic: false });
            const displayName = member?.displayName || user.globalName || user.username;
            const createdTimestamp = Math.floor(user.createdTimestamp / 1000);

            const embed = new EmbedBuilder()
                .setColor(EMBED_COLOR)
                .setTitle(`${EMBED_EMOJI} ┃ ${displayValue(displayName)} 的用戶資料`)
                .setThumbnail(avatarURL)
                .addFields(
                    { name: '名稱', value: displayValue(user.username), inline: true },
                    { name: '暱稱', value: displayValue(displayName), inline: true },
                    { name: '機器人', value: user.bot ? '是' : '否', inline: true },
                    { name: '用戶 ID', value: `||${user.id}||`, inline: false },
                    { name: '建立時間', value: `<t:${createdTimestamp}:F>（<t:${createdTimestamp}:R>）`, inline: false },
                    { name: '頭貼', value: `[開啟原圖](${avatarURL})`, inline: true },
                    { name: '背景圖', value: bannerURL ? `[開啟原圖](${bannerURL})` : '未設定', inline: true }
                )
                .setFooter({ text: `查詢者：${interaction.user.username}` })
                .setTimestamp();

            if (bannerURL) embed.setImage(bannerURL);
            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            sendLog(interaction.client, '❌ 在執行 /用戶資料 指令時發生錯誤：', 'ERROR', error);

            const messages = {
                NAME_LOOKUP_REQUIRES_GUILD: '**私訊中只能使用 Discord 數字 ID 查詢用戶。**',
                USER_NOT_FOUND: '**找不到該用戶，請確認數字 ID 或英文 Username 是否正確。**',
                AMBIGUOUS_USER: '**找到多位同名用戶，請改用 Discord 數字 ID 查詢。**'
            };

            await errorReply(interaction, messages[error.message] || '**找不到該用戶，請確認查詢內容後再試一次。**');
        }
    }
};
