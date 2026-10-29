// @vssaros/dsh-agents — IM 平台与凭据字段定义（**单一真源**，2026-10-27）
//
// ── 为什么要有这个文件 ──────────────────────────────────────────────────────
// 「渠道」页要支持多渠道，但**平台清单与字段名只能有一份**：
// 之前的分工是「Host 校验一份、客户端表单再写一份」，而这个项目已经因为
// "两份清单漂移"踩过多次（工作台清单 / 工具面快照 / preset 清单）。
// ⇒ 定义放这里，由 `GET /x/agents/api/bindings` 的 `channelPlatforms` 发给客户端，
//   客户端**只渲染**，不自己写字段名。
//
// ── 已接入 vs 仅预配置 ──────────────────────────────────────────────────────
// `implemented: false` 的平台**没有适配器**：可以保存（结构上支持多渠道），
// 但页面上会明确标注"暂未接入，保存不会生效" —— 不做"填了看起来好了"的假入口。
// 这与本项目的纪律一致：宁可在界面上说"还没做"，也不假装能用。

/**
 * 一个平台需要几个凭据字段。`secret: true` 的字段**永不回传明文**
 * （接口只回 `hasSecret`），客户端按 password 渲染、留空 = 保留原值。
 *
 * 另外两个字段也是**单一真源**（2026-10-28 补）：
 *   · `chatIdHint`   —— 「IM 绑定」表单里 chatId 输入框的占位/说明。
 *     以前写死在绑定页（只有飞书一句 oc_…）⇒ 选了 telegram 也看到飞书的提示。
 *   · `inboundMode`  —— `ws`（长连接）/ `poll`（长轮询）/ `callback`（被动回调，**没有「启动入站」**）。
 *     客户端据此决定「启动/停止」按钮出不出现、状态文案怎么说 ——
 *     原来客户端按 key 硬编码 feishu/telegram，discord 与 wecom 一进来就全错。
 */
