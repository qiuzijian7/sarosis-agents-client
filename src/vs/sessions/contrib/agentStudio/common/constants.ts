/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Configuration keys — feature toggles qiuzijian debug
export const AGENT_STUDIO_ENABLED_SETTING = 'sessions.agentStudio.enabled';
export const AGENT_STUDIO_DATA_PATH_SETTING = 'sessions.agentStudio.dataPath';
export const AGENT_STUDIO_CHAT_STREAM_LOG_ENABLED_SETTING = 'sessions.agentStudio.chatStreamLog.enabled';
export const AGENT_STUDIO_CHAT_STREAM_LOG_DUMP_TOOLS_SETTING = 'sessions.agentStudio.chatStreamLog.dumpTools';

// NOTE: Knot AG-UI configuration keys are defined in the knot-agui extension's
// package.json (contributes.configuration) and discovered at runtime via
// ISettingsTabRegistry (contributes.agentStudioSettingsTab). Do NOT add
// Knot-specific config keys here — they belong to the plugin.

// Configuration keys — Preferences
export const AGENT_STUDIO_THEME_SETTING = 'sessions.agentStudio.preferences.theme';
export const AGENT_STUDIO_LANGUAGE_SETTING = 'sessions.agentStudio.preferences.language';
export const AGENT_STUDIO_SEND_KEY_SETTING = 'sessions.agentStudio.preferences.sendKey';
export const AGENT_STUDIO_DEFAULT_PROVIDER_SETTING = 'sessions.agentStudio.preferences.defaultProvider';
export const AGENT_STUDIO_DEFAULT_MODEL_SETTING = 'sessions.agentStudio.preferences.defaultModel';
export const AGENT_STUDIO_DEFAULT_AGENT_SETTING = 'sessions.agentStudio.preferences.defaultAgent';
export const AGENT_STUDIO_BOT_NAME_SETTING = 'sessions.agentStudio.preferences.botName';
export const AGENT_STUDIO_SHOW_TOKEN_USAGE_SETTING = 'sessions.agentStudio.preferences.showTokenUsage';
export const AGENT_STUDIO_NOTIFICATION_SOUND_SETTING = 'sessions.agentStudio.preferences.notificationSound';
export const AGENT_STUDIO_BROWSER_NOTIFICATIONS_SETTING = 'sessions.agentStudio.preferences.browserNotifications';
export const AGENT_STUDIO_CHECK_UPDATES_SETTING = 'sessions.agentStudio.preferences.checkUpdates';

// Configuration keys — Skill Budget Limits
export const AGENT_STUDIO_SKILLS_MAX_IN_PROMPT_SETTING = 'sessions.agentStudio.skills.maxSkillsInPrompt';
export const AGENT_STUDIO_SKILLS_MAX_PROMPT_CHARS_SETTING = 'sessions.agentStudio.skills.maxSkillsPromptChars';

// Configuration keys — Chat UI Mode (React WebView vs Native DOM)
/** @deprecated NativeChatEditorPane 现在是唯一聊天渲染器，此设置不再生效。保留仅为向后兼容。 */
export const AGENT_STUDIO_USE_NATIVE_CHAT_SETTING = 'sessions.agentStudio.chat.useNativeChat';

// Configuration keys — Auxiliary Models
export const AGENT_STUDIO_AUX_VISION_PROVIDER = 'sessions.agentStudio.aux.vision.provider';
export const AGENT_STUDIO_AUX_VISION_MODEL = 'sessions.agentStudio.aux.vision.model';
export const AGENT_STUDIO_AUX_WEB_EXTRACT_PROVIDER = 'sessions.agentStudio.aux.webExtract.provider';
export const AGENT_STUDIO_AUX_WEB_EXTRACT_MODEL = 'sessions.agentStudio.aux.webExtract.model';
export const AGENT_STUDIO_AUX_SESSION_SEARCH_PROVIDER = 'sessions.agentStudio.aux.sessionSearch.provider';
export const AGENT_STUDIO_AUX_SESSION_SEARCH_MODEL = 'sessions.agentStudio.aux.sessionSearch.model';
export const AGENT_STUDIO_AUX_COMPRESSION_PROVIDER = 'sessions.agentStudio.aux.compression.provider';
export const AGENT_STUDIO_AUX_COMPRESSION_MODEL = 'sessions.agentStudio.aux.compression.model';
export const AGENT_STUDIO_AUX_GOAL_JUDGE_PROVIDER = 'sessions.agentStudio.aux.goalJudge.provider';
export const AGENT_STUDIO_AUX_GOAL_JUDGE_MODEL = 'sessions.agentStudio.aux.goalJudge.model';
export const AGENT_STUDIO_AUX_CURATOR_PROVIDER = 'sessions.agentStudio.aux.curator.provider';
export const AGENT_STUDIO_AUX_CURATOR_MODEL = 'sessions.agentStudio.aux.curator.model';

