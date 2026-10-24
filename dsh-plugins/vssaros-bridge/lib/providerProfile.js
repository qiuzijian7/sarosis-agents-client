// @vssaros/dsh-bridge — 模型 provider 在 `llm-pi-ai` settings 里的**画像**（profile）构造与比对。
//
// 两个写入方共用这一份（2026-10-22 抽出）：
//   ① 桥方法 `providers.sync`（IDE 侧收集的 BYOK / 自定义 provider，整批写）；
//   ② dsh 侧自持的 provider（`codebuddy.js`：CodeBuddy 的登录/目录都在 Host 里做，**单条**写）。
// ⇒ 两边产出的画像**逐字段同形** ⇒ 所有权从 IDE 换到 dsh 时不会因为形状差异而白白重写 profile
//   （一次 `settings.mutate` = 整份 profile 热重组，本机实测 ~20s ✗）。

/** dsh 侧 provider 设置的命名空间（pi-ai 适配器；路由 = `providers.<route>`）。 */
export const PROVIDERS_NS = 'llm-pi-ai';

/**
 * 模型级推理档位字典（pi-ai `reasoningEfforts`：档位 → 发给网关的 `reasoning_effort` 值）。
 *
 * - `off: null`：关思考（不发该参数）；放第一位 ⇒ 菜单顺序与官方 deepseek 适配器一致。
 * - low/medium/high：本仓 provider 网关认的 `reasoning_effort` 取值域。
 * 合法性已核实：schema 明写收 null（`dsh-llm-pi-ai/lib/index.js:1001`），且经 schemastery 解析/再解析后
 * **仍是 null** ⇒ 幂等比对（`sameReasoning`）不会每次都判"变了"。
 */
export const REASONING_EFFORTS = Object.freeze({ off: null, low: 'low', medium: 'medium', high: 'high' });

/** pi-ai 允许出现在 profile 里的档位（= `dsh-llm-pi-ai` 的 THINKING_LEVELS，升序）。 */
export const REASONING_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/**
 * 该路由的**路由级默认档位**（`profile.reasoning`）—— "用户没选档位时用哪一档"。
 *
 * ⚠ 为什么必须**全体模型都支持**才敢写：pi-ai 把 `profile.reasoning` 当请求默认值用，而它对
 * "该模型不支持的档位"**直接抛错**（`UNSUPPORTED_REASONING_EFFORT`，整个回合失败）。非推理模型的
 * 支持集只有 `['off']` ⇒ 路由上混着一个非推理模型，写非 'off' 默认档位就会让那个模型每次请求都炸。
 *
 * 取值：各模型推荐档位的**众数**；平票取**更低**的一档（低档更保守）；没有任何推荐档位时不写。
 *
 * @param {Array<{id:string, reasoning?:boolean, effort?:string}>} modelEntries
 * @returns {string|undefined}
 */
export function routeReasoningDefault(modelEntries) {
	if (!Array.isArray(modelEntries) || modelEntries.length === 0) { return undefined; }
	if (!modelEntries.every(m => m && m.reasoning === true)) { return undefined; }
	const counts = new Map();
	for (const m of modelEntries) {
		const effort = typeof m.effort === 'string' ? m.effort : undefined;
		if (effort !== undefined && effort !== 'off' && REASONING_LEVELS.includes(effort)) {
			counts.set(effort, (counts.get(effort) ?? 0) + 1);
		}
	}
	let best;
	for (const [level, count] of counts) {
		if (best === undefined || count > best.count
			|| (count === best.count && REASONING_LEVELS.indexOf(level) < REASONING_LEVELS.indexOf(best.level))) {
			best = { level, count };
		}
	}
	return best === undefined ? undefined : best.level;
}

/**
 * 收集侧条目（`providers.sync` 负载里的一条）⇒ pi-ai 画像。
 *
 * @param {{api:string, baseURL:string, displayName:string, credentialRef?:string, headers?:Record<string,string>,
 *          models?:Array<{id:string,name?:string,reasoning?:boolean,effort?:string}>}} p
 * @returns {object} 写进 `providers.<route>` 的值
 */
export function buildRouteProfile(p) {
	const models = (p.models ?? []).map(m => ({ id: m.id, name: m.name ?? m.id, ...(m.reasoning ? { reasoningEfforts: REASONING_EFFORTS } : {}) }));
	const routeReasoning = routeReasoningDefault(p.models ?? []);
	return {
		api: p.api,
		baseURL: p.baseURL,
		displayName: p.displayName,
		models,
		...(routeReasoning ? { reasoning: routeReasoning } : {}),
		...(p.credentialRef ? { apiKeyEnv: p.credentialRef } : {}),
		...(p.headers && typeof p.headers === 'object' && Object.keys(p.headers).length ? { headers: p.headers } : {}),
	};
}

const sameHeaders = (a, b) => {
	const ae = Object.entries(a ?? {});
	const be = Object.entries(b ?? {});
	return ae.length === be.length && ae.every(([k, v]) => (b ?? {})[k] === v);
};

/**
 * 比较**推理能力位**是否等价（按 `reasoningEfforts` 比：旧条目的 `reasoning: true` 与之不等价 ⇒ 会被
 * 重写一次修正掉；比较式若沿用旧键，重写后两侧永远对不上 ⇒ 每次 sync 都重写 ✗）。
 */
