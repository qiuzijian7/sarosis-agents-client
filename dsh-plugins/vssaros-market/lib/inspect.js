// @vssaros/dsh-market — 安装前**检查**（2026-10-22，工作台对齐第 1 / 4 步）。
//
// 三件事，结论都写进安装回执与目录卡片（界面据此提前标「不兼容」，不再"装上了却打不开"）：
//   ① **运行时兼容**：与 Host 启动时的判据**同一个函数** —— `@deepseek-ai/dsh-app-boot` 的
//      `evaluatePluginCompatibility`（`engines.dsh` 优先，否则每个 `@deepseek-ai/dsh(-*)` peer 都要满足）。
//      Host 遇到不兼容的包会直接跳过（日志 `skipping profile bundle … is incompatible`）⇒ 装了也是白装，
//      所以**装之前**就要拦。拿不到判据（解析不到 app-boot）⇒ 结论是 `unknown`，不拦、但如实标出。
//   ② **宿主单例**（与 dsh-desktop `HOST_SINGLETON_PATTERNS` 同款）：客户端入口里**打包进了 React 实现**
//      ⇒ 拒装（两份 React = hooks 报错 / 状态错乱）；依赖里写了 react / react-dom / @deepseek-ai/* 只记警告
//      （客户端 `require('react')` 拿到的仍是宿主那一份；Release 包能看全文件，源码 / npm 来源只能看清单）。
//   ③ **是不是工作台**：`exports["./client"]` + `dsh.client.inject` 点名工作台宿主（官方 `dsh-desktop-workbenches`
//      或我们的 `@vssaros/dsh-workbenches`）。不是 ⇒ 记警告（装上也不会出现在工作台入口里）。

/** Host 运行时版本：IDE 拉起 Host 时注入（最准）；没有 ⇒ 用 app-boot 自报的版本。 */
export const RUNTIME_VERSION_ENV = 'VSSAROS_DSH_RUNTIME_VERSION';