// Configuration keys — Provider (API connections)
export const AGENT_STUDIO_PROVIDER_OPENROUTER_API_KEY = 'sessions.agentStudio.provider.openrouter.apiKey';
export const AGENT_STUDIO_PROVIDER_OPENROUTER_BASE_URL = 'sessions.agentStudio.provider.openrouter.baseUrl';
export const AGENT_STUDIO_PROVIDER_NOUS_API_KEY = 'sessions.agentStudio.provider.nous.apiKey';
export const AGENT_STUDIO_PROVIDER_NOUS_BASE_URL = 'sessions.agentStudio.provider.nous.baseUrl';
export const AGENT_STUDIO_PROVIDER_GEMINI_API_KEY = 'sessions.agentStudio.provider.gemini.apiKey';
export const AGENT_STUDIO_PROVIDER_GEMINI_BASE_URL = 'sessions.agentStudio.provider.gemini.baseUrl';
export const AGENT_STUDIO_PROVIDER_ANTHROPIC_API_KEY = 'sessions.agentStudio.provider.anthropic.apiKey';
export const AGENT_STUDIO_PROVIDER_ANTHROPIC_BASE_URL = 'sessions.agentStudio.provider.anthropic.baseUrl';
export const AGENT_STUDIO_PROVIDER_MAIN_API_KEY = 'sessions.agentStudio.provider.main.apiKey';
export const AGENT_STUDIO_PROVIDER_MAIN_BASE_URL = 'sessions.agentStudio.provider.main.baseUrl';
export const AGENT_STUDIO_PROVIDER_CUSTOM_API_KEY = 'sessions.agentStudio.provider.custom.apiKey';
export const AGENT_STUDIO_PROVIDER_CUSTOM_BASE_URL = 'sessions.agentStudio.provider.custom.baseUrl';
export const AGENT_STUDIO_PROVIDER_OLLAMA_API_KEY = 'sessions.agentStudio.provider.ollama.apiKey';
export const AGENT_STUDIO_PROVIDER_OLLAMA_BASE_URL = 'sessions.agentStudio.provider.ollama.baseUrl';

// Configuration keys — CLI
export const AGENT_STUDIO_CLI_PATH_SETTING = 'sessions.agentStudio.cli.cliPath';
export const AGENT_STUDIO_CLI_DEFAULT_WORKDIR_SETTING = 'sessions.agentStudio.cli.defaultWorkdir';
export const AGENT_STUDIO_CLI_AUTO_CONNECT_SETTING = 'sessions.agentStudio.cli.autoConnect';
export const AGENT_STUDIO_CLI_SAVE_HISTORY_SETTING = 'sessions.agentStudio.cli.saveHistory';

// ViewContainer IDs
export const AGENT_STUDIO_CHATBAR_VIEW_CONTAINER_ID = 'agentStudio.chatBar';
export const AGENT_STUDIO_SIDEBAR_VIEW_CONTAINER_ID = 'agentStudio.sidebar';
export const AGENT_STUDIO_AUXBAR_VIEW_CONTAINER_ID = 'agentStudio.auxiliaryBar';

// View IDs
export const AGENT_STUDIO_MAIN_VIEW_ID = 'agentStudio.mainView';
export const AGENT_STUDIO_CANVAS_VIEW_ID = 'agentStudio.canvasView';
export const AGENT_STUDIO_CHAT_VIEW_ID = 'agentStudio.chatView';
export const AGENT_STUDIO_TASKBOARD_VIEW_ID = 'agentStudio.taskBoardView';
export const AGENT_STUDIO_SESSIONS_VIEW_ID = 'agentStudio.sessionsView';
export const AGENT_STUDIO_WORKSPACES_VIEW_ID = 'agentStudio.workspacesView';
export const AGENT_STUDIO_DELEGATION_VIEW_ID = 'agentStudio.delegationView';

// Toolbar View IDs (left sidebar toolbar)
export const AGENT_STUDIO_TOOLBAR_VIEW_ID = 'agentStudio.toolbarView';
export const AGENT_STUDIO_CLAW_CHAT_VIEW_ID = 'agentStudio.clawChatView';
export const AGENT_STUDIO_WORKSPACE_VIEW_ID = 'agentStudio.workspaceView';
export const AGENT_STUDIO_PRESET_AGENT_VIEW_ID = 'agentStudio.presetAgentView';
export const AGENT_STUDIO_TASKS_VIEW_ID = 'agentStudio.tasksView';
export const AGENT_STUDIO_SCHEDULE_VIEW_ID = 'agentStudio.scheduleView';
export const AGENT_STUDIO_INTEGRATION_VIEW_ID = 'agentStudio.integrationView';
export const AGENT_STUDIO_CHANGES_VIEW_ID = 'agentStudio.changesView';
export const AGENT_STUDIO_SEARCH_VIEW_ID = 'agentStudio.searchView';
export const AGENT_STUDIO_PLUGINS_VIEW_ID = 'agentStudio.pluginsView';
export const AGENT_STUDIO_PERSONAL_VIEW_ID = 'agentStudio.personalView';
export const AGENT_STUDIO_SETTINGS_VIEW_ID = 'agentStudio.settingsView';
export const AGENT_STUDIO_PROVIDER_VIEW_ID = 'agentStudio.providerView';
export const AGENT_STUDIO_HEALTH_MONITOR_VIEW_ID = 'agentStudio.healthMonitorView';
export const AGENT_STUDIO_CREW_TEAM_VIEW_ID = 'agentStudio.crewTeamView';
export const AGENT_STUDIO_EVOLUTION_VIEW_ID = 'agentStudio.evolutionView';
export const AGENT_STUDIO_WORKFLOW_VIEW_ID = 'agentStudio.workflowView';
export const AGENT_STUDIO_CHANNEL_VIEW_ID = 'agentStudio.channelView';
export const AGENT_STUDIO_WIKI_VIEW_ID = 'agentStudio.wikiView';
export const AGENT_STUDIO_KB_VIEW_ID = 'agentStudio.knowledgeBaseView';
export const AGENT_STUDIO_WIKI_ROOT_SETTING = 'agentStudio.wiki.root';
export const AGENT_STUDIO_WIKI_MAX_PROPOSAL_SETTING = 'agentStudio.wiki.maxProposalCount';
export const AGENT_STUDIO_WORKTREE_VIEW_ID = 'agentStudio.worktreeView';
export const AGENT_STUDIO_GRAPH_VIEW_ID = 'agentStudio.graphView';
export const AGENT_STUDIO_DASHBOARD_VIEW_ID = 'agentStudio.dashboardView';

