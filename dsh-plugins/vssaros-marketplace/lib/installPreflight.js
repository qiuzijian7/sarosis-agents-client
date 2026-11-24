// @vssaros/dsh-marketplace — 安装前兼容性预检 + 失败分类（★ 2026-11-24 P1）
//
// 对齐上游 @deepseek-ai/dsh-app-boot 的 evaluatePluginCompatibility 与
// @deepseek-ai/dsh-plugin-manager/src/install-failure.ts 的分类思路，但**零依赖**：
//   · 不直接 import 上游 221KB barrel（依赖面大、包解析不可达、runtimeVersion 真源不对）；
//   · 复用同仓 hostVersion.js 的 satisfies（支持 ^ ~ >= > <= < = ||，看不懂返回 null）。
//
// ★ 关键口径（保守，绝不误拒）：
//   本项目商品包的 manifest 没有 engines / peerDependencies（服务端 zod 会 strip 未知键），
//   且宿主版本未必读得到 ⇒「无声明 / 无宿主版本 / 看不懂 range」一律 status='unknown' 放行；
//   只有**明确声明且明确不满足**才 incompatible 并拒装（零落盘）。

import { satisfies } from './hostVersion.js';

/** 安装失败分类码（对齐上游 8 类 + 本项目两类）。 */
export const INSTALL_FAILURE_CODES = Object.freeze({
	E_INCOMPATIBLE_DSH: '插件与宿主 dsh 版本不兼容',
	E_INTEGRITY: '包完整性 / 摘要校验失败',
	E_NOT_FOUND: '包或依赖不存在',
	E_NO_MATCHING_VERSION: '找不到匹配版本',
	E_DISK_FULL: '磁盘空间不足',
	E_PERMISSION: '权限不足',
	E_NETWORK: '网络 / 超时',
	E_BUILD_BLOCKED: '构建脚本被 pnpm 拒绝',
	E_PNPM_MISSING: 'pnpm 不可用',
	E_UNKNOWN: '未分类错误',
});

/** 从解包后的文件里读最浅的 package.json（读不到/坏 JSON 一律返回 null，不阻断）。 */
function readPackageManifest(files) {
	if (!Array.isArray(files)) { return null; }
	const candidates = files
		.filter(f => f && typeof f.path === 'string' && /(^|\/)package\.json$/.test(f.path))
		.sort((a, b) => a.path.split('/').length - b.path.split('/').length);
	for (const f of candidates) {
		try {
			const raw = f.data instanceof Uint8Array ? Buffer.from(f.data).toString('utf8') : String(f.data ?? '');
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object') { return parsed; }
		} catch { /* 坏 JSON ⇒ 换下一个，仍不行就 unknown */ }
	}
	return null;
}

/**
 * 抽出需要校验的版本要求。
 * 上游语义：`engines.dsh` 单独决定并忽略 peerDependencies；否则只查 @deepseek-ai/dsh* peers。
 * `workspace:` / `file:` / `link:` 视为当前 runtime ⇒ 跳过。
 */
function extractRequirements(manifest) {
	const engine = manifest?.engines?.dsh ?? manifest?.dsh?.engines?.dsh;
	if (typeof engine === 'string' && engine.trim()) {
		return { 'engines.dsh': engine.trim() };
	}
	const peers = manifest?.peerDependencies;
	if (!peers || typeof peers !== 'object') { return {}; }
	const out = {};
	for (const [name, range] of Object.entries(peers)) {
		if (!/^@deepseek-ai\/dsh(?:-|$)/.test(name)) { continue; }
		const r = String(range ?? '').trim();
		if (!r || /^(workspace|file|link):/.test(r)) { continue; }
		out[name] = r;
	}
	return out;
}

/**
 * 安装前兼容性预检（纯函数，零落盘）。
 * @param {{ files?: Array<{path:string,data:Buffer|string}>, runtimeVersion?: string }} args
 * @returns {{ status:'ok'|'unknown'|'incompatible', code:string|null, requirements:Record<string,string>, message:string }}
 */
export function preflightCompatibility({ files = [], runtimeVersion = '' } = {}) {
	const manifest = readPackageManifest(files);
	const requirements = manifest ? extractRequirements(manifest) : {};
	const base = { requirements, code: null };
	if (!manifest) {
		return { ...base, status: 'unknown', message: '包内没有 package.json，跳过兼容性门禁（不阻断）' };
	}
	if (Object.keys(requirements).length === 0) {
		return { ...base, status: 'unknown', message: '包内没有 engines.dsh / dsh peer 声明，跳过兼容性门禁（不阻断）' };
	}
	const host = String(runtimeVersion ?? '').trim();
	if (!host) {
		return { ...base, status: 'unknown', message: '读不到当前 dsh 版本，兼容性未知（不阻断）' };
	}
	for (const [name, range] of Object.entries(requirements)) {
		const ok = satisfies(host, range);
		if (ok === null) {
			return { ...base, status: 'unknown', message: `看不懂版本范围 ${name}: ${range}（不阻断）` };
		}
		if (ok === false) {
			return {
				status: 'incompatible', code: 'E_INCOMPATIBLE_DSH', requirements,
				message: `${name} 要求 ${range}，当前宿主 dsh 为 ${host}`,
			};
		}
	}
	return { ...base, status: 'ok', message: `兼容性满足（宿主 dsh ${host}）` };
}

// 顺序敏感：更具体的分类要放在更宽泛的「不存在 / 权限 / 网络」之前
const FAILURE_RULES = [
	['E_INCOMPATIBLE_DSH', /不兼容|incompatible with DSH|兼容性检查未通过/i],
	['E_INTEGRITY', /sha256|integrity|摘要|校验|穿越|恶意|包可能损坏|坏包/i],
	['E_NO_MATCHING_VERSION', /ETARGET|NO_MATCHING_VERSION|版本不存在|没有可用版本|找不到匹配版本/i],
	['E_NOT_FOUND', /ERR_PNPM_FETCH_404|\bE404\b|\b404\b|not found|下载不到|不存在/i],
	['E_BUILD_BLOCKED', /IGNORED_BUILDS|allowBuilds|build scripts|prepare script/i],
	['E_DISK_FULL', /ENOSPC|disk full|磁盘(空间)?不足/i],
	['E_PERMISSION', /EACCES|EPERM|permission denied|权限不足/i],
	['E_PNPM_MISSING', /pnpm was not found|pnpm 未找到|exit code 127/i],
	['E_NETWORK', /ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|timeout|超时|网络/i],
];

/**
 * 把安装错误归一化成结构化分类码（**保留原文**，调用方仍用 error 字段展示）。
 * @param {unknown} err
 * @returns {{ code: string, category: string, message: string }}
 */
export function classifyInstallError(err) {
	const message = String(err?.message ?? err ?? '');
	const explicit = String(err?.code ?? '');
	if (explicit.startsWith('E_') && INSTALL_FAILURE_CODES[explicit]) {
		return { code: explicit, category: INSTALL_FAILURE_CODES[explicit], message };
	}
	for (const [code, re] of FAILURE_RULES) {
		if (re.test(message)) { return { code, category: INSTALL_FAILURE_CODES[code], message }; }
	}
	return { code: 'E_UNKNOWN', category: INSTALL_FAILURE_CODES.E_UNKNOWN, message };
}
