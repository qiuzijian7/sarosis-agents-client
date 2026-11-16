// @vssaros/dsh-kb — 知识库设置页「飞书应用」下拉的纯逻辑（2026-11-11）
//
// 用户要求：与 bot 设置页（`vssaros-chat-surface/lib/client.conversationViews.js` 的
//   `BotChannelBindingsCard`）的飞书选择**功能与样式一致** ⇒ 下拉数据源也应是同一批应用。
//
// 数据源：`<数据根>/agent-im-accounts.json`（vssaros-agents 的凭据池真源，
//   `imCredentials.js:3-6,50-72`）+ KB 自己新建的应用（`.kb-settings.json` 的
//   `feishu.customApps`，只存 appId/name 非机密）。
//
// ⚠ 只产出**掩码视图**：`hasSecret` 而不是 secret 明文；明文只在 Host 内部
//   `readAgentsAppSecret()` 读取并写进 KB 凭据库 / lark-cli stdin。
// ⚠ 纯函数：不 import fs / credentials，便于守卫直测。

/** 从 agents 凭据池的 accounts 对象里取某个应用的 secret（只给 Host 内部用）。 */
export function agentsSecretOf(accounts, appId) {
	const a = accounts && typeof accounts === 'object' ? accounts : {};
	const id = String(appId ?? '').trim();
	if (!id) { return ''; }
	if (a.feishu && String(a.feishu.appId ?? '').trim() === id) {
		return String(a.feishu.appSecret ?? '').trim();
	}
	const extra = a.feishuApps && typeof a.feishuApps === 'object' ? a.feishuApps[id] : null;
	if (extra) { return String(extra.appSecret ?? '').trim(); }
	return '';
}

/**
 * 构造下拉用的**掩码应用列表**（与 bot 页 `feishuApps` 同形状）。
 * @param {object}   args.accounts      `agent-im-accounts.json` 的 `accounts`
 * @param {Array}    args.customApps    KB 侧新建的应用 `[{appId, name}]`
 * @param {Set}      args.kbSecretIds   KB 凭据库里已存 secret 的 appId 集合
 * @returns `{appId, name, isDefault, hasSecret, source}[]`（默认应用在前）
 */
export function buildFeishuAppList({ accounts, customApps = [], kbSecretIds = new Set() } = {}) {
	const a = accounts && typeof accounts === 'object' ? accounts : {};
	const out = [];
	const seen = new Set();
	const push = (appId, name, isDefault, hasSecret, source) => {
		const id = String(appId ?? '').trim();
		if (!id || seen.has(id)) { return; }
		seen.add(id);
		out.push({ appId: id, name: String(name ?? ''), isDefault: !!isDefault, hasSecret: !!hasSecret, source });
	};
	// ① 默认应用（bot 页下拉首项 value:'' 就代表它 ⇒ 这里也标 isDefault，前端会排除）
	if (a.feishu && String(a.feishu.appId ?? '').trim()) {
		push(a.feishu.appId, a.feishu.name || '', true,
			Boolean(String(a.feishu.appSecret ?? '').trim()) || kbSecretIds.has(String(a.feishu.appId).trim()), 'dsh');
	}
	// ② agents 池里额外登记的应用
	const extra = a.feishuApps && typeof a.feishuApps === 'object' ? a.feishuApps : {};
	for (const id of Object.keys(extra).sort()) {
		const e = extra[id] || {};
		push(id, e.name || '', false,
			Boolean(String(e.appSecret ?? '').trim()) || kbSecretIds.has(id), 'dsh-app');
	}
	// ③ KB 侧自己新建的应用（secret 只在 KB 凭据库 ⇒ 用 kbSecretIds 判）
	for (const item of Array.isArray(customApps) ? customApps : []) {
		const id = String(item?.appId ?? '').trim();
		push(id, item?.name || '', false, kbSecretIds.has(id), 'kb-app');
	}
	return out;
}

/**
 * 前端 `<select>` 的 options（KB 侧契约参考；两份前端按同一口径各自实现）：
 *   首项 `''` = 内置默认「默认应用」；缺 secret 的项 disabled 且标注；
 *   末尾 `__new__` = 「+ 添加新应用」（与 bot 设置页同款）。
 *
 * ★ 2026-11-11（用户裁决）：常态**不显示** App Secret 输入框，但下拉里**必须保留**
 *   「+ 添加新应用」；选中后才就地展开 App ID / App Secret / 名称表单。
 *   两条要求不冲突 —— 密钥输入框是「按需出现」，不是「常驻」也不是「不存在」。
 */
export function buildAppOptions(apps) {
	const list = Array.isArray(apps) ? apps : [];
	const options = [{ value: '', label: '默认应用' }];
	for (const a of list.filter(x => !x.isDefault)) {
		const id = String(a?.appId ?? '');
		const has = !!a?.hasSecret;
		options.push({
			value: id,
			disabled: !has,
			label: (a?.name ? String(a.name) + ' · ' : '') + id + (has ? '' : '（缺 App Secret）'),
		});
	}
	options.push({ value: '__new__', label: '+ 添加新应用（App ID / App Secret）' });
	return options;
}
