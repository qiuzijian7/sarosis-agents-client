// 本地工作台包的校验与解包（`install_local_workbench` 工具用）。
//
// 为什么解包在 Host 侧而不是直接让 IDE 装 .tgz：
//   IDE 的安装通道（`workbenches.install` → 主进程 `InstallLocalPlugin`）**只收目录**或 npm spec。
//   让模型自己去解包是错的（解到哪儿、怎么防越界都不可控）⇒ 在 Host 里解到临时目录，
//   再把目录交给那条**已验证**的通道（它会弹用户确认、装完刷新插件列表）。
//
// 安全边界（逐条都有反例来源，别删）：
//   · 只收普通文件（跳过符号链接 / 设备 / FIFO）—— 否则解包可以往任意位置写；
//   · 拒绝绝对路径、`..`、反斜杠、盘符 —— zip/tar 路径穿越的经典形态；
//   · 大小上限（压缩 8MiB / 解压 32MiB / 单文件 8MiB）—— 防"压缩炸弹"把盘写满；
//   · `package.json` 必须能解析，`name`/`version` 必须合法，`main`/`exports` 指向的文件必须真的在包里
//     —— 否则装上去就是一个"永远加载失败"的工作台，而用户只会看到空白。

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';

// ★ 2026-11-02：**不许用 `gunzipSync`** —— 工作台包最大 8MiB，同步解压会把 Host 主线程
// 卡住（`dshPluginPackages` 守卫专门查这条："大文件会把 Host 主线程卡住"）。
const gunzipAsync = promisify(gunzip);

/** 压缩包上限（与 IDE 侧确认框里的口径一致）。 */
export const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
/** 解压后总大小上限。 */
export const MAX_EXTRACTED_BYTES = 32 * 1024 * 1024;
/** 单文件上限（防一个巨大的二进制）。 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** npm 包名（与 IDE 侧 `WORKBENCH_PACKAGE_NAME_RE` 同口径）。 */
export const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
/** 完整 SemVer（预发布/构建元数据都允许）。 */
export const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * 比较两个版本（2026-11-02，降级保护用）。返回 -1 / 0 / 1。
 *
 * 为什么需要：装上 1.2.0 之后又装 1.0.0 —— 用户看到"安装成功"，但界面回到旧版、甚至因为缺字段而崩。
 * dsh-desktop 在客户端也会拦（"已取消安装以避免降级"）。
 *
 * 口径：只比 SemVer 的**语义**，不比字符串（`1.10.0 > 1.9.0`，字符串会判反）。
 * 构建元数据（`+` 之后）不参与比较（SemVer 规定）；预发布（`-rc.1`）**低于**同名正式版。
 * ⚠ 任一方不是完整 SemVer ⇒ 返回 `null`。**不猜**：调用方据此跳过比较（宁可放过，不可误拦）。
 */
export function compareVersions(a, b) {
	const left = String(a ?? '').trim();
	const right = String(b ?? '').trim();
	if (!SEMVER_RE.test(left) || !SEMVER_RE.test(right)) { return null; }
	const parse = (value) => {
		const [core, ...rest] = value.split('+')[0].split('-');
		const nums = core.split('.').map(Number);
		// 预发布段可能含 `-`（`1.0.0-rc-1`）⇒ 把剩下的重新接回去
		return { nums, pre: rest.length ? rest.join('-').split('.') : [] };
	};
	const l = parse(left);
	const r = parse(right);
	for (let i = 0; i < 3; i++) {
		if (l.nums[i] !== r.nums[i]) { return l.nums[i] < r.nums[i] ? -1 : 1; }
	}
	// 核心版本相同 ⇒ 有预发布的更小（1.0.0-rc.1 < 1.0.0）
	if (!l.pre.length && !r.pre.length) { return 0; }
	if (!l.pre.length) { return 1; }
	if (!r.pre.length) { return -1; }
	const len = Math.max(l.pre.length, r.pre.length);
	for (let i = 0; i < len; i++) {
		const li = l.pre[i];
		const ri = r.pre[i];
		if (li === undefined) { return -1; }
		if (ri === undefined) { return 1; }
		const ln = /^\d+$/.test(li);
		const rn = /^\d+$/.test(ri);
		if (ln && rn) {
			const diff = Number(li) - Number(ri);
			if (diff !== 0) { return diff < 0 ? -1 : 1; }
			continue;
		}
		// 数字标识符低于字母标识符（SemVer 规定）
		if (ln !== rn) { return ln ? -1 : 1; }
		if (li !== ri) { return li < ri ? -1 : 1; }
	}
	return 0;
}

