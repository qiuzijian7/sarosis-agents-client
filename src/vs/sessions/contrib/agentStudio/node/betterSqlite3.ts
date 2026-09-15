/*---------------------------------------------------------------------------------------------
 *  betterSqlite3.ts — better-sqlite3 统一加载器（主进程）。
 *
 *  背景（2026-09-14 生产事故：media.import 报 "media store unavailable"）：
 *  安装包产物里 `resources/app/node_modules` 是**真实目录**，而原生绑定
 *  `better_sqlite3.node` 只被 build/saros/strip-before-pack.mjs 复制到
 *  `node_modules.asar.unpacked/better-sqlite3/build/Release/` 下。
 *  `require('better-sqlite3')` 只加载 JS 壳（成功），真正的 dlopen 发生在
 *  `new Database()` 内部 —— better-sqlite3 用 `bindings` 按包内相对路径
 *  （`build/Release/better_sqlite3.node`）查找，找不到就抛
 *  "Could not locate the bindings file"，被上层 catch 吞掉后表现为
 *  "media store unavailable (better-sqlite3 failed to load)"。
 *
 *  因此这里显式解析 .node 路径，并通过 better-sqlite3 官方支持的
 *  `nativeBinding` 选项传入（覆盖 asar / asar.unpacked / 真实 node_modules /
 *  仓库 dev 形态），不再依赖 bindings 的默认查找逻辑。
 *
 *  ⚠ better-sqlite3 是 V8 API 模块（非 N-API），.node 必须与 Electron 的
 *  NODE_MODULE_VERSION 匹配（Electron 39 = 140）。升级 Electron 需重编
 *  build/saros/bin/sqlite/better_sqlite3.node 并同步更新本文件的说明。
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// ⚠ 主进程编译产物是 **ESM**（package.json `"type": "module"`），ESM scope 里没有
// `require` —— 裸 `require('better-sqlite3')` 会抛
// `ReferenceError: require is not defined in ES module scope`。必须用 createRequire，
// 与图谱的 `@vscode/sqlite3`、gitVersionEngine 等既有范式一致。
const nodeRequire = createRequire(import.meta.url);

const PACKAGE_NAME = 'better-sqlite3';
/** 包内标准绑定路径（bindings 默认查找的首选位置）。 */
const BINDING_SUBPATH = path.join('build', 'Release', 'better_sqlite3.node');
/** dev 形态：仓库内手工放置的 Electron-ABI 绑定。 */
const DEV_BINDING_SUBPATH = path.join('build', 'saros', 'bin', 'sqlite', 'better_sqlite3.node');

export interface IBetterSqlite3Load {
	/** better-sqlite3 构造函数（CJS 壳）；null = 壳都无法加载。 */
	readonly Database: any | null;
	/** 显式解析到的原生绑定绝对路径；undefined = 未找到（交回 bindings 默认逻辑）。 */
	readonly nativeBinding: string | undefined;
	/** 诊断信息（采用的绑定路径或查找失败清单 + 加载错误）。 */
	readonly diagnostic: string;
}

/** `.../node_modules.asar/...` → `.../node_modules.asar.unpacked/...`（其它路径返回 undefined）。 */
function toUnpacked(p: string): string | undefined {
	const marker = `${path.sep}node_modules.asar${path.sep}`;
	const idx = p.indexOf(marker);
	if (idx < 0) { return undefined; }
	return `${p.slice(0, idx)}${path.sep}node_modules.asar.unpacked${path.sep}${p.slice(idx + marker.length)}`;
}

/** 候选 app 根目录：打包 = <resources>/app，dev = 仓库根（两者编译产物都在 <root>/out/main.js）。 */
function appRoots(): string[] {
	const roots: string[] = [];
	try {
		// import.meta.url 指向主进程 bundle（<appRoot>/out/main.js）
		roots.push(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
	} catch { /* 非 file: 协议（测试环境）忽略 */ }
	const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
	if (resourcesPath) {
		roots.push(path.join(resourcesPath, 'app'));
	}
	try {
		roots.push(process.cwd());
	} catch { /* ignore */ }
	return roots;
}

/** 收集候选绑定路径（去重、保序）。 */
function bindingCandidates(): string[] {
	const out: string[] = [];
	const push = (candidate: string | undefined) => {
		if (!candidate) { return; }
		const normalized = path.normalize(candidate);
		if (!out.includes(normalized)) { out.push(normalized); }
	};

	// ① 按包解析：拿到 JS 壳真实所在目录（dev/asar/真实 node_modules 都适用）
	try {
		const shell = nodeRequire.resolve(PACKAGE_NAME);
		const pkgRoot = path.dirname(path.dirname(shell));
		push(path.join(pkgRoot, BINDING_SUBPATH));
		push(toUnpacked(path.join(pkgRoot, BINDING_SUBPATH)));
	} catch { /* 壳不可解析时靠 ② 兜底 */ }

	// ② 已知 app 根目录下的三种落点（含 asar.unpacked 与仓库 dev 绑定）
	for (const root of appRoots()) {
		push(path.join(root, 'node_modules', PACKAGE_NAME, BINDING_SUBPATH));
		push(path.join(root, 'node_modules.asar.unpacked', PACKAGE_NAME, BINDING_SUBPATH));
		push(path.join(root, DEV_BINDING_SUBPATH));
	}
	return out;
}

let cached: IBetterSqlite3Load | undefined;

/** 加载 better-sqlite3 壳并解析原生绑定（进程内只做一次）。 */
export function loadBetterSqlite3(): IBetterSqlite3Load {
	if (cached) { return cached; }

	let Database: any = null;
	let error: string | undefined;
	try {
		// better-sqlite3 是 CJS 模块，require 直接返回构造函数本身（无 .default）。
		// 注意：esbuild/TS 的 `import X from 'better-sqlite3'` 会转成
		// `({ default: X } = require(...))`，对 CJS 模块解构 .default 会得到 undefined。
		Database = nodeRequire(PACKAGE_NAME);
	} catch (err) {
		error = `require('${PACKAGE_NAME}') failed: ${(err as Error)?.message ?? String(err)}`;
	}

	const tried: string[] = [];
	let nativeBinding: string | undefined;
	for (const candidate of bindingCandidates()) {
		tried.push(candidate);
		try {
			if (fs.existsSync(candidate)) { nativeBinding = candidate; break; }
		} catch { /* ignore */ }
	}

	const diagnostic = [
		nativeBinding ? `native binding: ${nativeBinding}` : `native binding not found; tried: ${tried.join(' | ')}`,
		error,
	].filter(Boolean).join('; ');

	cached = { Database, nativeBinding, diagnostic };
	return cached;
}

/** 便捷构造：自动带上 nativeBinding（若解析到），失败时抛出带诊断的错误。 */
export function createDatabase(dbPath: string, options?: Record<string, unknown>): any {
	const { Database, nativeBinding, diagnostic } = loadBetterSqlite3();
	if (!Database) {
		throw new Error(`better-sqlite3 unavailable — ${diagnostic}`);
	}
	const opts: Record<string, unknown> = { ...(options ?? {}) };
	if (nativeBinding) { opts.nativeBinding = nativeBinding; }
	try {
		return new Database(dbPath, opts);
	} catch (err) {
		throw new Error(`better-sqlite3 open failed (${dbPath}): ${(err as Error)?.message ?? String(err)} [${diagnostic}]`);
	}
}
