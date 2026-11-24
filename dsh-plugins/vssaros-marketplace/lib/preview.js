// @vssaros/dsh-marketplace — **安装前预览**（★ 2026-11-10 P0：安全与信任）
//
// 借鉴官方 dsh-desktop 的 `.dshpreset` 导入：装之前先把「包里有什么 / 来源是谁 /
// 有没有可疑内容」摊开给人看，两步（预览 → 确认）才落盘。
// 这里是**纯函数**：不碰网络、不碰磁盘、不改任何状态 ⇒ 可被守卫直接单测。
//
import { satisfies } from './hostVersion.js';

/**
 * ★ 2026-11-24：解析 `distribution.peerRange`。
 * 它是 `peerRangeOf()` 压出来的一行 `name@range name@range`（最多 500 字符），
 * 而 range 自身可能含空格分隔的多个比较器（`>=0.1.7-0 <0.3.0-0`）
 * ⇒ 只按「下一条 name@ 的起点」切段，绝不按空格硬切。
 * 只保留 `@deepseek-ai/dsh*` 前缀（与 hostVersion.js 的 HOST_PEERS 同口径）。
 */
function dshPeerEntries(peerRange) {
	const raw = String(peerRange ?? '').trim();
	if (!raw) { return []; }
	const re = /(?:^|\s)(@?[a-z0-9][a-z0-9._~-]*(?:\/[a-z0-9][a-z0-9._~-]*)?)@/gi;
	const marks = [];
	let m;
	while ((m = re.exec(raw))) {
		marks.push({ name: m[1], start: m.index, from: m.index + m[0].length });
	}
	const out = [];
	for (let i = 0; i < marks.length; i++) {
		if (!/^@deepseek-ai\/dsh(?:-|$)/.test(marks[i].name)) { continue; }
		const end = i + 1 < marks.length ? marks[i + 1].start : raw.length;
		const range = raw.slice(marks[i].from, Math.max(marks[i].from, end)).trim();
		if (range) { out.push({ name: marks[i].name, range }); }
	}
	return out;
}
// ⚠ 语义分级（别一刀切）：
//   · danger ⇒ 前端禁用「确认安装」（真凭据形态 / 缺校验 / 当前根本装不了）
//   · warn  ⇒ 只提示，仍可安装（绝对路径、未锁 commit 等「可装但要注意」）

/** 只扫文本类文件，且单个 ≤512KB（二进制封面/模型不扫，也不进 UI）。 */
const SCANNABLE = /\.(md|txt|json|ya?ml|js|mjs|cjs|ts|tsx|py|sh|ps1|bat|toml|ini|env|conf|html|css|xml)$/i;
const MAX_SCAN_BYTES = 512 * 1024;
const MAX_SCAN_FILES = 200;
const MAX_WARNINGS = 30;