const cstr = (buf) => {
	const end = buf.indexOf(0);
	const slice = end === -1 ? buf : buf.subarray(0, end);
	return slice.toString('utf8').trim();
};

/**
 * 极简 tar（ustar / POSIX）解析：只取**普通文件**，跳过目录、符号链接与扩展头。
 * 返回 `[{ name, data }]`。不追求覆盖全部历史格式 —— npm pack 产物与 `tar -czf` 都是 ustar。
 */
export function untar(buffer) {
	const entries = [];
	let offset = 0;
	while (offset + 512 <= buffer.length) {
		const header = buffer.subarray(offset, offset + 512);
		if (header.every(byte => byte === 0)) { break; }
		const name = cstr(header.subarray(0, 100));
		const sizeField = cstr(header.subarray(124, 136));
		const size = Number.parseInt(sizeField || '0', 8);
		if (!Number.isFinite(size) || size < 0) { throw new Error('tar 头里的 size 不合法'); }
		const type = String.fromCharCode(header[156] || 48);
		const prefix = cstr(header.subarray(345, 500));
		const full = prefix ? `${prefix}/${name}` : name;
		const dataStart = offset + 512;
		const dataEnd = dataStart + size;
		if (dataEnd > buffer.length) { throw new Error('tar 内容被截断（压缩包不完整）'); }
		// '0' / NUL / '' = 普通文件；'5' 目录；'2' 符号链接；'x'/'g' 扩展头 —— 只收普通文件。
		if (type === '0' || type === '\0' || type === '') {
			entries.push({ name: full, data: buffer.subarray(dataStart, dataEnd) });
		} else if (type === 'L' || type === 'K') {
			// GNU longname/longlink：内容是下一个条目的名字。解析成长名表，避免把文件当成"没名字"。
			entries.push({ name: `__gnu_${type}__`, data: buffer.subarray(dataStart, dataEnd) });
		}
		offset = dataStart + Math.ceil(size / 512) * 512;
	}
	// 把 GNU 长名套到紧随其后的条目上（npm pack 通常用不到，但 tar 版本不同会出现）
	const out = [];
	let pendingLongName = null;
	for (const entry of entries) {
		if (entry.name === '__gnu_L__') { pendingLongName = entry.data.toString('utf8').replace(/\0+$/, ''); continue; }
		if (entry.name === '__gnu_K__') { continue; }
		out.push({ name: pendingLongName || entry.name, data: entry.data });
		pendingLongName = null;
	}
	return out;
}

