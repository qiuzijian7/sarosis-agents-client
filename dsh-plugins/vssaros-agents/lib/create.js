// @vssaros/dsh-agents — create（主机侧 I/O）：把新建向导的草稿写成 <agent 根>/<id>/.agent.md。
//
// 2026-10-16，方案 A / Q7 = ①：插件直接写（与建群 groups.js、授权模板 templates.js 同一种写口）。
// 不过审批的理由：这是用户在表单上亲手点的「创建」，不是模型发起的写入；且**只新建、不覆盖** ——
// 目录已存在（哪怕里面没有 .agent.md）一律 409，落盘用 mkdir（非 recursive）+ writeFile 'wx' 双保险，
// 并发两次同 id 也只有一次能成功 ✓。
// 写完由 index.js 立刻 syncPresets ⇒ 不用重启 Host 就进 dsh 花名册（p3-06 已有增量同步的真机断言）。

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { AGENT_FILE, presetIdOf, toPresetDefinition } from './core/agents.js';
import { normalizeDraft, serializeAgentMd, stripModelFromAgentMd, validateDraft } from './core/create.js';
import { agentsRootOf, scanAgents } from './store.js';

const httpError = (status, message, extra) => Object.assign(new Error(message), { httpStatus: status }, extra ?? {});

/** 数据根下已有的目录名（不存在 ⇒ 空）。 */
async function existingIdsOf(root) {
	try {
		const entries = await readdir(root, { withFileTypes: true });
		return entries.filter(e => e.isDirectory()).map(e => e.name);
	} catch (e) {
		if (e?.code === 'ENOENT') {
			return [];
		}
		throw e;
	}
}

/**
 * 只校验不写（向导实时预览用）：返回归一草稿、errors / warnings、序列化原文与落盘路径。
 * 读目录失败不抛 —— 按「不知道有哪些」继续校验，写入时还会再查一次 ✓。
 */
export async function previewAgentDraft(config, raw) {
	const root = agentsRootOf(config);
	const draft = normalizeDraft(raw);
	const existingIds = await existingIdsOf(root).catch(() => []);
	const result = validateDraft(draft, { existingIds, provider: config?.defaultProvider, isAbsolute });
	return {
		draft,
		...result,
		agentMd: serializeAgentMd(draft),
		file: draft.id ? join(root, draft.id, AGENT_FILE) : '',
	};
}

/** 校验 + 写入。错误带 httpStatus（400 = 字段不合法，409 = 已存在）。 */
export async function createAgentFromDraft(config, raw) {
	const root = agentsRootOf(config);
	const preview = await previewAgentDraft(config, raw);
	if (preview.errors.length) {
		const dup = preview.errors.some(e => e.startsWith('已有同名目录') || e.includes('撞了 preset id'));
		throw httpError(dup ? 409 : 400, preview.errors.join('；'), { errors: preview.errors });
	}
	const dir = join(root, preview.draft.id);
	await mkdir(root, { recursive: true });
	try {
		await mkdir(dir);
	} catch (e) {
		if (e?.code === 'EEXIST') {
			throw httpError(409, '已有同名目录 ' + preview.draft.id + '：不会覆盖，换一个 id');
		}
		throw e;
	}
	try {
		await writeFile(preview.file, preview.agentMd, { encoding: 'utf8', flag: 'wx' });
	} catch (e) {
		// 写失败别留一个空目录（否则下次同 id 永远 409、用户看不出为什么）
		await rmdir(dir).catch(() => undefined);
		throw e;
	}
	return { id: preview.draft.id, name: preview.draft.name, presetId: preview.presetId, file: preview.file, warnings: preview.warnings };
}

/**
 * 「改为跟随默认」（2026-10-17，方案 A 第 4 步遗留 ①）：删掉某个 Agent 的 `model:` 行。
 *
 * 这是**改已有文件**，所以口子收得比新建更窄：
 *   · id 必须是当下扫描到的 Agent（封闭集，不接受路径）；
 *   · **只在它的模型确实「未映射」时才动**（判据 = toPresetDefinition 的 notes，与页面琥珀标同一口径）——
 *     能路由的模型一律 409，不会被误删；
 *   · 只删那一行（core/create.js 的 stripModelFromAgentMd），其余字节原样；
 *   · 先写同目录临时文件再 rename 替换（写到一半崩了也不会留下半截 .agent.md）。
 */
export async function resetAgentModel(config, rawId) {
	const id = String(rawId ?? '').trim();
	const scan = await scanAgents(agentsRootOf(config), undefined);
	const agent = scan.agents.find(a => a.id === id);
	if (!agent) {
		throw httpError(404, '没有这个 Agent：' + (id || '(空)'));
	}
	const provider = typeof config?.defaultProvider === 'string' ? config.defaultProvider.trim() : '';
	const { notes } = toPresetDefinition(agent, { provider });
	if (!agent.model) {
		throw httpError(409, agent.name + ' 已经是跟随默认模型，不用改');
	}
	if (!notes.some(n => n.startsWith('模型未映射'))) {
		throw httpError(409, agent.name + ' 的模型 ' + agent.model + ' 可以路由，不需要改');
	}
	const before = await readFile(agent.file, 'utf8');
	const stripped = stripModelFromAgentMd(before);
	if (stripped.error) {
		throw httpError(409, stripped.error);
	}
	const tmp = agent.file + '.tmp-' + randomUUID().slice(0, 8);
	try {
		await writeFile(tmp, stripped.text, { encoding: 'utf8', flag: 'wx' });
		await rename(tmp, agent.file);
	} catch (e) {
		await unlink(tmp).catch(() => undefined);
		throw e;
	}
	return { id: agent.id, name: agent.name, presetId: presetIdOf(agent.id), file: agent.file, oldModel: agent.model, removed: stripped.removed };
}
