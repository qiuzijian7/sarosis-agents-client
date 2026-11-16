// @vssaros/dsh-kb — 飞书剪存轮询的**编排层**（2026-11-11，方案 A）
//
// 第 2~6 步一条链：读正文 → 判定 Clip → 写 数据源/raw → 总结 → 写 知识库列表/<库> → 同步回飞书。
//
// ⚠ 为什么把外部能力做成依赖注入：
//   · `kb_build` 的子代理机制硬性依赖工具执行上下文的 `exec.agent`（活会话 Agent 对象），
//     HTTP 端点 / 定时器拿不到；`vssarosRuns.run()` 虽可用但需要绑定会话与审批白名单。
//   · 所以「总结」是一个注入的纯函数：生产接 `vssarosRuns`，守卫注入 fake ⇒ 全链路可端到端验证。
//   · 总结服务**只返回笔记正文**，写盘一律由 Host 自己做（照 startMindmapGenerateJob 的
//     「只读代理、写由宿主做」模式），彻底绕开子代理审批闸。
//   · 服务不可用 / 目标库未配置时**不写假笔记、不推进游标**，如实返回 pendingSummary ⇒ 下次重试。
//
// ⚠ 幂等：游标只在处理成功后推进；`limit` 限制单轮篇数；并发由 Host 侧 CLIP_STATE.running 防叠加。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
	CLIP_CURSOR_REL, clipConfigOf, clipDocArgs, isClipDoc, nodeListArgs,
	noteMarkdownOf, parseCursor, parseNodeList, rawMarkdownOf, serializeCursor, slugOf,
} from './feishuClip.js';
import { parseDocFetch } from './feishuDocs.js';
import { describeLarkCliFailure } from './feishuSpaces.js';
import { NOTES_DIR, RAW_DIR, resolveRawPath } from './kb.js';

async function writeText(file, text) {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, text, 'utf8');
}

/**
 * 跑一轮剪存轮询。
 * @param {object}  args.cfg       配置（会过 clipConfigOf 归一化）
 * @param {string}  args.vaultRoot 知识库根（根即唯一库根）
 * @param {boolean} args.apply     false = dry-run：只读不写、不推进游标、不调同步
 * @param {object}  args.deps      { lark(args,opts), summarize({title,markdown,targetKb,rawRel}), sync({srcDir,extraMappings,dry}), now() }
 */