/** 拒绝会写到目标目录之外的条目（路径穿越 / 绝对路径 / 盘符 / 反斜杠）。 */
export function safeEntryName(raw) {
	const name = String(raw || '').replace(/\\/g, '/');
	if (!name) { throw new Error('包里有空文件名'); }
	if (name.startsWith('/')) { throw new Error(`包里有绝对路径：${name}`); }
	if (/^[A-Za-z]:/.test(name)) { throw new Error(`包里有盘符路径：${name}`); }
	const normalized = posix.normalize(name);
	if (normalized.startsWith('..') || normalized.includes('/../')) { throw new Error(`包里有越界路径：${name}`); }
	return normalized.replace(/^\.\//, '');
}

/** npm pack 的 tar 根统一是 `package/`；统一剥掉它（只有全部条目都在这个前缀下才剥）。 */
function stripCommonRoot(entries) {
	if (entries.length === 0) { return entries; }
	const firstSegment = entries[0].name.split('/')[0];
	if (!firstSegment || entries.some(entry => !entry.name.startsWith(`${firstSegment}/`))) { return entries; }
	return entries.map(entry => ({ name: entry.name.slice(firstSegment.length + 1), data: entry.data })).filter(entry => entry.name);
}

/**
 * 纯内存的包校验（**不写盘**）：解 gzip → 读 tar → 路径/大小/清单/入口全部校验 → 返回条目与清单。
 *
 * 为什么单拆出来：「干跑」（`check_local_workbench`）和「真安装」必须用**同一套**校验，
 * 否则干跑通过、安装却因包本身被拒，Agent 会被误导（"我明明校验过了"）。
 * 校验在这里；落盘在 `extractWorkbenchPackage`；审计在 `auditWorkbenchEntries`。
 */
export async function inspectWorkbenchArchive(gzBuffer) {
	if (!Buffer.isBuffer(gzBuffer) || gzBuffer.length === 0) { throw new Error('包内容为空'); }
	if (gzBuffer.length > MAX_ARCHIVE_BYTES) {
		throw new Error(`包太大：${gzBuffer.length} 字节（上限 ${MAX_ARCHIVE_BYTES}）`);
	}
	let tar;
	try { tar = await gunzipAsync(gzBuffer); }
	catch (error) { throw new Error(`不是合法的 .tgz：${String(error && error.message || error)}`); }
	const rawEntries = untar(tar);
	const entries = stripCommonRoot(rawEntries.map(entry => ({ name: safeEntryName(entry.name), data: entry.data })));

	let total = 0;
	for (const entry of entries) {
		if (entry.data.length > MAX_FILE_BYTES) { throw new Error(`单文件太大：${entry.name}（${entry.data.length} 字节）`); }
		total += entry.data.length;
		if (total > MAX_EXTRACTED_BYTES) { throw new Error(`解压后太大（上限 ${MAX_EXTRACTED_BYTES} 字节）`); }
	}

	const manifestEntry = entries.find(entry => entry.name === 'package.json');
	if (!manifestEntry) { throw new Error('包里没有 package.json（是不是打错了文件？工作台包必须在根目录有 manifest）'); }
	let manifest;
	try { manifest = JSON.parse(manifestEntry.data.toString('utf8')); }
	catch (error) { throw new Error(`package.json 不是合法 JSON：${String(error && error.message || error)}`); }
	const name = typeof manifest.name === 'string' ? manifest.name.trim() : '';
	const version = typeof manifest.version === 'string' ? manifest.version.trim() : '';
	if (!PACKAGE_NAME_RE.test(name)) { throw new Error(`包名不合法：${String(manifest.name)}`); }
	if (!SEMVER_RE.test(version)) { throw new Error(`版本不是完整 SemVer：${String(manifest.version)}`); }
	// 工作台必须是 dsh 插件：没有 patch 就永远不会进插件树（装上去等于没装，还不报错）
	const patch = manifest?.dsh?.bundle?.patch;
	if (patch === undefined) {
		throw new Error('package.json 缺少 dsh.bundle.patch：这不是一个 dsh 插件包（装上去不会被加载，且宿主不报错）');
	}
	const patchPath = typeof patch === 'string' ? patch : (Array.isArray(patch) ? patch[0] : undefined);
	if (typeof patchPath !== 'string' || !entries.some(entry => entry.name === safeEntryName(patchPath))) {
		throw new Error(`声明的 cordis patch 不在包里：${String(patchPath)}`);
	}
	// 入口必须真的在包里（否则 install 成功、加载失败 —— 用户只看到空白）
	const mainEntry = typeof manifest.main === 'string' ? manifest.main : (typeof manifest?.exports?.['.'] === 'string' ? manifest.exports['.'] : undefined);
	if (mainEntry && !entries.some(entry => entry.name === safeEntryName(mainEntry))) {
		throw new Error(`package.json 的入口不在包里：${mainEntry}`);
	}
	return {
		name,
		version,
		manifest,
		entries,
		totalBytes: total,
		archiveBytes: gzBuffer.length,
		hasClient: hasClientEntry(manifest, entries),
	};
}

/**
 * 包里有没有 `exports["./client"]` 指向的文件。
 * ⚠ 不能对「没写 ./client」的包去算 `safeEntryName('')`：那会抛「包里有空文件名」——
 *   作者看到一个莫名其妙的报错，而真实原因是「这不是工作台包」（2026-11-02 干跑测试抓到）。
 */
function hasClientEntry(manifest, entries) {
	const raw = manifest?.exports?.['./client'];
	const value = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? (raw.default ?? raw.import ?? raw.require) : undefined);
	if (typeof value !== 'string' || !value.trim()) { return false; }
	let wanted;
	try { wanted = safeEntryName(value.trim()); } catch { return false; }
	return entries.some(entry => entry.name === wanted);
}