// --- TOF (Taihu OA Framework) 登录配置 ---
// 对接 OAuthSystem 网关 (太湖 MCP 鉴权网关)
export const TOF_PAASID_SETTING = 'sessions.agentStudio.tof.paasid';
export const TOF_SITE_BASE_URL_SETTING = 'sessions.agentStudio.tof.siteBaseUrl';
export const TOF_GATEWAY_BASE_URL_SETTING = 'sessions.agentStudio.tof.gatewayBaseUrl';
export const TOF_LOGIN_TIMEOUT_SETTING = 'sessions.agentStudio.tof.loginTimeout';

// Channel keys — ALL channels supported by OpenClaw
// Sources: ChannelsConfig explicit properties (9) + UI renderChannel switch (8)
//          + official-external-channel-catalog.json + extensions/ directories
export type ChannelKey =
	// Core channels (ChannelsConfig explicit properties + UI switch cases)
	| 'whatsapp' | 'telegram' | 'discord' | 'googlechat' | 'slack'
	| 'signal' | 'imessage' | 'nostr' | 'irc' | 'msteams'
	// Official plugin channels (from catalog + extensions/)
	| 'feishu' | 'line' | 'matrix' | 'mattermost' | 'nextcloud-talk'
	| 'qqbot' | 'synology-chat' | 'tlon' | 'twitch' | 'zalo' | 'zalouser'
	// External plugin channels (from catalog)
	| 'wecom' | 'yuanbao' | 'openclaw-weixin';

/**
 * Default channel display order — matches OpenClaw's resolveChannelOrder fallback
 * for core channels, then appends plugin channels by catalog order.
 */
export const CHANNEL_ORDER: ChannelKey[] = [
	// UI default 8
	'whatsapp', 'telegram', 'discord', 'googlechat', 'slack', 'signal', 'imessage', 'nostr',
	// ChannelsConfig extras
	'irc', 'msteams',
	// Official plugins (by catalog order)
	'feishu', 'line', 'matrix', 'mattermost', 'nextcloud-talk', 'qqbot',
	'synology-chat', 'tlon', 'twitch', 'zalo', 'zalouser',
	// External plugins
	'wecom', 'yuanbao', 'openclaw-weixin',
];

/** DM policy options shared across all channels */
export const DM_POLICY_OPTIONS = [
	{ value: 'pairing', label: 'Pairing（配对模式）' },
	{ value: 'allowlist', label: 'Allowlist（白名单）' },
	{ value: 'open', label: 'Open（开放）' },
	{ value: 'disabled', label: 'Disabled（禁用）' },
];

/** Group policy options shared across all channels */
export const GROUP_POLICY_OPTIONS = [
	{ value: 'allowlist', label: 'Allowlist（白名单）' },
	{ value: 'open', label: 'Open（开放）' },
	{ value: 'disabled', label: 'Disabled（禁用）' },
];

export interface IChannelDefinition {
	readonly key: ChannelKey;
	readonly label: string;
	readonly icon: string;
	readonly description: string;
	readonly selectionLabel: string;
	readonly detailLabel: string;
	readonly configFields: IChannelConfigField[];
	/** Aliases recognized by OpenClaw CLI */
	readonly aliases?: string[];
}

export interface IChannelConfigField {
	readonly key: string;
	readonly label: string;
	readonly description: string;
	readonly type: 'string' | 'password' | 'boolean' | 'number' | 'select' | 'textarea';
	readonly default: any;
	readonly placeholder?: string;
	readonly options?: { value: string; label: string }[];
}

/** Common config fields shared by most channels */
function commonFields(ch: string): IChannelConfigField[] {
	return [
		{ key: `sessions.channel.${ch}.enabled`, label: '启用', description: `启用 ${ch} 渠道`, type: 'boolean', default: false },
		{ key: `sessions.channel.${ch}.dmPolicy`, label: 'DM Policy', description: '私聊消息策略', type: 'select', default: 'pairing', options: DM_POLICY_OPTIONS },
		{ key: `sessions.channel.${ch}.allowFrom`, label: 'Allow From', description: '允许的发送者 ID 列表（每行一个）', type: 'textarea', default: '' },
		{ key: `sessions.channel.${ch}.groupPolicy`, label: 'Group Policy', description: '群聊消息策略', type: 'select', default: 'disabled', options: GROUP_POLICY_OPTIONS },
		{ key: `sessions.channel.${ch}.groupAllowFrom`, label: 'Group Allow From', description: '允许的群聊 ID 列表（每行一个）', type: 'textarea', default: '' },
		{ key: `sessions.channel.${ch}.defaultAccount`, label: 'Default Account', description: '多帐号时的默认帐号名称', type: 'string', default: '' },
	];
}