const sameReasoning = (want, got) => {
	const a = want.reasoningEfforts;
	const b = got && typeof got === 'object' ? got.reasoningEfforts : undefined;
	if (a === undefined && b === undefined) { return true; }
	if (!a || !b || typeof b !== 'object') { return false; }
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every(k => b[k] === a[k]);
};

/** baseURL 漂移时把**值**带出来（代理 secret 段打码）。 */
export const redactUrl = u => String(u ?? '').replace(/(\/r\/)[^/]+/, '$1***');

/**
 * 语义比对（settings 会把 profile 规范化——补 input/compat/modelOverrides 等默认字段，JSON 全量比永远不等）。
 * 只比我们管理的字段。`why`（可选）收**第一个**不同的字段名 ⇒ 日志里看得出"是哪个字段在漂"。
 *
 * @param {object} want buildRouteProfile 的产物
 * @param {object|undefined} got settings 里现存的值
 * @param {string[]} [why]
 * @returns {boolean}
 */
export function sameProfile(want, got, why) {
	const no = f => { why?.push(f); return false; };
	if (!got || typeof got !== 'object') { return no('route-absent'); }
	if (got.api !== want.api) { return no('api'); }
	if (got.baseURL !== want.baseURL) { return no(`baseURL ${redactUrl(got.baseURL)} → ${redactUrl(want.baseURL)}`); }
	if (got.displayName !== want.displayName) { return no('displayName'); }
	if ((got.reasoning ?? undefined) !== (want.reasoning ?? undefined)) { return no('reasoning'); }
	if ((got.apiKeyEnv ?? undefined) !== (want.apiKeyEnv ?? undefined)) { return no('apiKeyEnv'); }
	if (!sameHeaders(want.headers, got.headers)) { return no('headers'); }
	if (!Array.isArray(got.models) || got.models.length !== want.models.length) { return no('models.length'); }
	for (let i = 0; i < want.models.length; i++) {
		const wm = want.models[i];
		const gm = got.models[i];
		if (!gm || gm.id !== wm.id) { return no(`models[${i}].id`); }
		if ((gm.name ?? gm.id) !== (wm.name ?? wm.id)) { return no(`models[${i}].name`); }
		if (!sameReasoning(wm, gm)) { return no(`models[${i}].reasoningEfforts`); }
	}
	return true;
}

/**
 * 头的整形：去空值、最多 16 条、每条 ≤512 字符（与 IDE 侧 `sanitizeHeaders` 同口径 ⇒ 两边写出的画像同形）。
 *
 * @param {Record<string,string>|undefined} h
 * @returns {Record<string,string>|undefined}
 */
export function sanitizeHeaders(h) {
	if (!h || typeof h !== 'object') { return undefined; }
	const out = {};
	for (const [k, v] of Object.entries(h).slice(0, 16)) {
		const value = typeof v === 'string' ? v.trim() : '';
		if (k && value) { out[k] = value.slice(0, 512); }
	}
	return Object.keys(out).length ? out : undefined;
}

/**
 * **单条**路由的写入（dsh 侧自持 provider 用）：画像为 `null` ⇒ 删掉该路由；与现存等价 ⇒ 不写。
 *
 * 只动 `providers.<route>` 这一个键（path 级 set/unset），**不碰**其它路由 ⇒ 与 `providers.sync`
 * 的整批写互不覆盖（后者也已把 dsh 自持路由排除在外，见 index.js `DSH_OWNED_ROUTES`）。
 *
 * @param {object} settings ctx.settings
 * @param {string} route
 * @param {object|null} profile buildRouteProfile 的产物；null = 删除
 * @returns {Promise<{changed:boolean, why:string[]}>}
 */
export async function writeOwnedRoute(settings, route, profile) {
	if (!settings || typeof settings.describe !== 'function' || typeof settings.mutate !== 'function') {
		throw new Error('settings 服务不可用 —— 无法写模型路由');
	}
	const read = () => settings.describe().find(d => d.ns === PROVIDERS_NS);
	const desc = read();
	if (!desc) {
		throw new Error(`${PROVIDERS_NS} settings namespace missing (dsh-llm-pi-ai not mounted?)`);
	}
	const current = (desc.value && typeof desc.value === 'object' ? desc.value.providers : undefined) ?? {};
	const why = [];
	if (profile === null) {
		if (!(route in current)) { return { changed: false, why }; }
		why.push('removed');
	} else if (sameProfile(profile, current[route], why)) {
		return { changed: false, why };
	}
	const ops = profile === null
		? [{ op: 'unset', path: ['providers', route] }]
		: [{ op: 'set', path: ['providers', route], value: profile }];
	try {
		await settings.mutate(PROVIDERS_NS, ops, desc.revision);
	} catch (e) {
		// 设置页并发编辑 ⇒ 重读 revision 重试一次（与 providers.sync 同一处置）。
		if (String(e?.code ?? e?.message ?? e).includes('SETTINGS_CONFLICT')) {
			await settings.mutate(PROVIDERS_NS, ops, read()?.revision);
		} else {
			throw e;
		}
	}
	return { changed: true, why };
}