/**
 * 解一个工作台包到 `targetDir`，并做结构校验。返回 `{ name, version, files }`。
 * @param {Buffer} gzBuffer 已读入内存的 .tgz
 * @param {string} targetDir 空目录（调用方负责创建与清理）
 */
export async function extractWorkbenchPackage(gzBuffer, targetDir) {
	const { name, version, entries, hasClient } = await inspectWorkbenchArchive(gzBuffer);
	await mkdir(targetDir, { recursive: true });
	const files = [];
	for (const entry of entries) {
		const destination = join(targetDir, entry.name);
		await mkdir(dirname(destination), { recursive: true });
		await writeFile(destination, entry.data);
		files.push(entry.name);
	}
	return { name, version, files, hasClient };
}

/** 建一个临时目录（调用方负责 rm）。前缀固定，方便排查残留。 */
export async function createStagingDir() {
	return mkdtemp(join(tmpdir(), 'vssaros-wb-'));
}

/**
 * 安装记录（`<数据根>/local-installs.json`）：**证据**，不是状态机。
 *
 * 用途：界面/排查时回答"这个包是什么时候、从哪儿装的、当时的结果"。
 * 与 state.json 分开（那个是用户的界面状态；删掉工作台不该丢安装历史）。
 * 写入必须原子（临时文件 + rename），并限制条数（防无限增长）。
 */
export const INSTALL_RECORD_FILE = 'local-installs.json';
export const INSTALL_RECORD_LIMIT = 50;

export async function recordLocalInstall(root, record) {
	if (typeof root !== 'string' || !root.trim()) { return false; }
	const path = join(root, INSTALL_RECORD_FILE);
	let history = [];
	try {
		const raw = await readFile(path, 'utf8');
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) { history = parsed; }
	} catch { history = []; }
	// ⚠ 包名两个字段名都要认：安装工具的回执用 `packageName`（对外契约，与官方一致），
	//   而历史记录用 `name`。2026-11-02 实测：只读 `name` ⇒ 工具真实调用时记成空串，
	//   且「同名同版本去重」会把不同的包互相覆盖（单测用的是 `{ name }` 所以没抓到）。
	const name = String(record.name ?? record.packageName ?? '');
	if (!name) { return false; }   // 没有包名的记录没有意义，也不该污染历史
	const entry = {
		name,
		version: String(record.version ?? ''),
		source: 'local',
		application: String(record.application ?? ''),
		at: new Date().toISOString(),
	};
	const next = [entry, ...history.filter(item => !(item && item.name === entry.name && item.version === entry.version))]
		.slice(0, INSTALL_RECORD_LIMIT);
	await mkdir(root, { recursive: true });
	const temporary = join(root, `.local-installs-${Date.now()}.tmp`);
	try {
		await writeFile(temporary, JSON.stringify(next, null, 2), { flag: 'wx', mode: 0o600 });
		const { rename } = await import('node:fs/promises');
		await rename(temporary, path);
	} finally {
		try { await rm(temporary, { force: true }); } catch { /* 清理失败不影响记录 */ }
	}
	return true;
}