/**
 * All channel definitions — strictly matching OpenClaw.
 * Core channels have detailed config fields matching types.channels.ts.
 * Plugin channels use generic config (plugin-owned schemas).
 */
export const CHANNEL_DEFINITIONS: IChannelDefinition[] = [
	// ═══════════════════════════════════════════════════════════════
	// Core Channels (ChannelsConfig explicit + UI switch cases)
	// ═══════════════════════════════════════════════════════════════

	// ─── 1. WhatsApp ─────────────────────────────────────────
	{
		key: 'whatsapp',
		label: 'WhatsApp',
		icon: '💬',
		description: 'WhatsApp Web (Baileys) — QR 码扫描连接',
		selectionLabel: 'WhatsApp (QR link)',
		detailLabel: 'WhatsApp Web',
		configFields: [
			...commonFields('whatsapp'),
			{ key: 'sessions.channel.whatsapp.selfChatMode', label: 'Self-Chat Mode', description: '启用自聊模式（通过给自己发消息控制 bot）', type: 'boolean', default: false },
			{ key: 'sessions.channel.whatsapp.defaultTo', label: 'Default To', description: '默认发送目标号码', type: 'string', default: '', placeholder: '+8613800138000' },
			{ key: 'sessions.channel.whatsapp.authDir', label: 'Auth Directory', description: 'Baileys 多文件认证状态目录', type: 'string', default: '', placeholder: './auth/whatsapp' },
		],
	},
	// ─── 2. Telegram ─────────────────────────────────────────
	{
		key: 'telegram',
		label: 'Telegram',
		icon: '✈️',
		description: 'Telegram Bot API 连接',
		selectionLabel: 'Telegram (Bot API)',
		detailLabel: 'Telegram Bot',
		configFields: [
			...commonFields('telegram'),
			{ key: 'sessions.channel.telegram.botToken', label: 'Bot Token', description: '来自 @BotFather 的 Bot Token', type: 'password', default: '' },
			{ key: 'sessions.channel.telegram.tokenFile', label: 'Token File', description: '包含 Bot Token 的文件路径', type: 'string', default: '', placeholder: '/path/to/token.txt' },
			{ key: 'sessions.channel.telegram.proxy', label: 'Proxy', description: '代理服务器地址', type: 'string', default: '', placeholder: 'socks5://127.0.0.1:1080' },
			{ key: 'sessions.channel.telegram.webhookUrl', label: 'Webhook URL', description: 'Webhook 接收地址（留空使用长轮询）', type: 'string', default: '', placeholder: 'https://...' },
			{ key: 'sessions.channel.telegram.webhookSecret', label: 'Webhook Secret', description: 'Webhook 签名密钥', type: 'password', default: '' },
			{ key: 'sessions.channel.telegram.webhookPath', label: 'Webhook Path', description: 'Webhook 路径', type: 'string', default: '', placeholder: '/telegram' },
			{ key: 'sessions.channel.telegram.apiRoot', label: 'API Root', description: '自定义 Bot API 根地址', type: 'string', default: '', placeholder: 'https://api.telegram.org' },
		],
	},
	// ─── 3. Discord ──────────────────────────────────────────
	{
		key: 'discord',
		label: 'Discord',
		icon: '🎮',
		description: 'Discord Bot API 连接',
		selectionLabel: 'Discord (Bot API)',
		detailLabel: 'Discord Bot',
		configFields: [
			...commonFields('discord'),
			{ key: 'sessions.channel.discord.token', label: 'Bot Token', description: 'Discord Bot Token', type: 'password', default: '' },
			{ key: 'sessions.channel.discord.applicationId', label: 'Application ID', description: 'Discord Application ID', type: 'string', default: '' },
			{ key: 'sessions.channel.discord.proxy', label: 'Proxy', description: '代理服务器地址', type: 'string', default: '' },
		],
	},
	// ─── 4. Google Chat ──────────────────────────────────────
	{
		key: 'googlechat',
		label: 'Google Chat',
		icon: '💚',
		description: 'Google Chat API — Service Account 认证',
		selectionLabel: 'Google Chat (Chat API)',
		detailLabel: 'Google Chat',
		aliases: ['gchat', 'google-chat'],
		configFields: [
			...commonFields('googlechat'),
			{ key: 'sessions.channel.googlechat.serviceAccountFile', label: 'Service Account File', description: 'Service Account JSON 文件路径', type: 'string', default: '', placeholder: '/path/to/service-account.json' },
			{ key: 'sessions.channel.googlechat.serviceAccount', label: 'Service Account JSON', description: 'Service Account JSON 内容', type: 'textarea', default: '', placeholder: '{"type":"service_account",...}' },
			{ key: 'sessions.channel.googlechat.audienceType', label: 'Audience Type', description: 'JWT audience 类型', type: 'select', default: 'app-url', options: [{ value: 'app-url', label: 'App URL' }, { value: 'project-number', label: 'Project Number' }] },
			{ key: 'sessions.channel.googlechat.audience', label: 'Audience', description: 'JWT audience 值', type: 'string', default: '' },
			{ key: 'sessions.channel.googlechat.webhookPath', label: 'Webhook Path', description: 'Webhook 接收路径', type: 'string', default: '/googlechat', placeholder: '/googlechat' },
			{ key: 'sessions.channel.googlechat.webhookUrl', label: 'Webhook URL', description: '外部可访问的 Webhook URL', type: 'string', default: '', placeholder: 'https://...' },
			{ key: 'sessions.channel.googlechat.botUser', label: 'Bot User', description: 'Bot 用户标识', type: 'string', default: '' },
		],
	},
	// ─── 5. Slack ─────────────────────────────────────────────
	{
		key: 'slack',
		label: 'Slack',
		icon: '📱',
		description: 'Slack App — Bot Token + Socket Mode',
		selectionLabel: 'Slack (Socket Mode)',
		detailLabel: 'Slack Bot',
		configFields: [
			...commonFields('slack'),
			{ key: 'sessions.channel.slack.botToken', label: 'Bot Token', description: 'Slack Bot OAuth Token (xoxb-...)', type: 'password', default: '' },
			{ key: 'sessions.channel.slack.signingSecret', label: 'Signing Secret', description: 'Slack App Signing Secret', type: 'password', default: '' },
			{ key: 'sessions.channel.slack.appToken', label: 'App Token', description: 'Socket Mode App Token (xapp-...，留空使用 HTTP 模式)', type: 'password', default: '' },
			{ key: 'sessions.channel.slack.webhookPath', label: 'Webhook Path', description: 'Events API 接收路径', type: 'string', default: '/slack/events', placeholder: '/slack/events' },
		],
	},
	// ─── 6. Signal ────────────────────────────────────────────
	{
		key: 'signal',
		label: 'Signal',
		icon: '🔒',
		description: 'Signal Messenger — signal-cli REST API',
		selectionLabel: 'Signal (signal-cli)',
		detailLabel: 'Signal Messenger',
		configFields: [
			...commonFields('signal'),
			{ key: 'sessions.channel.signal.phoneNumber', label: '手机号', description: 'Signal 注册手机号（E.164 格式）', type: 'string', default: '', placeholder: '+8613800138000' },
			{ key: 'sessions.channel.signal.apiUrl', label: 'API URL', description: 'signal-cli REST API 地址', type: 'string', default: 'http://localhost:8080', placeholder: 'http://localhost:8080' },
			{ key: 'sessions.channel.signal.trustMode', label: 'Trust Mode', description: '信任模式', type: 'select', default: 'on-first-use', options: [{ value: 'trust-all-known', label: 'Trust All Known' }, { value: 'on-first-use', label: 'On First Use' }, { value: 'always', label: 'Always' }] },
		],
	},
	// ─── 7. iMessage ─────────────────────────────────────────
	{
		key: 'imessage',
		label: 'iMessage',
		icon: '🍎',
		description: 'iMessage — 仅 macOS（通过 AppleScript / BlueBubbles）',
		selectionLabel: 'iMessage (macOS)',
		detailLabel: 'Apple iMessage',
		aliases: ['imsg'],
		configFields: [
			...commonFields('imessage'),
			{ key: 'sessions.channel.imessage.blueBubblesUrl', label: 'BlueBubbles URL', description: 'BlueBubbles 服务器地址（非 macOS 时使用）', type: 'string', default: '', placeholder: 'http://localhost:1234' },
			{ key: 'sessions.channel.imessage.blueBubblesPassword', label: 'BlueBubbles Password', description: 'BlueBubbles 访问密码', type: 'password', default: '' },
		],
	},
	// ─── 8. Nostr ─────────────────────────────────────────────
	{
		key: 'nostr',
		label: 'Nostr',
		icon: '🟣',
		description: 'Nostr 协议 — 去中心化社交 (NIP-04 DMs)',
		selectionLabel: 'Nostr (NIP-04 DMs)',
		detailLabel: 'Nostr Protocol',
		configFields: [
			...commonFields('nostr'),
			{ key: 'sessions.channel.nostr.privateKey', label: 'Private Key', description: 'Nostr 私钥（nsec 或 hex 格式）', type: 'password', default: '' },
			{ key: 'sessions.channel.nostr.relays', label: 'Relays', description: 'Nostr Relay 地址列表（每行一个 wss:// URL）', type: 'textarea', default: '', placeholder: 'wss://relay.damus.io\nwss://nos.lol' },
		],
	},
	// ─── 9. IRC ──────────────────────────────────────────────
	{
		key: 'irc',
		label: 'IRC',
		icon: '📺',
		description: 'Internet Relay Chat 连接',
		selectionLabel: 'IRC (Internet Relay Chat)',
		detailLabel: 'IRC',
		aliases: ['internet-relay-chat'],
		configFields: [
			...commonFields('irc'),
			{ key: 'sessions.channel.irc.server', label: 'Server', description: 'IRC 服务器地址', type: 'string', default: '', placeholder: 'irc.libera.chat' },
			{ key: 'sessions.channel.irc.port', label: 'Port', description: 'IRC 端口', type: 'number', default: 6697 },
			{ key: 'sessions.channel.irc.nick', label: 'Nick', description: 'IRC 昵称', type: 'string', default: '' },
			{ key: 'sessions.channel.irc.password', label: 'Password', description: 'IRC 密码', type: 'password', default: '' },
			{ key: 'sessions.channel.irc.tls', label: 'TLS', description: '启用 TLS 加密', type: 'boolean', default: true },
			{ key: 'sessions.channel.irc.channels', label: 'Channels', description: '自动加入的频道列表（每行一个，如 #openclaw）', type: 'textarea', default: '' },
		],
	},
	// ─── 10. Microsoft Teams ─────────────────────────────────
	{
		key: 'msteams',
		label: 'Microsoft Teams',
		icon: '🟦',
		description: 'Microsoft Teams SDK — 企业通信',
		selectionLabel: 'Microsoft Teams (Teams SDK)',
		detailLabel: 'Microsoft Teams',
		aliases: ['teams'],
		configFields: [
			...commonFields('msteams'),
			{ key: 'sessions.channel.msteams.appId', label: 'App ID', description: 'Teams App ID (Azure Bot)', type: 'string', default: '' },
			{ key: 'sessions.channel.msteams.appPassword', label: 'App Password', description: 'Teams App Password (Azure Bot Secret)', type: 'password', default: '' },
			{ key: 'sessions.channel.msteams.tenantId', label: 'Tenant ID', description: 'Azure AD Tenant ID', type: 'string', default: '' },
		],
	},

	// ═══════════════════════════════════════════════════════════════
	// Official Plugin Channels (from catalog + extensions/)
	// ═══════════════════════════════════════════════════════════════

	// ─── 11. Feishu/Lark ─────────────────────────────────────
	{
		key: 'feishu',
		label: 'Feishu',
		icon: '🐦',
		description: '飞书/Lark 企业通信 — 含文档/知识库/云盘工具',
		selectionLabel: 'Feishu/Lark (飞书)',
		detailLabel: 'Feishu',
		aliases: ['lark'],
		configFields: [
			...commonFields('feishu'),
			{ key: 'sessions.channel.feishu.appId', label: 'App ID', description: '飞书应用 App ID', type: 'string', default: '' },
			{ key: 'sessions.channel.feishu.appSecret', label: 'App Secret', description: '飞书应用 App Secret', type: 'password', default: '' },
			{ key: 'sessions.channel.feishu.verificationToken', label: 'Verification Token', description: '事件订阅验证 Token', type: 'password', default: '' },
			{ key: 'sessions.channel.feishu.encryptKey', label: 'Encrypt Key', description: '事件加密密钥', type: 'password', default: '' },
		],
	},
	// ─── 12. LINE ─────────────────────────────────────────────
	{
		key: 'line',
		label: 'LINE',
		icon: '🟢',
		description: 'LINE Messaging API — Webhook Bot',
		selectionLabel: 'LINE (Messaging API)',
		detailLabel: 'LINE Bot',
		configFields: [
			...commonFields('line'),
			{ key: 'sessions.channel.line.channelAccessToken', label: 'Channel Access Token', description: 'LINE Channel Access Token', type: 'password', default: '' },
			{ key: 'sessions.channel.line.channelSecret', label: 'Channel Secret', description: 'LINE Channel Secret', type: 'password', default: '' },
			{ key: 'sessions.channel.line.webhookUrl', label: 'Webhook URL', description: 'Webhook 接收地址', type: 'string', default: '', placeholder: 'https://...' },
		],
	},
	// ─── 13. Matrix ───────────────────────────────────────────
	{
		key: 'matrix',
		label: 'Matrix',
		icon: '🟩',
		description: 'Matrix 开放协议 — 去中心化通信',
		selectionLabel: 'Matrix (plugin)',
		detailLabel: 'Matrix',
		configFields: [
			...commonFields('matrix'),
			{ key: 'sessions.channel.matrix.homeserver', label: 'Homeserver', description: 'Matrix Homeserver URL', type: 'string', default: '', placeholder: 'https://matrix.org' },
			{ key: 'sessions.channel.matrix.userId', label: 'User ID', description: 'Matrix 用户 ID', type: 'string', default: '', placeholder: '@bot:matrix.org' },
			{ key: 'sessions.channel.matrix.accessToken', label: 'Access Token', description: 'Matrix Access Token', type: 'password', default: '' },
			{ key: 'sessions.channel.matrix.deviceName', label: 'Device Name', description: '设备名称', type: 'string', default: 'openclaw' },
		],
	},
	// ─── 14. Mattermost ───────────────────────────────────────
	{
		key: 'mattermost',
		label: 'Mattermost',
		icon: '🔵',
		description: 'Mattermost — 开源企业通信',
		selectionLabel: 'Mattermost (Bot)',
		detailLabel: 'Mattermost',
		configFields: [
			...commonFields('mattermost'),
			{ key: 'sessions.channel.mattermost.url', label: 'Server URL', description: 'Mattermost 服务器地址', type: 'string', default: '', placeholder: 'https://mattermost.example.com' },
			{ key: 'sessions.channel.mattermost.token', label: 'Bot Token', description: 'Mattermost Bot Token', type: 'password', default: '' },
		],
	},
	// ─── 15. Nextcloud Talk ───────────────────────────────────
	{
		key: 'nextcloud-talk',
		label: 'Nextcloud Talk',
		icon: '☁️',
		description: 'Nextcloud Talk — 自托管聊天 (Webhook Bots)',
		selectionLabel: 'Nextcloud Talk (self-hosted)',
		detailLabel: 'Nextcloud Talk',
		aliases: ['nc-talk', 'nc'],
		configFields: [
			...commonFields('nextcloud-talk'),
			{ key: 'sessions.channel.nextcloud-talk.url', label: 'Server URL', description: 'Nextcloud 服务器地址', type: 'string', default: '', placeholder: 'https://cloud.example.com' },
			{ key: 'sessions.channel.nextcloud-talk.token', label: 'Bot Token', description: 'Talk Bot Token', type: 'password', default: '' },
			{ key: 'sessions.channel.nextcloud-talk.secret', label: 'Bot Secret', description: 'Talk Bot Secret', type: 'password', default: '' },
		],
	},
	// ─── 16. QQ Bot ───────────────────────────────────────────
	{
		key: 'qqbot',
		label: 'QQ Bot',
		icon: '🐧',
		description: 'QQ Bot — 官方 QQ Bot API',
		selectionLabel: 'QQ Bot (Official API)',
		detailLabel: 'QQ Bot',
		configFields: [
			...commonFields('qqbot'),
			{ key: 'sessions.channel.qqbot.appId', label: 'App ID', description: 'QQ Bot App ID', type: 'string', default: '' },
			{ key: 'sessions.channel.qqbot.appSecret', label: 'App Secret', description: 'QQ Bot App Secret', type: 'password', default: '' },
			{ key: 'sessions.channel.qqbot.token', label: 'Token', description: 'QQ Bot Token', type: 'password', default: '' },
		],
	},
	// ─── 17. Synology Chat ────────────────────────────────────
	{
		key: 'synology-chat',
		label: 'Synology Chat',
		icon: '📦',
		description: 'Synology Chat — NAS 聊天 (Webhook)',
		selectionLabel: 'Synology Chat (Webhook)',
		detailLabel: 'Synology Chat',
		configFields: [
			...commonFields('synology-chat'),
			{ key: 'sessions.channel.synology-chat.url', label: 'NAS URL', description: 'Synology NAS 地址', type: 'string', default: '', placeholder: 'https://nas.example.com:5001' },
			{ key: 'sessions.channel.synology-chat.token', label: 'Token', description: 'Synology Chat Bot Token', type: 'password', default: '' },
			{ key: 'sessions.channel.synology-chat.webhookUrl', label: 'Webhook URL', description: '外部可访问的 Webhook URL', type: 'string', default: '', placeholder: 'https://...' },
		],
	},
	// ─── 18. Tlon ─────────────────────────────────────────────
	{
		key: 'tlon',
		label: 'Tlon',
		icon: '🌐',
		description: 'Tlon/Urbit — 去中心化通信',
		selectionLabel: 'Tlon (Urbit)',
		detailLabel: 'Tlon',
		configFields: [
			...commonFields('tlon'),
			{ key: 'sessions.channel.tlon.shipUrl', label: 'Ship URL', description: 'Urbit ship URL', type: 'string', default: '', placeholder: 'http://localhost:8080' },
			{ key: 'sessions.channel.tlon.shipCode', label: 'Ship Code', description: 'Urbit ship access code', type: 'password', default: '' },
		],
	},
	// ─── 19. Twitch ───────────────────────────────────────────
	{
		key: 'twitch',
		label: 'Twitch',
		icon: '🟪',
		description: 'Twitch Chat — 直播聊天集成',
		selectionLabel: 'Twitch (Chat)',
		detailLabel: 'Twitch',
		aliases: ['twitch-chat'],
		configFields: [
			...commonFields('twitch'),
			{ key: 'sessions.channel.twitch.username', label: 'Bot Username', description: 'Twitch bot 账户用户名', type: 'string', default: '' },
			{ key: 'sessions.channel.twitch.oauthToken', label: 'OAuth Token', description: 'Twitch OAuth Token (oauth:...)', type: 'password', default: '' },
			{ key: 'sessions.channel.twitch.channels', label: 'Channels', description: '要加入的频道列表（每行一个）', type: 'textarea', default: '' },
		],
	},
	// ─── 20. Zalo ─────────────────────────────────────────────
	{
		key: 'zalo',
		label: 'Zalo',
		icon: '🔵',
		description: 'Zalo Bot API — 越南通讯平台',
		selectionLabel: 'Zalo (Bot API)',
		detailLabel: 'Zalo',
		aliases: ['zl'],
		configFields: [
			...commonFields('zalo'),
			{ key: 'sessions.channel.zalo.oaId', label: 'OA ID', description: 'Zalo Official Account ID', type: 'string', default: '' },
			{ key: 'sessions.channel.zalo.appId', label: 'App ID', description: 'Zalo App ID', type: 'string', default: '' },
			{ key: 'sessions.channel.zalo.secretKey', label: 'Secret Key', description: 'Zalo App Secret Key', type: 'password', default: '' },
			{ key: 'sessions.channel.zalo.accessToken', label: 'Access Token', description: 'Zalo OA Access Token', type: 'password', default: '' },
			{ key: 'sessions.channel.zalo.refreshToken', label: 'Refresh Token', description: 'Zalo OA Refresh Token', type: 'password', default: '' },
		],
	},
	// ─── 21. Zalo Personal ────────────────────────────────────
	{
		key: 'zalouser',
		label: 'Zalo Personal',
		icon: '🔵',
		description: 'Zalo 个人账号 — 通过 QR 码登录 (zca-js)',
		selectionLabel: 'Zalo (Personal Account)',
		detailLabel: 'Zalo Personal',
		aliases: ['zlu'],
		configFields: [
			...commonFields('zalouser'),
			{ key: 'sessions.channel.zalouser.cookie', label: 'Cookie', description: 'Zalo 登录 Cookie', type: 'password', default: '' },
			{ key: 'sessions.channel.zalouser.imei', label: 'IMEI', description: 'Zalo 设备 IMEI', type: 'string', default: '' },
			{ key: 'sessions.channel.zalouser.userAgent', label: 'User Agent', description: '浏览器 User Agent', type: 'string', default: '' },
		],
	},

	// ═══════════════════════════════════════════════════════════════
	// External Plugin Channels (from catalog, third-party)
	// ═══════════════════════════════════════════════════════════════

	// ─── 22. WeCom (企业微信) ─────────────────────────────────
	{
		key: 'wecom',
		label: 'WeCom',
		icon: '💼',
		description: '企业微信 — 企业消息、文档、日程、任务',
		selectionLabel: 'WeCom（企业微信）',
		detailLabel: 'WeCom',
		aliases: ['qywx', 'wework', 'enterprise-wechat'],
		configFields: [
			...commonFields('wecom'),
			{ key: 'sessions.channel.wecom.corpId', label: 'Corp ID', description: '企业 ID', type: 'string', default: '' },
			{ key: 'sessions.channel.wecom.agentId', label: 'Agent ID', description: '应用 Agent ID', type: 'string', default: '' },
			{ key: 'sessions.channel.wecom.secret', label: 'Secret', description: '应用 Secret', type: 'password', default: '' },
			{ key: 'sessions.channel.wecom.token', label: 'Token', description: '回调 Token', type: 'password', default: '' },
			{ key: 'sessions.channel.wecom.encodingAesKey', label: 'Encoding AES Key', description: '消息加密密钥', type: 'password', default: '' },
		],
	},
	// ─── 23. Yuanbao (元宝) ───────────────────────────────────
	{
		key: 'yuanbao',
		label: 'Yuanbao',
		icon: '🪙',
		description: '腾讯元宝 AI 助手对话渠道',
		selectionLabel: 'Yuanbao (元宝)',
		detailLabel: 'Yuanbao',
		aliases: ['yb', 'tencent-yuanbao', '元宝'],
		configFields: [
			...commonFields('yuanbao'),
		],
	},
	// ─── 24. Weixin (微信) ────────────────────────────────────
	{
		key: 'openclaw-weixin',
		label: 'Weixin',
		icon: '💚',
		description: '个人微信 — 通过 QR 码登录',
		selectionLabel: 'Weixin（微信）',
		detailLabel: 'Weixin',
		aliases: ['weixin', 'wechat', '微信'],
		configFields: [
			...commonFields('openclaw-weixin'),
		],
	},
];

