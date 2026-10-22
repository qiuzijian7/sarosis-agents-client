// @vssaros/dsh-agents — create（主机侧 I/O）：把新建向导的草稿写成 <agent 根>/<id>/.agent.md。
//
// 2026-10-16，方案 A / Q7 = ①：插件直接写（与建群 groups.js、授权模板 templates.js 同一种写口）。
// 不过审批的理由：这是用户在表单上亲手点的「创建」，不是模型发起的写入；且**只新建、不覆盖** ——
// 目录已存在（哪怕里面没有 .agent.md）一律 409，落盘用 mkdir（非 recursive）+ writeFile 'wx' 双保险，
// 并发两次同 id 也只有一次能成功 ✓。
// 写完由 index.js 立刻 syncPresets ⇒ 不用重启 Host 就进 dsh 花名册（p3-06 已有增量同步的真机断言）。

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { AGENT_FILE, agentFromFile, isHiddenAgent, presetIdOf, toPresetDefinition } from './core/agents.js';
import { AGENT_ID_RE, normalizeDraft, serializeAgentMd, setMemoryFrontmatter, setSubagentFlag, stripModelFromAgentMd, validateDraft } from './core/create.js';
import { MEMORY_CHARS_MAX, MEMORY_CHARS_MIN, normalizeMemoryMode } from './core/memoryLimits.js';
import { agentsBuiltinRootOf, agentsRootOf, scanAgents, scanAgentsFromConfig } from './store.js';

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
 * 改一个已有 Agent 的记忆注入口径（`memory-chars` / `memory-mode`，2026-10-19，「记忆」页签用）。
 *
 * 口子收得跟 `resetAgentModel` 一样窄：id 必须是当下扫描到的 Agent（封闭集）、只动 frontmatter
 * 那两行（`setMemoryFrontmatter`）、写完重新解析校验一遍（防止写出一个自己都认不出的文件）。
 */
/**
 * 开关一个 agent 的「允许被 subagent 选用」（`.agent.md` 的 `subagent: true`，2026-10-20）。
 *
 * 为什么需要它：委派清单（`allowedAgentPresets`）改成 opt-in 后，得有个不改文件的入口。
 * 口径：
 *   · **内置 agent 拒绝**（403）：它们的 `.agent.md` 每次 Host 启动都由 `buildAgentMd` 重新生成，
 *     在页面上改会被覆盖 ⇒ 真源是 `common/builtinAgents.ts`；
 *   · 隐藏的（助理）拒绝（400）：它连名册都不显示，不该成为委派目标；
 *   · 只动 `subagent` 那**一行**（`setSubagentFlag`），正文/其它字段逐字不动；
 *   · 写完重新解析一遍，解析不了就放弃写入（与 resetAgentModel / setAgentMemoryLimits 同纪律）。
 */
export async function setAgentSubagent(config, agentId, enabled) {
	const id = String(agentId ?? '').trim();
	if (!id) {
		throw httpError(400, 'set-subagent 需要 id');
	}
	const scan = await scanAgentsFromConfig(config);
	const agent = (scan.agents ?? []).find(a => a.id === id);
	if (!agent?.file) {
		throw httpError(404, `没有这个 agent：${id}`);
	}
	if (agent.source === 'builtin') {
		throw httpError(403, `${id} 是内置 agent：它的 .agent.md 每次启动都会重新生成，委派开关要改 common/builtinAgents.ts（页面上改会被覆盖）`);
	}
	if (isHiddenAgent(id)) {
		throw httpError(400, `${id} 是隐藏的 agent（助理），不能作为委派目标`);
	}
	const text = await readFile(agent.file, 'utf8');
	const edited = setSubagentFlag(text, enabled === true);
	if (edited.error) {
		throw httpError(400, edited.error);
	}
	const check = agentFromFile(edited.text, { id: agent.id, file: agent.file });
	if (check.error) {
		throw httpError(400, `改完反而解析不了（已放弃写入）：${check.error}`);
	}
	const tmpFile = agent.file + '.tmp-' + randomUUID();
	await writeFile(tmpFile, edited.text, 'utf8');
	await rename(tmpFile, agent.file);
	return { id: agent.id, delegatable: check.agent.delegatable === true, presetId: presetIdOf(agent.id) };
}

