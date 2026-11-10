// @vssaros/dsh-marketplace — **统一组合包清单**（★ 2026-11-10 P1-B）
//
// 为什么是「包内独立文件」：`installBundle` 明确把 `manifest.json` 剔除（它是打包元数据，
//   落盘会污染资源目录并在下次发布被当成内容再打进去）⇒ 组件清单必须像 bot.json 一样独立。
//   服务端只透传 `files`，**不需要改 schema / 不需要新扩展名**：沿用现有 package.tar.gz。
//
// 与 bot.json 的关系：bot.json 是「agent + skills + mcp」专用清单，带命名空间自动改写、
//   依赖核对、分项生效回执等 Bot 特有语义；components.json 是它的泛化 —— 任意 4 类组件、
//   由作者显式声明**最终落位 id**，不做运行时改写。二者互斥（同时出现 ⇒ 如实报错）。
//
// 布局约定：
//   · `path` 为空串 ⇒ 该组件承接包根下的文件（最多一个，通常是主组件）
//   · `path` 非空   ⇒ 承接 `<path>/...` 下的文件，落盘时剥掉这段前缀
//   · 所有非元数据文件都必须归属某个组件（闭包），否则报「游离文件」
//   · 主组件必须 `kind === 包的 kind && id === 商城 slug` ⇒ 台账与「已安装」判定才对得上
//   · 非主组件 id 必须带 `<slug>-` 命名空间前缀（与 Bot 包 `namespacePrefixOf` 同款单横线），
//     避免两个组合包用了同一个通用技能名时静默互相覆盖。

import { join } from 'node:path';

export const COMPONENTS_FILE = 'components.json';
export const COMPONENTS_FORMAT = 'vssaros-components';
export const COMPONENT_KINDS = ['skill', 'agent', 'mcp', 'knowledge'];
export const COMPONENT_DIR = { skill: 'skills', agent: 'agents', mcp: 'mcp', knowledge: 'knowledge' };
/** 装完必须存在的入口文件（knowledge 是文档集，任意文件即可）。 */
export const COMPONENT_ENTRY = { skill: 'SKILL.md', agent: '.agent.md', mcp: 'config.json' };

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const META_FILES = new Set(['manifest.json', COMPONENTS_FILE]);

/**
 * 解析并做**结构**校验。包里没有 components.json ⇒ null（走原有单 kind 链路，零影响）。
 * @param {{path:string,data:Buffer}[]} files
 */
export function readComponents(files) {
	const found = (files ?? []).find(f => f.path === COMPONENTS_FILE);
	if (!found) { return null; }
	let j;
	try { j = JSON.parse(found.data.toString('utf8')); }
	catch (e) { throw new Error(`components.json 不是合法 JSON：${String(e?.message ?? e)}`); }
	if (!j || typeof j !== 'object' || Array.isArray(j)) { throw new Error('components.json 必须是对象'); }
	if (j.format !== COMPONENTS_FORMAT) {
		throw new Error(`components.json 的 format 必须是 ${COMPONENTS_FORMAT}（当前 ${String(j.format)}）`);
	}
	if (!Array.isArray(j.components) || j.components.length === 0) {
		throw new Error('components.json 需要非空 components[]');
	}
	const seen = new Set();
	const components = j.components.map((c, i) => {
		if (!c || typeof c !== 'object' || Array.isArray(c)) { throw new Error(`components[${i}] 必须是对象`); }
		const kind = String(c.kind ?? '');
		if (!COMPONENT_KINDS.includes(kind)) {
			throw new Error(`components[${i}].kind 不支持：${kind}（只支持 ${COMPONENT_KINDS.join(' / ')}）`);
		}
		const id = String(c.id ?? '').trim();
		if (!ID_RE.test(id)) {
			throw new Error(`components[${i}].id 非法：${id}（a-z0-9_-，小写字母开头，≤64）`);
		}
		const rawPath = c.path == null ? '' : String(c.path).trim();
		const p = rawPath.replace(/^\/+|\/+$/g, '');
		if (p && (/^[A-Za-z]:/.test(p) || p.split('/').some(s => !s || s === '.' || s === '..'))) {
			throw new Error(`components[${i}].path 不安全：${rawPath}`);
		}
		const key = `${kind}:${id}`;
		if (seen.has(key)) { throw new Error(`components 里有重复的 ${key}`); }
		seen.add(key);
		return { kind, id, path: p };
	});
	if (components.filter(c => !c.path).length > 1) {
		throw new Error('components.json 最多只能有一个 path 为空的根组件');
	}
	return { format: COMPONENTS_FORMAT, components };
}

/**
 * 校验主组件 / 命名空间 / 闭包 / 入口文件，并把包内文件分派到各组件。
 * 发布端与安装端**共用这一份判据** ⇒ 不会出现「发出去但装不上」。
 *
 * @returns {{primary: object, components: object[], buckets: Map<object, Array>}}
 */
export function validateComponents({ files, pack, kind, storeId }) {
	const components = pack?.components ?? [];
	const primary = components.find(c => c.kind === kind && c.id === storeId);
	if (!primary) {
		throw new Error(`组合包必须有主组件（kind=${kind}, id=${storeId}）：否则台账与「已安装」判定对不上`);
	}
	const prefix = `${storeId}-`;
	for (const c of components) {
		if (c === primary) { continue; }
		if (!c.id.startsWith(prefix)) {
			throw new Error(`组件「${c.id}」必须带命名空间前缀 ${prefix}（避免跨包撞名）`);
		}
	}
	const buckets = new Map(components.map(c => [c, []]));
	const root = components.find(c => !c.path);
	for (const f of files ?? []) {
		if (META_FILES.has(f.path)) { continue; }
		// 嵌套 path 时取最长匹配（更具体的组件优先）
		let best = null;
		for (const c of components) {
			if (!c.path) { continue; }
			if (f.path === c.path || f.path.startsWith(`${c.path}/`)) {
				if (!best || c.path.length > best.path.length) { best = c; }
			}
		}
		const target = best ?? root;
		if (!target) {
			throw new Error(`组合包有游离文件：${f.path}（不属于任何组件；可加一个 path 为空的根组件承接）`);
		}
		const rel = best ? f.path.slice(best.path.length).replace(/^\//, '') : f.path;
		if (!rel) { continue; }
		buckets.get(target).push({ ...f, path: rel });
	}
	for (const c of components) {
		const list = buckets.get(c);
		if (!list.length) {
			throw new Error(`组件「${c.kind}:${c.id}」在包里没有实体文件（清单声明了但闭包不成立）`);
		}
		const entry = COMPONENT_ENTRY[c.kind];
		if (entry && !list.some(f => f.path === entry)) {
			throw new Error(`组件「${c.kind}:${c.id}」缺少入口文件 ${entry}`);
		}
	}
	return { primary, components, buckets };
}

/** 把分派结果变成落盘计划（每个组件一个目录）。 */
export function planComponents({ buckets, dataRoot }) {
	const out = [];
	for (const [c, files] of buckets) {
		out.push({ kind: c.kind, id: c.id, dir: join(dataRoot, COMPONENT_DIR[c.kind], c.id), files });
	}
	return out;
}
