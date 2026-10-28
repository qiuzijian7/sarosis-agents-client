/**
 * CodeBuddy「真实积分/额度」采集（**零依赖，已在 dsh Host 里可用**）。
 *
 * ## 为什么不是「自动读浏览器 cookie」
 *
 * 本插件跑在 **dsh Host（Node 进程）** 里 —— 没有 Electron 的 `BrowserWindow` /
 * `session.cookies`，也没有 Chrome 的 elevation service 通道 ⇒
 * **读不到 `token.woa.com` / `aitoken.woa.com` 的登录 cookie**（那是 httpOnly，
 * 且 Chrome 127+ 用 App-Bound Encryption 保护，连 SYSTEM 权限也解不开，实测过）。
 *
 * ⇒ 所以采用：**用户在工作台页面粘贴一次 cookie ⇒ 存进 dsh 凭据库 ⇒
 *   这里定时用它对 HTTP 接口取数 ⇒ 上报中转站**。cookie 过期才需要再粘一次。
 *
 * ## 取数口径（与 token_dashboard 一致）
 *
 * ```
 * token.woa.com   页面 <meta name="pt">            → X-Page-Token
 *                 /api/query-quota?platform=all   → total_used / personal_used（本月已用金额）
 * aitoken.woa.com /api/v1/auth/me                 → orgId / staffName / currentYear / currentMonth
 *                 /api/v1/person-accounts/center-detail?orgId=…
 *                 → 找 personName == staffName 那行 ⇒ totalQuota / totalConsumed / remaining  ★ 真实额度
 * ```
 *
 * 剩余 = `totalQuota − total_used`（`remaining` 字段存在时优先用它）。
 */