// Panel types (passed to WebView to select which React component to render)
// 'agent-settings' renders AgentEditorPane in the editor area.
// 'settings' is rendered natively (no WebView) via SettingsEditorPane.
export type AgentStudioPanelType = 'chat' | 'taskboard' | 'workflow-editor' | 'agent-settings' | 'settings';

// Provider ID
export const AGENT_STUDIO_PROVIDER_ID = 'agentStudio';

// ContextKey names
export const AGENT_STUDIO_ACTIVE_CONTEXT_KEY = 'agentStudio.active';

// WebView
export const AGENT_STUDIO_WEBVIEW_TYPE = 'agentStudio.webview';

// Stable origin shared by all inline-mode Agent Studio webviews (chat panel +
// the off-screen pre-warm holder). VS Code defaults each webview to a random
// UUID origin, which forces Chromium to spawn a brand-new (cold) renderer
// process per panel — and during dev cold-start that spawn can stall 25-40s.
// By pinning a single stable origin, all these webviews share ONE renderer
// process, so once the persistent pre-warm holder has spawned it, the real
// chat panel reuses the already-hot process instead of spawning its own.
// NOTE: only safe to share across webviews that have identical service-worker
// state — we only apply it when disableServiceWorker is true (inline bundles).
export const AGENT_STUDIO_WEBVIEW_ORIGIN = 'agentstudio-shared-renderer';