const RULES = [
	{ level: 'danger', re: /\bsk-[A-Za-z0-9_-]{20,}\b/, text: '疑似 API 私钥（sk-…）' },
	{ level: 'danger', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, text: '疑似 GitHub 令牌（ghp_/gho_/…）' },
	{ level: 'danger', re: /\bAKIA[0-9A-Z]{16}\b/, text: '疑似 AWS Access Key' },
	{ level: 'danger', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, text: '包内含私钥 PEM' },
	{ level: 'warn', re: /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*['"][^'"\s]{12,}/i, text: '疑似硬编码凭据赋值' },
	{ level: 'warn', re: /(?:\/Users\/[A-Za-z0-9._-]+\/|[A-Z]:\\Users\\[A-Za-z0-9._-]+\\|\/home\/[a-z][a-z0-9_-]*\/)/, text: '含开发机绝对路径' },
];

/**
 * 扫包内文本文件，返回去重后的告警。
 *
 * @param {Array<{path?: string, data?: Buffer}>} files
 * @returns {{ warnings: Array<{level: string, text: string, file: string}>, scanned: number, blocked: boolean }}
 */
export function scanPackageFiles(files) {
	const list = Array.isArray(files) ? files : [];
	const warnings = [];
	const seen = new Set();
	let scanned = 0;
	for (const f of list) {
		if (scanned >= MAX_SCAN_FILES || warnings.length >= MAX_WARNINGS) { break; }
		const p = String(f?.path ?? '');
		if (!SCANNABLE.test(p)) { continue; }
		const data = f?.data;
		if (!data || !data.length || data.length > MAX_SCAN_BYTES) { continue; }
		scanned++;
		const text = data.toString('utf8');
		for (const rule of RULES) {
			if (!rule.re.test(text)) { continue; }
			const key = rule.level + '|' + rule.text + '|' + p;
			if (seen.has(key)) { continue; }
			seen.add(key);
			warnings.push({ level: rule.level, text: rule.text, file: p });
			if (warnings.length >= MAX_WARNINGS) { break; }
		}
	}
	return {
		warnings,
		scanned,
		blocked: warnings.some(w => w.level === 'danger'),
	};
}

/**
 * 外部发布源只看**登记字段**就给出的告警（预览不下载外链本体）。
 *
 * @param {unknown} dist
 * @param {string} kind
 */
export function distributionWarnings(dist, kind, opts = {}) {
	const out = [];
	if (!dist || typeof dist !== 'object' || !dist.type) { return out; }
	const d = dist;
	if (d.type === 'github-source' && !d.commit) {
		out.push({ level: 'warn', text: 'GitHub 源未锁定 commit：上游 push 会改变装到的代码，建议作者补发带 commit 的版本' });
	}
	if (d.type === 'github-release' && !d.sha256) {
		out.push({ level: 'danger', text: 'github-release 缺 sha256：安装链会拒装（不校验就不装）' });
	}
	if (d.type === 'npm' && kind !== 'plugin' && kind !== 'workbench') {
		out.push({ level: 'danger', text: 'npm 发布源 + 资源类商品：dsh 侧暂不支持安装，请作者改用 GitHub 地址' });
	}
	if (d.type === 'npm' && !d.name) {
		out.push({ level: 'danger', text: 'npm 发布源缺少包名' });
	}

	// ★ 2026-11-24：外部源登记了 peerRange ⇒ 按宿主版本给「只提示、不阻断」的兼容性提示。
	//   宿主版本由调用方注入（本文件保持纯函数、不读磁盘）；读不到 / range 看不懂 ⇒ 不判定。
	//   与 checkPeerCompat 同口径：绝不因版本要求把 warn 升级成 danger（不禁用安装按钮）。
	const host = String(opts?.runtimeVersion ?? '').trim();
	if (host && d.peerRange) {
		for (const { name, range } of dshPeerEntries(d.peerRange)) {
			if (satisfies(host, range) === false) {
				out.push({
					level: 'warn',
					text: `当前宿主 dsh ${host} 不满足发布源登记的 ${name} ${range}：可能装不上或运行异常（仅提示，不阻断安装）`,
				});
			}
		}
	}
	return out;
}

/** 把 distribution 变成可直接渲染的字段行（含 pin commit 与 sha256）。 */
export function summarizeDistribution(dist) {
	if (!dist || typeof dist !== 'object' || !dist.type) {
		return { label: '商城自带包（bundle）', fields: [] };
	}
	const d = dist;
	const fields = [{ k: '发布源类型', v: String(d.type) }];
	if (d.name) { fields.push({ k: '包名 / 仓库', v: String(d.name) }); }
	if (d.url) { fields.push({ k: '资产地址', v: String(d.url) }); }
	if (d.commit) { fields.push({ k: '锁定 commit', v: String(d.commit) }); }
	if (d.sha256) { fields.push({ k: 'sha256', v: String(d.sha256) }); }
	if (d.peerRange) { fields.push({ k: '宿主版本要求', v: String(d.peerRange) }); }
	return { label: '外部发布源（' + String(d.type) + '）', fields };
}

/** 把预览结果收成前端需要的形状（单一出口，别在 index.js 里手拼）。 */
export function finishPreview(base, scan) {
	const warnings = base.warnings.concat(scan ? scan.warnings : []);
	return {
		...base,
		warnings: warnings.slice(0, MAX_WARNINGS),
		scanned: scan ? scan.scanned : 0,
		blocked: warnings.some(w => w.level === 'danger'),
	};
}