const TOKEN_BASE = 'https://token.woa.com';
const AITOKEN_BASE = 'https://aitoken.woa.com';
const PT_RE = [
	/<meta[^>]*name=["']pt["'][^>]*content=["']([^"']+)["']/i,
	/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']pt["']/i,
];

/**
 * 把用户粘贴的内容规整成 `Cookie:` 头的值。
 *
 * 允许三种输入（用户从 DevTools 里怎么复制都行）：
 *   ① `P_RIO_TOKEN=abc; other=def`（整段 cookie 字符串）
 *   ② `Cookie: P_RIO_TOKEN=abc`（带前缀的请求头）
 *   ③ `abc`（只有值 ⇒ 补成 `P_RIO_TOKEN=abc`）
 */
export function normalizeCookieInput(raw) {
	let text = String(raw ?? '').trim();
	if (!text) {
		return '';
	}
	text = text.replace(/^cookie\s*:\s*/i, '').trim();
	if (!text.includes('=')) {
		return `P_RIO_TOKEN=${text}`;
	}
	return text.replace(/\s*;\s*/g, '; ').replace(/;\s*$/, '');
}

function monthBounds(now = new Date()) {
	const start = new Date(now.getFullYear(), now.getMonth(), 1);
	const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
	const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	return { start: iso(start), end: iso(end), month: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}` };
}

async function fetchText(fetchImpl, url, headers, timeoutMs) {
	const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
	return { status: response.status, text: await response.text(), response };
}

async function fetchJson(fetchImpl, url, headers, timeoutMs) {
	const { status, text } = await fetchText(fetchImpl, url, headers, timeoutMs);
	let body = null;
	try {
		body = JSON.parse(text);
	} catch {
		throw new Error(`接口没有返回 JSON（HTTP ${status}）`);
	}
	return { status, body };
}

/** 取 `token.woa.com` 的页面令牌（`X-Page-Token`）。登录态失效时页面会跳 passport。 */
export async function fetchPageToken(cookie, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
	const { status, text } = await fetchText(fetchImpl, `${TOKEN_BASE}/`, {
		Cookie: cookie,
		'User-Agent': 'Mozilla/5.0',
		Accept: 'text/html,application/xhtml+xml',
	}, timeoutMs);
	for (const re of PT_RE) {
		const match = re.exec(text);
		if (match) {
			return match[1];
		}
	}
	if (/passport|signin/i.test(text) || status === 302) {
		throw new Error('登录态失效（页面跳到了 passport）—— 请重新粘贴 cookie');
	}
	throw new Error(`没有拿到页面令牌（HTTP ${status}）`);
}

/**
 * 采集额度/用量。
 *
 * @param {object} options
 * @param {string} options.tokenCookie     token.woa.com 的 cookie（可含多个键）
 * @param {string} options.aitokenCookie   aitoken.woa.com 的 cookie
 * @returns {Promise<{ok:boolean, month?:string, total_quota?:number, total_consumed?:number,
 *                    remaining?:number, used?:number, staff?:string, source:string, error?:string,
 *                    updated_at:string}>}
 */
export async function collectQuota({ tokenCookie, aitokenCookie, fetchImpl = fetch, timeoutMs = 20000, now = new Date() } = {}) {
	const result = {
		ok: false,
		source: 'browser-cookie',
		updated_at: new Date().toISOString(),
		month: monthBounds(now).month,
		total_quota: null,
		total_consumed: null,
		remaining: null,
		used: null,
		staff: null,
		error: null,
	};

	const token = normalizeCookieInput(tokenCookie);
	const aitoken = normalizeCookieInput(aitokenCookie);
	if (!token) {
		result.error = '缺少 token.woa.com 的 cookie';
		return result;
	}
	if (!aitoken) {
		result.error = '缺少 aitoken.woa.com 的 cookie';
		return result;
	}

	// ① 本月已用（token.woa.com）
	try {
		const pt = await fetchPageToken(token, { fetchImpl, timeoutMs });
		const { status, body } = await fetchJson(
			fetchImpl,
			`${TOKEN_BASE}/api/query-quota?platform=all`,
			{ Cookie: token, 'X-Page-Token': pt, Accept: 'application/json' },
			timeoutMs,
		);
		const used = body?.total_used ?? body?.personal_used ?? null;
		if (used != null) {
			result.used = Number(used);
		}
		/**
		 * ★ 2026-10-28：**额度就在这个响应里**（中转站 `services/quota_service.py` 就是这么取的：
		 *   `total_quota` / `personal.quota` / `remaining`）——我们之前只取了 `used`，
		 *   把额度丢了 ⇒ 害得要去 aitoken 找"人员额度明细"（而那个接口对个人返回空）✗
		 */
		const personal = (body && typeof body.personal === 'object') ? body.personal : {};
		const totalQuota = body?.total_quota ?? body?.quota ?? personal.quota ?? body?.personal_quota ?? null;
		const remaining = body?.remaining ?? body?.personal_remaining ?? personal.remaining ?? null;
		if (totalQuota != null) {
			result.total_quota = Number(totalQuota);
		}
		if (remaining != null) {
			result.remaining = Number(remaining);
		}
		if (body?.personal_used != null && body?.total_used == null) {
			result.used = Number(body.personal_used);
		}
		// 顺手拿一下本月区间（有些部署会返回，拿不到就用本地月份）
		if (body?.month) {
			result.month = String(body.month);
		}
		if (used == null) {
			result.error = `token.woa.com 没有返回 total_used（HTTP ${status}）`;
		}
	} catch (error) {
		result.error = `token.woa.com: ${String((error && error.message) || error)}`;
	}

	// ② 真实额度（aitoken.woa.com）
	try {
		const { body: me } = await fetchJson(fetchImpl, `${AITOKEN_BASE}/api/v1/auth/me`, {
			Cookie: aitoken,
			Accept: 'application/json',
		}, timeoutMs);
		const profile = me?.data || {};
		if (profile.staffName) {
			result.staff = String(profile.staffName);
		}
		if (profile.currentYear && profile.currentMonth) {
			result.month = `${profile.currentYear}-${String(profile.currentMonth).padStart(2, '0')}`;
		}
		if (!profile.orgId) {
			throw new Error('额度分配接口没有返回 orgId（可能登录态失效）');
		}
		const detailUrl = `${AITOKEN_BASE}/api/v1/person-accounts/center-detail?orgId=${encodeURIComponent(profile.orgId)}`;
		const { body: detail } = await fetchJson(fetchImpl, detailUrl, { Cookie: aitoken, Accept: 'application/json' }, timeoutMs);
		const rows = Array.isArray(detail?.data) ? detail.data : [];
		/**
		 * ★ 2026-10-28：原来只按 `personName === staffName` 精确匹配 ⇒ 实际取不到
		 *   （实测：`auth/me` 给的 `staffName` 是英文名 `zijianqiu`，而分配明细里的
		 *   `personName` 是另一种写法 ⇒ 报「分配明细里没有 … 的额度」✗）
		 *   ⇒ 改成**逐级放宽**：精确 → 归一化（去空格/大小写）→ 互相包含 → 工号/账号字段相同。
		 */
		const norm = (value) => String(value ?? '').replace(/\s+/g, '').toLowerCase();
		const staffName = String(profile.staffName || '');
		const staffIds = [profile.staffId, profile.staff_id, profile.userId, profile.user_id, profile.loginName, profile.login_name]
			.map((value) => String(value ?? '').trim())
			.filter(Boolean);
		const nameOf = (row) => String(row?.personName ?? row?.person_name ?? row?.name ?? '');
		/**
		 * ★ 候选名不止 `staffName`：`auth/me` 同时给了 **`displayName`**（中文名）与
		 *   `staffName`（英文名）⇒ 明细里的 `personName` 可能是其中任一种 ⇒ 都试 ✓
		 */
		const candidateNames = [profile.staffName, profile.displayName, profile.chinese_name, profile.chineseName]
			.map((value) => String(value ?? '').trim())
			.filter(Boolean);
		const matchRow = (row) => {
			if (!row) { return false; }
			const rowName = nameOf(row);
			if (candidateNames.some((name) => rowName === name)) { return true; }
			if (rowName && candidateNames.some((name) => norm(rowName) && norm(name) && norm(rowName) === norm(name))) { return true; }
			if (rowName && candidateNames.some((name) => norm(rowName) && norm(name)
				&& (norm(rowName).includes(norm(name)) || norm(name).includes(norm(rowName))))) { return true; }
			return staffIds.some((id) => [row.staffId, row.staff_id, row.userId, row.user_id, row.loginName, row.login_name, row.account]
				.map((value) => String(value ?? '').trim())
				.includes(id));
		};
		const mine = rows.find(matchRow);
		if (!mine) {
			// 把候选名字 + auth/me 的字段名列出来（只列**名字**，不含任何值）
			// ⇒ 下次能直接看出该按哪个字段匹配，不用再猜 ✓
			const candidates = rows.map((row) => nameOf(row)).filter(Boolean).slice(0, 12);
			throw new Error(
				`分配明细里没有 ${staffName || '当前用户'} 的额度`
				+ (candidates.length ? `（明细里有：${candidates.join('、')}）` : '（明细为空）')
				+ `（auth/me 字段：${Object.keys(profile).join(',')}）`,
			);
		}
		result.total_quota = Number(mine.totalQuota ?? 0);
		result.total_consumed = Number(mine.totalConsumed ?? 0);
		result.remaining = mine.remaining != null ? Number(mine.remaining) : null;
	} catch (error) {
		const message = `aitoken.woa.com: ${String((error && error.message) || error)}`;
		// ★ token.woa.com 已经给出额度/已用/剩余 ⇒ aitoken 这条（人员额度明细，对个人返回空）
		//   只是**锦上添花** ⇒ 失败时**不算错误**，只记一条备注（否则页面会误报"没取到"）✓
		if (result.total_quota == null) {
			result.error = result.error ? `${result.error} | ${message}` : message;
		} else {
			result.note = message;
		}
	}

	// ③ 汇总：剩余优先用 aitoken 的 remaining，否则 totalQuota − used
	if (result.total_quota != null) {
		if (result.remaining == null && result.used != null) {
			result.remaining = result.total_quota - result.used;
		}
		result.ok = true;
	}
	return result;
}

/** 中转站侧的一个节点该上报的字段（**只上报数字，绝不上报 cookie**）。 */
export function toReportPayload(quota, nodeId) {
	return {
		node_id: String(nodeId || ''),
		quota: {
			month: quota.month ?? null,
			total_quota: quota.total_quota ?? null,
			total_consumed: quota.total_consumed ?? null,
			remaining: quota.remaining ?? null,
			used: quota.used ?? null,
			staff: quota.staff ?? null,
			source: quota.source,
			updated_at: quota.updated_at,
			error: quota.error ?? null,
		},
	};
}