// Data file names
export const DATA_FILE_WORKSPACES = 'workspaces.json';
export const DATA_FILE_DELEGATIONS = 'delegations.json';
export const DATA_FILE_SESSIONS = 'sessions.json';
export const DATA_FILE_CHAT_HISTORY = 'chat-history.json';
export const DATA_FILE_LAST_ACTIVE_WORKSPACE = 'last-active-workspace.json';
export const DATA_FILE_LAST_ACTIVE_AGENT = 'last-active-agent.json';
export const DATA_FILE_AGENT_BINDINGS = 'agent-bindings.json';

// Workspace-local data directory name (stored inside the workspace folder)
export const WORKSPACE_DATA_DIR = '.sarosworkspace';

// Agent instance directory name (stored inside .sarosworkspace/)
export const AGENTS_DIR = 'agents';

// Workspace Sessions (Forks) directory name (stored inside .sarosworkspace/)
export const WORKSPACE_SESSIONS_DIR = 'workspace_sessions';

// Agent instance bootstrap file names (inspired by OpenClaw workspace structure)
export const AGENT_CONFIG_FILE = 'agent.yaml';
export const AGENT_AGENTS_MD = 'AGENTS.md';
export const AGENT_SOUL_MD = 'SOUL.md';
export const AGENT_IDENTITY_MD = 'IDENTITY.md';
export const AGENT_TOOLS_MD = 'TOOLS.md';
export const AGENT_MEMORY_MD = 'MEMORY.md';