// ── 包审计（干跑用，不拦安装）──────────────────────────────────────────────
// ⚠ 这三份规则是 `vssaros-market/lib/inspect.js` 的**副本**（同一份判据，不同的插件）：
//   workbenches 与 market 是两个独立插件，装在一起不是保证 ⇒ 不能互相 import。
//   `run-workbenches-check.mjs` 里有一条测试逐字对比两边的规则，漂移会变红。
export const HOST_SINGLETON_PATTERNS = [/^react$/u, /^react-dom$/u, /^@deepseek-ai\//u];
const SINGLETON_ALLOWED = new Set(['@deepseek-ai/schemastery']);
const DEP_FIELDS = ['dependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies'];
export const REACT_BUNDLE_MARKERS = [
	'__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED',
	'__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE',
	'react.production.min.js',
	'react-dom.production.min.js',
	'Minified React error #',
];
export const WORKBENCH_HOST_PACKAGES = ['dsh-desktop-workbenches', '@vssaros/dsh-workbenches'];
export const SERVER_CAPABILITY_RULES = [
	['spawn', '启动子进程（可执行任意本机程序）', /\bchild_process\b|\bspawn(?:Sync)?\(|\bexecFile(?:Sync)?\(|\bexecSync\(/],
	['tools', '向 AI 注册工具（模型可以调用它）', /\btools\.register\(/],
	['network', '访问网络', /\bfetch\(|\bhttps?\.(?:request|get)\(|\bnew WebSocket\(|['"](?:node:)?net['"]/],
	['fileWrite', '写入或删除本机文件', /\bwriteFile(?:Sync)?\(|\bappendFile(?:Sync)?\(|\b(?:rm|unlink|rmdir)(?:Sync)?\(|\bcreateWriteStream\(|\brename(?:Sync)?\(/],
	['dynamicCode', '动态执行代码（eval / new Function）', /\beval\(|\bnew Function\(/],
];

/**
 * 认工作台注册调用（2026-11-02 修）。
 *
 * 为什么不能只认 `desktopWorkbenches.register(`：仓库里真实存在别的写法 ——
 * `vssaros-studio/lib/client.js` 是 `const dw = scope.desktopWorkbenches; … dw.register(DESCRIPTOR, Panel)`。
 * 只认全名会把这种包判成「没注册」（干跑多报一条假 warning，身份也推不出来）。
 *
 * 判据放宽到「某个对象的 `.register(`，第一个参数是**对象字面量**或**一个变量**」。覆盖三种真实写法：
 *   `desktopWorkbenches.register({ title, … })`   直接给描述符字面量
 *   `dw.register(DESCRIPTOR, Panel)`              先把服务取到变量（studio）
 *   `c.desktopWorkbenches.register(DESCRIPTOR, P)` 脚手架生成的样子
 * ⚠ 仍排除 `loader.register('./x.js')` 这类**字符串参数**（那是模块装载，不是工作台注册）。
 * ⚠ 宁可放宽（漏判只是少一条提示），也不要误判成「没注册」（会让作者以为包坏了）。
 */
const REGISTER_CALL_RE = /\bregister\s*\(\s*(?:\{|[A-Za-z_$][\w$.]*\s*,)/;

function clientEntryOf(manifest) {
	const raw = manifest?.exports?.['./client'];
	const value = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? (raw.default ?? raw.import ?? raw.require) : undefined);
	return typeof value === 'string' && value.trim() ? value.trim().replace(/^\.\//, '') : '';
}

/**
 * 审计一个已通过结构校验的包：给 Agent / 用户**安装前**看的结论。
 * 返回 `{ errors, warnings, capabilities, identity }`：
 *   · errors   —— 装上去一定不对（宿主 React 冲突 / 没有工作台入口）；干跑据此判「不通过」
 *   · warnings —— 值得知道但不阻断（依赖里带了宿主单例、描述符缺字段）
 *   · capabilities —— 服务端代码静态扫描到的行为（提示，不是沙箱）
 *   · identity —— 描述符推出的身份（`local:<包名>`），让作者在装之前就知道它会叫什么
 */
export function auditWorkbenchEntries({ manifest, entries }) {
	const errors = [];
	const warnings = [];
	const files = new Map(entries.map(entry => [entry.name, entry.data]));

	for (const field of DEP_FIELDS) {
		const deps = manifest?.[field];
		const names = Array.isArray(deps) ? deps : Object.keys(deps && typeof deps === 'object' ? deps : {});
		for (const dep of names) {
			if (!SINGLETON_ALLOWED.has(dep) && HOST_SINGLETON_PATTERNS.some(re => re.test(dep))) {
				warnings.push(`${field} 里带了宿主单例包 ${dep}（客户端仍用宿主那一份；服务端若 import 它会拿到第二份）`);
			}
		}
	}

	const clientRel = clientEntryOf(manifest);
	const inject = Array.isArray(manifest?.dsh?.client?.inject) ? manifest.dsh.client.inject : [];
	const host = WORKBENCH_HOST_PACKAGES.find(name => inject.includes(name)) ?? null;
	if (!clientRel) {
		errors.push('没有 exports["./client"]：这不是工作台包（装上去不会出现在工作台入口里）');
	} else if (!files.has(clientRel)) {
		errors.push(`exports["./client"] 指向的文件不在包里：${clientRel}`);
	}
	if (!host) {
		errors.push('dsh.client.inject 里没有点名工作台宿主（@vssaros/dsh-workbenches）：客户端会先于宿主加载，注册会失败');
	}

	// 客户端入口 + 同目录 client*.js 分片 = 浏览器代码：不许自带 React 实现
	const clientDir = clientRel.includes('/') ? clientRel.slice(0, clientRel.lastIndexOf('/') + 1) : '';
	// 没有客户端入口时没有「客户端文件」这个概念（上面已经报了 error），别把 client*.js 当成浏览器代码
	const isClientFile = rel => !!clientRel && (rel === clientRel || (rel.startsWith(clientDir) && /(^|\/)client[^/]*\.m?js$/.test(rel)));
	for (const [rel, data] of files) {
		if (!/\.(?:m|c)?js$/.test(rel) || rel.startsWith('node_modules/') || !isClientFile(rel)) { continue; }
		const text = data.toString('utf8');
		const hit = REACT_BUNDLE_MARKERS.find(marker => text.includes(marker));
		if (hit) { errors.push(`客户端文件 ${rel} 打包进了 React 实现（特征：${hit}）——会与宿主的 React 冲突`); }
	}

	// 服务端能力：除客户端文件以外的 JS
	const found = new Set();
	for (const [rel, data] of files) {
		if (!/\.(?:m|c)?js$/.test(rel) || rel.startsWith('node_modules/') || isClientFile(rel)) { continue; }
		const text = data.toString('utf8');
		for (const [key, , re] of SERVER_CAPABILITY_RULES) { if (!found.has(key) && re.test(text)) { found.add(key); } }
	}
	const capabilities = SERVER_CAPABILITY_RULES.filter(([key]) => found.has(key)).map(([key, label]) => ({ key, label }));

	// 描述符身份：外部包靠 `package:` 派生 local:<包名>；写了 repository 的按其自身口径
	let identity = '';
	if (clientRel && files.has(clientRel)) {
		// 描述符通常在子块里，不在入口：扫所有客户端分片
		for (const [rel, data] of files) {
			if (!isClientFile(rel) || !/\.(?:m|c)?js$/.test(rel)) { continue; }
			const text = data.toString('utf8');
			if (!REGISTER_CALL_RE.test(text)) { continue; }
			const repo = /repository\s*:\s*['"]([^'"]+)['"]/.exec(text)?.[1];
			const pkg = /\bpackage\s*:\s*['"]([^'"]+)['"]/.exec(text)?.[1];
			identity = repo ? repo : (pkg ? `local:${pkg}` : `local:${manifest?.name ?? ''}`);
			break;
		}
		if (!identity) { warnings.push('客户端代码里没找到工作台注册调用（*.register({…title…})）：装上也不会注册出工作台'); }
	}
	return { errors, warnings, capabilities, identity };
}

/**
 * 已装的同名包是哪个版本（覆盖检测的事实来源）。
 *
 * 为什么不是「算已装副本的指纹再比对」（官方 dsh-desktop 的做法）：
 *   · 官方自己管安装目录（代际目录），所以能对已装内容算 fingerprint；
 *   · 我们的安装由 **IDE 主进程**走 `dsh plugin add`（pnpm）完成，Host **看不到落盘位置**；
 *     `pluginManager.listBundles()` 只给 `name/version/enabled/installed/...`，没有任何目录或内容字段。
 *   指纹比对在这条链上拿不到「已装内容」那一半 ⇒ 做出来只会是「看起来有保护、实际比对不到任何东西」。
 * 能成立的是**版本级**检测：同名包已装（且是哪个版本）⇒ 这次安装是「覆盖」，必须被明说、被授权。
 *
 * 返回 `{ status, installed? }`：
 *   · `absent`  —— 查过了，没装；
 *   · `present` —— 已装，`installed` 是已装版本（可能为空串：包存在但没报版本）；
 *   · `unknown` —— 查不了（没有 pluginManager / 调用抛错）。**如实标 unknown，不当作 absent**：
 *                  「没检查过」不能被说成「没有冲突」。
 * 包名比较按完整名与去 scope 的短名都试（与 market 的 `installedNames` 同口径，防「装了却显示成没装」）。
 */
export async function installedVersionOf(pluginManager, packageName) {
	if (!pluginManager || typeof pluginManager.listBundles !== 'function') { return { status: 'unknown' }; }
	let bundles;
	try { bundles = await pluginManager.listBundles(); }
	catch { return { status: 'unknown' }; }
	if (!Array.isArray(bundles)) { return { status: 'unknown' }; }
	const full = String(packageName ?? '').trim();
	const short = full.includes('/') ? full.slice(full.indexOf('/') + 1) : full;
	for (const bundle of bundles) {
		const name = String(bundle?.name ?? '').trim();
		if (!name) { continue; }
		// 1) 是不是同一个包（完整名相等，或去 scope 后的短名相等）
		const bundleShort = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
		const sameName = name === full || (short !== '' && bundleShort === short);
		if (!sameName) { continue; }
		// 2) 是不是真的装着（`installed:false` = 目录里有、但没装）
		if (bundle.installed === false) { continue; }
		return { status: 'present', installed: String(bundle.version ?? '') };
	}
	return { status: 'absent' };
}

/** 读安装记录（最新在前）。文件不存在 / 损坏 ⇒ 空数组（这是证据不是状态，读不到不该让界面报错）。 */
export async function readInstallRecords(root) {
	if (typeof root !== 'string' || !root.trim()) { return []; }
	try {
		const parsed = JSON.parse(await readFile(join(root, INSTALL_RECORD_FILE), 'utf8'));
		return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object') : [];
	} catch { return []; }
}

/**
 * 「已安装、但当前运行的 Host 还没加载」的包（生效态，对标官方 `restart-status`）。
 *
 * 判据（只用 Host 自己知道的事实，不猜）：某包**最新一条**记录是 `restart-required`，
 * 且它写入的时间**晚于当前 Host 进程的启动时间** ⇒ 装的时候这个 Host 已经在跑了，
 * 它不会热加载新包 ⇒ 还没生效。重启之后 Host 启动时间晚于记录 ⇒ 自动消失，不需要任何"已读"状态。
 *
 * 「最新一条」按包名取：同一个包后来又装失败 / 被取消 / 装成 applied，都会顶掉更早的 restart-required，
 * 否则提示会一直挂着一个已经不成立的结论。
 *
 * @param {Array<{name?:string,version?:string,application?:string,at?:string}>} records 最新在前
 * @param {number} hostStartedAt 毫秒时间戳
 */
export function pendingRestartRecords(records, hostStartedAt) {
	const seen = new Set();
	const pending = [];
	for (const record of Array.isArray(records) ? records : []) {
		const name = record && typeof record.name === 'string' ? record.name : '';
		if (!name || seen.has(name)) { continue; }
		seen.add(name);
		const at = Date.parse(String(record.at ?? ''));
		if (record.application === 'restart-required' && Number.isFinite(at) && at > hostStartedAt) {
			pending.push({ name, version: String(record.version ?? ''), at: record.at });
		}
	}
	return pending;
}

/** 读 + 解包 + 校验一步到位；失败时自己清理。 */
export async function prepareLocalWorkbench(archivePath) {
	const staging = await createStagingDir();
	try {
		const buffer = await readFile(archivePath);
		const pkg = await extractWorkbenchPackage(buffer, join(staging, 'package'));
		return {
			...pkg,
			dir: join(staging, 'package'),
			cleanup: async () => { try { await rm(staging, { recursive: true, force: true }); } catch { /* 清理失败不影响安装结果 */ } },
		};
	} catch (error) {
		try { await rm(staging, { recursive: true, force: true }); } catch { /* ignore */ }
		throw error;
	}
}
