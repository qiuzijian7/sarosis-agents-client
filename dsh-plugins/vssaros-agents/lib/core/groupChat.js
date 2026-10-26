/**
 * 群聊「消息成组 + 时间分隔」的**唯一真源**（2026-10-26）。
 *
 * ★ 为什么要有这个文件：
 *   群聊有两套 UI —— 独立页 `lib/groupPage.js`（SSR + 内联字符串 JS）
 *   和工作台面板 `lib/client.agents.js` 的 `midGroup`（React）。
 *   两者的分组规则**写了两遍** ⇒ 2026-10-26 我把独立页从 15s 改成 5min，
 *   工作台那份没动，用户看到"复刻未生效"。
 *   ⇒ 规则集中到这里：React 侧 `import { chatRows }`，
 *     SSR 侧用 `chatRows.toString()` 把**同一个函数体**注入内联脚本（见 groupPage.js）。
 *
 * ★ 因此 `chatRows` / `sepLabel` 必须是**完全自包含**的纯函数：
 *   不引用模块级变量、不引用外部工具函数（否则 `toString()` 注入到浏览器后会 ReferenceError）。
 *   口径常量只能写在函数体内、或由 `opts` 传入。
 *
 * 口径（对齐 DeepSeekBot 的 `message-groups.ts`）：
 *   · 同作者、相邻 ≤5 分钟、同组 ≤8 条 ⇒ 成组（组内不再重复显示名字/头像）
 *   · 距上一条 ≥30 分钟 **或跨天** ⇒ 插一条时间分隔
 */

/** 相邻两条消息在此间隔内、且同作者 ⇒ 归为同一组（DSB 的 `GROUP_MS`） */
export const GROUP_MS = 5 * 60 * 1000;
/** 距上一条超过此间隔 ⇒ 插时间分隔（DSB 的 `SEPARATOR_MS`） */
export const SEPARATOR_MS = 30 * 60 * 1000;
/** 单组最多几条（DSB 没有这个上限；加上是为了长连发时仍能看到名字，避免糊成一片） */
export const GROUP_MAX = 8;

/**
 * 把消息列表算成「行」：
 *   `{ kind:'sep', at }`   —— 时间分隔
 *   `{ kind:'sys', index }`—— 系统提示
 *   `{ kind:'msg', index, who, grp, first, isMe }` —— 一条消息（`grp=true` 表示"续接上一条"）
 *
 * ⚠ 自包含：只能用参数 + 函数内定义的东西（会被 `toString()` 注入浏览器）。
 *
 * @param {Array} messages 形如 `{ at, role, agentId|name, text }`
 * @param {{groupMs?:number, separatorMs?:number, groupMax?:number}} [opts]
 */
export function chatRows(messages, opts) {
	const o = opts || {};
	const GROUP_MS_ = typeof o.groupMs === 'number' ? o.groupMs : 300000;
	const SEPARATOR_MS_ = typeof o.separatorMs === 'number' ? o.separatorMs : 1800000;
	const GROUP_MAX_ = typeof o.groupMax === 'number' ? o.groupMax : 8;
	const dayKeyOf = function (at) {
		const d = new Date(at);
		return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
	};

	const list = Array.isArray(messages) ? messages : [];
	const rows = [];
	let prev = null;
	let groupN = 0;
	let lastDay = '';

	for (let i = 0; i < list.length; i += 1) {
		const m = list[i] || {};
		const at = Number(m.at) || 0;
		const isSystem = String(m.role || '') === 'system';
		const isMe = String(m.role || '') === 'user';
		const who = isMe ? '__me' : String(m.agentId || m.name || m.role || '');
		const dk = dayKeyOf(at);

		// 分隔：跨天 或 距上一条 ≥30 分钟（系统消息不参与，免得把提示前后切成两段）
		const crossDay = dk !== lastDay;
		const bigGap = !!prev && (at - prev.at) >= SEPARATOR_MS_;
		if (!isSystem && (crossDay || bigGap)) {
			rows.push({ kind: 'sep', at: at, index: i });
			lastDay = dk;
			prev = null;
			groupN = 0;
		}

		if (isSystem) {
			rows.push({ kind: 'sys', at: at, index: i });
			prev = null;
			groupN = 0;
			continue;
		}

		const gap = prev ? (at - prev.at) : 1e9;
		const grp = !!prev && prev.who === who && gap >= 0 && gap <= GROUP_MS_ && groupN < GROUP_MAX_;
		if (!grp) { groupN = 0; }
		groupN += 1;
		rows.push({ kind: 'msg', at: at, index: i, who: who, grp: grp, first: !grp, isMe: isMe });
		prev = { at: at, who: who };
	}
	return rows;
}

/**
 * 时间分隔的文案（DSB 的 `separatorLabel`）：今天只给 `09:28`，更早给「昨天 09:28」/「7月3日 09:28」。
 * ⚠ 同样自包含（会被注入内联脚本）。
 */
export function sepLabel(at, now) {
	const d = new Date(at || Date.now());
	const n = now ? new Date(now) : new Date();
	const hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
	if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
		return hm;
	}
	const y = new Date(n.getTime() - 86400000);
	if (d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate()) {
		return '昨天 ' + hm;
	}
	return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
}