export const IM_PLATFORM_DEFS = [
	{
		key: 'feishu',
		label: '飞书',
		icon: '🐦',
		implemented: true,
		inboundMode: 'ws',
		inboundLabel: 'WS 长连接',
		chatIdHint: 'chat_id（oc_…）—— 在「设置 → 渠道」展开飞书看「最近出现的会话」直接复制',
		note: '入站走长连接（需 SDK）。出站有两种：**填完这里的应用凭据 + 绑定时填 chat_id 就能发**（应用模式，需机器人已在该会话里）；'
			+ '或在绑定里填自定义机器人 webhook（不消耗应用权限，也不需要这里的凭据）。',
		fields: [
			{ key: 'appId', label: 'App ID', type: 'text', required: true, placeholder: 'cli_xxxxxxxxxxxxxxxx', desc: '开放平台 → 企业自建应用 → 凭证与基础信息' },
			{ key: 'appSecret', label: 'App Secret', type: 'password', required: true, secret: true, desc: '与 App ID 配套；明文只存本机' },
		],
	},
	{
		key: 'telegram',
		label: 'Telegram',
		icon: '✈️',
		implemented: true,
		inboundMode: 'poll',
		inboundLabel: 'HTTP 长轮询',
		chatIdHint: '数字 chat id（私聊是用户 id；超级群是 -100 开头）',
		note: '纯 HTTP 长轮询（无 SDK）。填 Bot Token 后到「IM 绑定」里绑会话，再点「启动入站」。'
			+ '群聊默认只认 @（填了 Bot Username 才能精确判断在叫谁）。',
		fields: [
			{ key: 'botToken', label: 'Bot Token', type: 'password', required: true, secret: true, placeholder: '123456:ABC-…', desc: '来自 @BotFather' },
			{ key: 'botUsername', label: 'Bot Username', type: 'text', required: false, placeholder: 'my_bot（不带 @）', desc: '可选：填了才能精确判断群里那条 @ 是不是在叫它' },
		],
	},
	{
		key: 'discord',
		label: 'Discord',
		icon: '🎮',
		implemented: true,
		inboundMode: 'ws',
		inboundLabel: 'Gateway WebSocket',
		chatIdHint: 'channel_id（右键频道 → 复制频道 ID，需先在客户端开启开发者模式）',
		note: 'Gateway WebSocket（Node 自带的 WebSocket，无依赖）。出站走 REST，入站走 WS 长连接；'
			+ '⚠ 必须在 Discord 开发者后台 → Bot → Privileged Gateway Intents 里开启 MESSAGE_CONTENT，'
			+ '否则消息能收到但**内容是空的**。'
			+ '绑定里的 chatId 填 channel_id（右键频道 → 复制频道 ID，需先开开发者模式）。',
		fields: [
			{ key: 'botToken', label: 'Bot Token', type: 'password', required: true, secret: true, placeholder: 'MTIz…（Bot → Reset Token）' },
			{ key: 'applicationId', label: 'Application ID', type: 'text', required: false, placeholder: '123456789012345678（可选）', desc: '可选：只用于拼邀请链接，收发不需要' },
		],
	},
	{
		key: 'wecom',
		label: '企业微信',
		icon: '🏢',
		implemented: true,
		inboundMode: 'callback',
		inboundLabel: '被动回调',
		chatIdHint: '成员 UserID（主动发消息）或 @all；群聊填 ChatId',
		note: '**出站可用**（换 access_token → message/send）；**入站需要公网回调**：'
			+ '企业微信服务器要 POST 到你的地址，所以必须把 /x/agents/api/wecom/callback 反代到'
			+ '一个公网可达、已备案的域名。入站没有「启动」这一步 —— '
			+ '配好回调 Token / EncodingAESKey 并接通公网后自动收消息。',
		fields: [
			{ key: 'corpId', label: 'Corp ID', type: 'text', required: true, placeholder: 'ww…' },
			{ key: 'agentId', label: 'Agent ID', type: 'text', required: true, placeholder: '1000002' },
			{ key: 'secret', label: 'Secret', type: 'password', required: true, secret: true },
			{ key: 'callbackToken', label: '回调 Token', type: 'password', required: false, secret: true, desc: '接收消息 → 设置 API 接收 → Token（入站必需）' },
			{ key: 'encodingAesKey', label: 'EncodingAESKey', type: 'password', required: false, secret: true, desc: '43 字符（入站必需，解密回调用）' },
		],
	},
];

/** 平台 key 白名单（Host 侧校验用）。 */
export const IM_PLATFORM_KEYS = IM_PLATFORM_DEFS.map((p) => p.key);

/** 取一个平台的定义（未知平台 ⇒ undefined）。 */
export function platformDefOf(platform) {
	const key = String(platform ?? '').trim().toLowerCase();
	return IM_PLATFORM_DEFS.find((p) => p.key === key);
}

/** 该平台是否真的有适配器（没接入 ⇒ 界面上要标注"保存不会生效"）。 */
export function isPlatformImplemented(platform) {
	const def = platformDefOf(platform);
	return !!(def && def.implemented);
}

/**
 * 该平台有没有「启动入站」这一步。
 *
 * `callback`（企业微信）是**被动回调** —— 企业微信服务器来连我们，
 * 所以界面上**不该有**启动/停止按钮（点了只会得到 400），状态也不该说"未启动"。
 * 客户端一律走这个判据，别再按 key 硬编码（那是 discord / wecom 接进来后集体错位的原因）。
 */
export function isInboundStartable(platformOrDef) {
	const def = typeof platformOrDef === 'string' ? platformDefOf(platformOrDef) : platformOrDef;
	if (!def) { return false; }
	if (def.inboundMode) { return def.inboundMode === 'ws' || def.inboundMode === 'poll'; }
	/* 老 Host 不带 inboundMode（客户端与 Host 是两个包，可能各自升级）⇒ 按已知的可启停平台回落 */
	return def.key === 'feishu' || def.key === 'telegram' || def.key === 'discord';
}