export async function setAgentMemoryLimits(config, agentId, input = {}) {
	const id = String(agentId ?? '').trim();
	const scan = await scanAgents(agentsRootOf(config), undefined);
	const agent = scan.agents.find(a => a.id === id);
	if (!agent?.file) {
		// 目录在、但没进扫描结果 ⇒ 定义本身坏了（frontmatter 解析失败）。别报成"没有这个 agent"
		// ——那会让人以为文件不存在，实际是文件存在但解析不了（两种修法完全不同）。
		const broken = await stat(join(agentsRootOf(config), id, AGENT_FILE)).then(() => true, () => false);
		if (broken) {
			throw httpError(400, `agent ${id} 的 .agent.md 解析不了（frontmatter 坏了），先修好再改记忆口径`);
		}
		throw httpError(404, `没有这个 agent：${id}`);
	}
	const charsRaw = input?.chars;
	let chars;
	if (charsRaw === undefined || charsRaw === null || String(charsRaw).trim() === '') {
		chars = undefined;
	} else {
		chars = Number(charsRaw);
		if (!Number.isFinite(chars)) {
			throw httpError(400, `memory-chars 要是数字：${String(charsRaw)}`);
		}
		if (chars !== 0 && (chars < MEMORY_CHARS_MIN || chars > MEMORY_CHARS_MAX)) {
			throw httpError(400, `memory-chars 要在 ${MEMORY_CHARS_MIN}~${MEMORY_CHARS_MAX} 之间（0 = 关闭注入）`);
		}
	}
	const modeRaw = input?.mode;
	const mode = modeRaw === undefined || modeRaw === null || String(modeRaw).trim() === ''
		? undefined
		: normalizeMemoryMode(modeRaw);

	const text = await readFile(agent.file, 'utf8');
	const edited = setMemoryFrontmatter(text, { chars, mode });
	if (edited.error) {
		throw httpError(400, edited.error);
	}
	const check = agentFromFile(edited.text, { id: agent.id, file: agent.file });
	if (check.error) {
		throw httpError(400, `改完反而解析不了（已放弃写入）：${check.error}`);
	}
	// 先写临时文件再 rename：写一半崩了也不会留下半截 .agent.md（与 resetAgentModel 同口径）
	const tmpFile = agent.file + '.tmp-' + randomUUID();
	await writeFile(tmpFile, edited.text, 'utf8');
	await rename(tmpFile, agent.file);
	return {
		id: agent.id,
		chars: check.agent.memoryChars,
		mode: check.agent.memoryMode,
		file: agent.file,
	};
}

/**
 * 删除一个 Agent（2026-10-20，侧栏右键「删除 Agent」）。
 *
 * 口径（都是"出事过"的地方）：
 *   ① **只删自定义目录里的 agent**：id 必须过 `AGENT_ID_RE`（挡 `../x`、`/abs`、`a/b`）；
 *   ② **内置 agent 一律拒绝**（403）：它们的 md 由 Host 启动期重新生成，删了会"删了又回来"，
 *      而且内置是代码资产不是用户数据；
 *   ③ 目录里必须真的有 `.agent.md` 才动手（避免把一个"恰好同名的普通目录"删掉）；
 *   ④ 整个目录删（含 `memory/` 与 `.git`）——回执把 name / dir 带回去，页面在确认框里先讲清楚；
 *   ⑤ 不负责撤销：删掉就是删掉（确认框是唯一防线）。
 *      preset 的注销由调用方 `syncPresets` 完成（源文件消失 ⇒ 撤注册，已有逻辑）。
 */
export async function deleteAgent(config, agentId) {
	const id = String(agentId ?? '').trim();
	if (!id) {
		throw httpError(400, 'delete 需要 id');
	}
	if (!AGENT_ID_RE.test(id) || id.endsWith('.')) {
		throw httpError(400, `id 不合法：${JSON.stringify(id)}（只允许字母/数字/.-_，不能带路径）`);
	}
	const builtinRoot = agentsBuiltinRootOf(config);
	if (builtinRoot && await stat(join(builtinRoot, id)).then(() => true, () => false)) {
		throw httpError(403, `${id} 是内置 agent，不能删除（内置定义在代码里，下次启动还会生成）`);
	}
	const root = agentsRootOf(config);
	const dir = join(root, id);
	const md = join(dir, AGENT_FILE);
	if (!await stat(md).then(() => true, () => false)) {
		throw httpError(404, `没有这个 agent：${id}（找不到 ${AGENT_FILE}）`);
	}
	const scan = await scanAgents(root, undefined).catch(() => ({ agents: [] }));
	const name = (scan.agents ?? []).find(a => a.id === id)?.name ?? id;
	await rm(dir, { recursive: true, force: false });
	return { id, name, dir, removed: true, presetId: presetIdOf(id) };
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