export async function runClipPipeline({ cfg, vaultRoot, apply = false, deps = {} } = {}) {
	const c = clipConfigOf(cfg);
	const now = typeof deps.now === 'function' ? deps.now : () => new Date().toISOString();
	const result = {
		ok: true, apply: !!apply, phase: 'idle',
		listed: 0, candidates: [], imported: [], skipped: [], pendingSummary: [],
		sync: null, cursor: null, error: '',
	};
	if (typeof deps.lark !== 'function') {
		return { ...result, ok: false, phase: 'deps', error: '缺少 lark-cli 执行器' };
	}
	const root = String(vaultRoot ?? '').trim();
	if (!root) { return { ...result, ok: false, phase: 'deps', error: '拿不到知识库根目录' }; }
	const cursorFile = join(root, CLIP_CURSOR_REL);
	let cursor = { version: 1, seen: {}, lastRun: '' };
	try { cursor = parseCursor(await readFile(cursorFile, 'utf8')); } catch { /* 首次运行 */ }

	// ① 列节点（轮询源）
	const listed = await deps.lark(nodeListArgs(c.spaceId, c.identity));
	if (!listed || listed.code !== 0) {
		const f = describeLarkCliFailure(
			`${listed?.stderr ?? ''}\n${listed?.stdout ?? ''}`, listed?.code ?? -1, '列举飞书知识库节点');
		return { ...result, ok: false, phase: 'list', error: f.message };
	}
	const nodes = parseNodeList(listed.stdout, listed.stderr);
	result.listed = nodes.length;
	// 只处理没见过的 docx；`objType` 缺字段时放行（不同 CLI 版本字段名可能不同）
	const fresh = nodes
		.filter(n => !cursor.seen[n.id] && (!n.objType || n.objType === 'docx'))
		.sort((a, b) => String(a.createTime || '').localeCompare(String(b.createTime || '')))
		.slice(0, c.limit);
	result.candidates = fresh.map(n => ({ id: n.id, title: n.title }));

	// dry-run：只给计划，不写盘、不推进游标、不调同步
	if (!apply) { result.phase = 'dry-run'; return result; }

	for (const node of fresh) {
		// ② 读正文
		const fetched = await deps.lark(clipDocArgs(node.objToken || node.id));
		if (!fetched || fetched.code !== 0) {
			result.skipped.push({ id: node.id, why: '读正文失败（CLI 非零退出）' });
			continue;   // 不推进游标 ⇒ 下次重试
		}
		const doc = parseDocFetch(fetched.stdout, fetched.stderr);
		if (!doc.ok) { result.skipped.push({ id: node.id, why: doc.error }); continue; }

		// ③ 判定剪存标记
		if (!isClipDoc(doc.content, c.marker)) {
			result.skipped.push({ id: node.id, why: '非剪存文档' });
			cursor.seen[node.id] = { at: now(), skipped: true };
			continue;
		}

		// ④ 写 数据源/raw/<slug>.md（围栏校验 + 素材层无 frontmatter）
		const title = String(doc.title || node.title || '未命名剪存').trim();
		const slug = slugOf(title, node.id);
		const at = now();
		const rawRel = `${RAW_DIR}/${slug}.md`;
		const guarded = resolveRawPath(root, rawRel);
		if (!guarded.inside) {
			return { ...result, ok: false, phase: 'raw', error: `raw 路径越出 ${RAW_DIR}：${guarded.why}` };
		}
		await writeText(guarded.abs, rawMarkdownOf({ title, markdown: doc.content, at }));

		// ⑤ 知识总结（注入；不可用就如实挂起，不写假笔记）
		let body = '';
		if (typeof deps.summarize === 'function') {
			try {
				body = String(await deps.summarize({ title, markdown: doc.content, targetKb: c.targetKb, rawRel }) ?? '').trim();
			} catch (e) { body = ''; result.skipped.push({ id: node.id, why: '总结服务异常：' + String(e?.message ?? e) }); }
		}
		const reason = !body ? '没有可用的总结服务（vssarosRuns）'
			: (!c.targetKb ? '未配置目标知识库 targetKb' : '');
		if (reason) {
			result.pendingSummary.push({ id: node.id, slug, rawRel, why: reason });
			continue;   // 不推进游标 ⇒ 服务恢复/配置补齐后自动重试（raw 同名覆盖，幂等）
		}

		const noteRel = `${NOTES_DIR}/${c.targetKb}/${slug}.md`;
		const note = noteMarkdownOf({ title, body, sourceRel: rawRel, at });
		if (!note) { result.pendingSummary.push({ id: node.id, slug, rawRel, why: '总结结果为空' }); continue; }
		await writeText(join(root, noteRel), note);
		result.imported.push({ id: node.id, title, slug, rawRel, noteRel });
		cursor.seen[node.id] = { at, title, slug, noteRel };
	}

	// ⑥ 同步回飞书：只同步目标库目录（脚本靠 hash 去重，实际只上传变化的一篇）
	if (result.imported.length && c.targetSpaceId && typeof deps.sync === 'function') {
		const srcDir = `${NOTES_DIR}/${c.targetKb}`;
		try {
			result.sync = await deps.sync({
				srcDir,
				extraMappings: [{ dir: srcDir, spaceId: c.targetSpaceId }],
				dry: false,
			});
		} catch (e) { result.sync = { ok: false, error: String(e?.message ?? e) }; }
	}

	cursor.lastRun = now();
	await writeText(cursorFile, serializeCursor(cursor));   // 处理成功后才持久化
	result.phase = 'done';
	result.cursor = { seen: Object.keys(cursor.seen).length, lastRun: cursor.lastRun };
	return result;
}