export const HOST_SINGLETON_PATTERNS = [/^react$/u, /^react-dom$/u, /^@deepseek-ai\//u];
const SINGLETON_ALLOWED = new Set(['@deepseek-ai/schemastery']);
const DEP_FIELDS = ['dependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies'];
/** 与仓库守卫 `dsh-plugins/check-host-singleton.mjs` 同一份特征串。 */
export const REACT_BUNDLE_MARKERS = [
	'__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED',
	'__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE',
	'react.production.min.js',
	'react-dom.production.min.js',
	'Minified React error #',
];
export const WORKBENCH_HOST_PACKAGES = ['dsh-desktop-workbenches', '@vssaros/dsh-workbenches'];

let judgePromise = null;
/** 取 Host 同款兼容判据（懒加载一次）；拿不到 ⇒ null。可注入（单测）。 */
export function loadCompatibilityJudge(loader = () => import('@deepseek-ai/dsh-app-boot')) {
	if (!judgePromise) {
		judgePromise = Promise.resolve().then(loader).then(mod => {
			if (typeof mod?.evaluatePluginCompatibility !== 'function') { return null; }
			let runtimeVersion = String(process.env[RUNTIME_VERSION_ENV] ?? '').trim();
			if (!runtimeVersion && typeof mod.getDshRuntimeVersion === 'function') {
				try { runtimeVersion = mod.getDshRuntimeVersion(); } catch { runtimeVersion = ''; }
			}
			if (!runtimeVersion) { return null; }
			return { runtimeVersion, evaluate: manifest => mod.evaluatePluginCompatibility(manifest, {}, runtimeVersion) };
		}).catch(() => null);
	}
	return judgePromise;
}
/** 单测用：清掉缓存的判据。 */
export function resetCompatibilityJudge() { judgePromise = null; }

/**
 * 兼容性结论：`{ status: 'ok' | 'incompatible' | 'unknown', runtimeVersion?, requirements?, reason? }`。
 * `manifest` 为空（npm 注册表没取到）⇒ unknown。
 */
export async function compatibilityOf(manifest, judge) {
	if (!manifest || typeof manifest !== 'object') { return { status: 'unknown', reason: '读不到包的 package.json' }; }
	const j = judge === undefined ? await loadCompatibilityJudge() : judge;
	if (!j) { return { status: 'unknown', reason: '读不到 dsh 运行时的兼容判据' }; }
	let issue;
	try { issue = j.evaluate(manifest); } catch (e) {
		return { status: 'incompatible', runtimeVersion: j.runtimeVersion, requirements: {}, reason: `清单的版本声明不合法：${String(e?.message ?? e).slice(0, 200)}` };
	}
	if (!issue) { return { status: 'ok', runtimeVersion: j.runtimeVersion }; }
	return { status: 'incompatible', runtimeVersion: j.runtimeVersion, requirements: issue.requirements ?? {} };
}

/** 宿主单例：`{ blocked: string[], warnings: string[] }`（blocked 非空 ⇒ 拒装）。 */
export function singletonFindings(manifest, files) {
	const blocked = [];
	const warnings = [];
	for (const field of DEP_FIELDS) {
		const deps = manifest?.[field];
		const names = Array.isArray(deps) ? deps : Object.keys(deps && typeof deps === 'object' ? deps : {});
		for (const name of names) {
			if (!SINGLETON_ALLOWED.has(name) && HOST_SINGLETON_PATTERNS.some(re => re.test(name))) {
				warnings.push(`${field} 里带了宿主单例包 ${name}（客户端仍用宿主那一份；服务端若 import 它会拿到第二份）`);
			}
		}
	}
	if (files) {
		const rel = clientEntryOf(manifest);
		const text = rel && files.get(rel) ? files.get(rel).toString('utf8') : '';
		const hit = REACT_BUNDLE_MARKERS.find(m => text.includes(m));
		if (hit) { blocked.push(`客户端入口 ${rel} 打包进了 React 实现（特征：${hit}）——会与宿主的 React 冲突`); }
	}
	return { blocked, warnings };
}

/** 客户端入口的包内相对路径（`exports["./client"]`）。 */
export function clientEntryOf(manifest) {
	const raw = manifest?.exports?.['./client'];
	const value = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? (raw.default ?? raw.import ?? raw.require) : undefined);
	return typeof value === 'string' && value.trim() ? value.trim().replace(/^\.\//, '') : '';
}

/** 是不是工作台：有客户端入口、`dsh.client.inject` 点名工作台宿主。 */
export function workbenchShapeOf(manifest) {
	if (!manifest) { return { workbench: null }; }
	const inject = Array.isArray(manifest?.dsh?.client?.inject) ? manifest.dsh.client.inject : [];
	const host = WORKBENCH_HOST_PACKAGES.find(name => inject.includes(name)) ?? null;
	return { workbench: !!(clientEntryOf(manifest) && host), host };
}

/**
 * 服务端能力审计（2026-10-22，第 4 步）：静态扫描包里**除客户端入口以外**的 JS，
 * 列出它在 Host 里**会做的事**（给 IDE 确认框看，不拦）。
 * 只有能看到文件的来源（GitHub Release）才有结论；看不到 ⇒ `null`（确认框如实说"看不到包内容"）。
 * ⚠ 静态扫描只能证明"代码里写了"，证明不了"不会做"——这是**提示**，不是沙箱。
 */
export const SERVER_CAPABILITY_RULES = [
	['spawn', '启动子进程（可执行任意本机程序）', /\bchild_process\b|\bspawn(?:Sync)?\(|\bexecFile(?:Sync)?\(|\bexecSync\(/],
	['tools', '向 AI 注册工具（模型可以调用它）', /\btools\.register\(/],
	['network', '访问网络', /\bfetch\(|\bhttps?\.(?:request|get)\(|\bnew WebSocket\(|['"](?:node:)?net['"]/],
	['fileWrite', '写入或删除本机文件', /\bwriteFile(?:Sync)?\(|\bappendFile(?:Sync)?\(|\b(?:rm|unlink|rmdir)(?:Sync)?\(|\bcreateWriteStream\(|\brename(?:Sync)?\(/],
	['dynamicCode', '动态执行代码（eval / new Function）', /\beval\(|\bnew Function\(/],
];
const SERVER_FILE_RE = /\.(?:m|c)?js$/;
export function serverCapabilitiesOf(manifest, files) {
	if (!files) { return null; }
	const client = clientEntryOf(manifest);
	const clientDir = client.includes('/') ? client.slice(0, client.lastIndexOf('/') + 1) : '';
	const hits = new Set();
	for (const [rel, data] of files) {
		if (!SERVER_FILE_RE.test(rel) || rel === client || rel.startsWith('node_modules/')) { continue; }
		// 客户端入口同目录的 `client*.js` 分片也是浏览器代码
		if (clientDir && rel.startsWith(clientDir) && /(^|\/)client[^/]*\.m?js$/.test(rel)) { continue; }
		const text = data.toString('utf8');
		for (const [key, , re] of SERVER_CAPABILITY_RULES) { if (!hits.has(key) && re.test(text)) { hits.add(key); } }
	}
	return SERVER_CAPABILITY_RULES.filter(([key]) => hits.has(key)).map(([key, label]) => ({ key, label }));
}

/** 一次完整检查（安装回执与目录卡片共用）。 */
export async function inspectPackage(manifest, { files, judge } = {}) {
	const compatibility = await compatibilityOf(manifest, judge);
	const singleton = singletonFindings(manifest, files);
	const shape = workbenchShapeOf(manifest);
	const warnings = [...singleton.warnings];
	if (shape.workbench === false) { warnings.push('这个包没有声明工作台客户端（exports["./client"] + dsh.client.inject 点名工作台宿主）——装上也不会出现在工作台入口里'); }
	if (compatibility.status === 'unknown') { warnings.push(`没能确认与当前 dsh 版本兼容：${compatibility.reason}`); }
	const capabilities = serverCapabilitiesOf(manifest, files);
	return { compatibility, blocked: singleton.blocked, warnings, workbench: shape.workbench, capabilities };
}

// ── 策略叠加层（2026-10-22，第 4 步；方案 §4.6「上游目录 + 我们的白名单 / 兼容标记」）──────────
//   来源两层，合并规则写死：
//   ① 随包 `catalog/policy.json`（产品方下发）；② `<数据根>/market/policy.json`（本机管理员覆盖）。
//   · `blocked`：两层**取并集**（任何一层停用 = 停用；本机不能把产品方停用的放出来）；
//   · `allowOnly`：任一层给了数组 ⇒ 只允许交集里的（都没给 = 不限制）。
//   id 一律按小写 `owner/repo` 比较（与目录身份同口径）。
export function normalizePolicy(raw) {
	const list = v => (Array.isArray(v) ? v : []);
	const blocked = new Map();
	for (const item of list(raw?.blocked)) {
		const id = String(typeof item === 'string' ? item : item?.id ?? '').trim().toLowerCase();
		if (id) { blocked.set(id, String(item?.reason ?? '').trim()); }
	}
	const allowOnly = Array.isArray(raw?.allowOnly) ? new Set(raw.allowOnly.map(x => String(x).trim().toLowerCase()).filter(Boolean)) : null;
	return { blocked, allowOnly };
}
export function mergePolicies(...policies) {
	const blocked = new Map();
	let allowOnly = null;
	for (const p of policies) {
		if (!p) { continue; }
		for (const [id, reason] of p.blocked) { if (!blocked.has(id) || !blocked.get(id)) { blocked.set(id, reason); } }
		if (p.allowOnly) { allowOnly = allowOnly ? new Set([...allowOnly].filter(id => p.allowOnly.has(id))) : new Set(p.allowOnly); }
	}
	return { blocked, allowOnly };
}
/** `{ allowed: true }` 或 `{ allowed: false, reason }`。 */
export function policyVerdict(policy, id) {
	const key = String(id ?? '').trim().toLowerCase();
	if (policy?.blocked?.has(key)) { return { allowed: false, reason: policy.blocked.get(key) || '这个工作台已被停用' }; }
	if (policy?.allowOnly && !policy.allowOnly.has(key)) { return { allowed: false, reason: '这个工作台不在本机允许安装的名单里' }; }
	return { allowed: true };
}

/** 不兼容的人话（界面直接显示）。 */
export function incompatibleMessage(compatibility) {
	const req = Object.entries(compatibility?.requirements ?? {}).map(([name, range]) => `${name} ${range}`).join('；');
	return `这个工作台不兼容当前 dsh ${compatibility?.runtimeVersion ?? ''}${req ? `（它要求 ${req}）` : ''}${compatibility?.reason ? `：${compatibility.reason}` : ''}。装上也会被 dsh 跳过，等作者发布兼容版本后再装。`;
}
