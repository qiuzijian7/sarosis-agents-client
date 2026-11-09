/**
 * @vssaros/dsh-skills — 随包技能 provider（2026-11-08，换架构 / L2）。
 *
 * ★ 为什么要自己注册：原来 `vssaros-skill-bundle/cordis.patch.yml` 用官方
 *   `dsh-skill-filesystem` 的 `bundledSkillDir` 把 173 个技能注册在 **host 平面 = global 层**，
 *   `dsh-skill` 的 `collectFresh()` 把 global 层无条件并进每个 agent 的候选集 ⇒ 目录永远 230 行。
 *   官方 provider 的 Config 没有「按名字/按 scope 过滤」字段，所以只能自己注册。
 *
 * ★ 为什么不按 agent 逐个挂 provider：`collect()` 的缓存键含 `scopeChainOf(options.scope)`
 *   （`dsh-skill/lib/index.js:270`），同一个 global provider 在 `list(options)` 里按
 *   `options.scope` 返回不同的 `invocation`，每个 agent 自然隔离，无需 `agent/created` 生命周期管理。
 *
 * ★ 为什么用 `modelInvocable:false` 而不是删 candidate：
 *   `ctx.skills.get(name)` 走 `collect().entries.get(name)`，删了就报 "skill xxx is unknown"，
 *   原生 `skill` 工具 / `/name` 手势 / 全文加载全断。标记只影响官方目录的
 *   `filter(isModelInvocable)` ⇒ 目录收窄但技能仍可达（这正是「分级而非删减」）。
 *
 * candidate 形状逐字段对齐官方 `dsh-skill-filesystem/lib/index.js:599-614`，
 * 满足 `validateCandidate()`（name/description/invocation/source/rank/provider）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 与官方 bundled root 同 rank（600），保持同名裁决语义不变。 */
export const BUNDLED_RANK = 600;
export const BUNDLED_PROVIDER_NAME = 'vssaros-bundled';
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 从 SKILL.md 读 frontmatter 的 name/description/whenToUse + 正文（与官方 parseSkillFile 同口径）。 */
export function parseBundledSkill(file) {
	if (!file || !existsSync(file)) { return undefined; }
	let raw;
	try { raw = readFileSync(file, 'utf8'); } catch { return undefined; }
	if (!raw.startsWith('---')) { return undefined; }
	const end = raw.indexOf('\n---', 3);
	if (end < 0) { return undefined; }
	const head = raw.slice(raw.indexOf('\n', 3) + 1, end).replace(/\r/g, '');
	const body = raw.slice(end + 4).trim();
	const field = (key) => {
		const hit = new RegExp('^' + key + '\\s*:\\s*(.*)$', 'm').exec(head);
		return hit ? hit[1].trim().replace(/^["']|["']$/g, '') : undefined;
	};
	const name = field('name');
	const description = field('description');
	if (!name || !description || !SKILL_NAME.test(name)) { return undefined; }
	const whenToUse = field('whenToUse');
	const disabled = /^disable-model-invocation:\s*true\s*$/m.test(head);
	const userInvocable = !/^user-invocable:\s*false\s*$/m.test(head);
	return {
		name, description, body,
		...(whenToUse ? { whenToUse } : {}),
		invocation: { modelInvocable: !disabled, userInvocable },
	};
}

/**
 * 构造 provider。
 * @param opts `{ index: Map<name,{tier,path,name,description}>, mode: 'attached'|'legacy',
 *                dataRoot, agentIdOfPreset, attachmentsForAgent, logger? }`
 */
export function createBundledProvider(opts = {}) {
	const index = opts.index instanceof Map ? opts.index : new Map();
	const library = opts.library instanceof Map ? opts.library : null;
	const mode = opts.mode === 'legacy' ? 'legacy' : 'attached';
	// ★ 2026-11-09：`dataRoot` 改惰性（`string | () => string`）。`dataRootOf()` 依赖 foundation
	//   服务，在 `registerProvider` 工厂回调里同步调用会抛「服务未绑定」；移到 `list()` 求值即可。
	const resolveDataRoot = typeof opts.dataRoot === 'function' ? opts.dataRoot : () => opts.dataRoot;
	const agentIdOfPreset = opts.agentIdOfPreset ?? (() => '');
	const attachmentsForAgent = opts.attachmentsForAgent;
	/** 会话级临时挂载（`capability_attach` 工具写入）；null = 未启用。 */
	const sessionAttachments = opts.sessionAttachments ?? null;
	const log = typeof opts.logger === 'function' ? opts.logger : () => {};

	/** 缓存解析结果（path → parsed），技能文件在运行期不会频繁改，避免每轮 173 次读盘。 */
	const parsedCache = new Map();
	const parsedOf = (file) => {
		if (parsedCache.has(file)) { return parsedCache.get(file); }
		const value = parseBundledSkill(file);
		parsedCache.set(file, value);
		return value;
	};

	return {
		name: BUNDLED_PROVIDER_NAME,
		async list(options) {
			if (options?.signal?.aborted) { return []; }
			let dataRoot = '';
			try { dataRoot = String(resolveDataRoot() ?? ''); }
			catch (error) { log(`[capabilities] dataRoot 解析失败（不影响随包技能）：${String(error?.message ?? error)}`); }
			const preset = options?.scope?.session?.header?.agentPreset
				?? options?.scope?.header?.agentPreset ?? '';
			let attached = null;
			if (mode === 'attached' && typeof attachmentsForAgent === 'function') {
				try {
					const result = await attachmentsForAgent(preset, dataRoot, library ?? index, agentIdOfPreset);
					// ★ 2026-11-09 真机事故：这里必须是 `Set|null`。旧代码在两条兜底分支传了
					//   `{ names, problems }` 对象 ⇒ `.has` 抛错 ⇒ 官方把整个 provider skip ⇒
					//   173 个技能全丢。除修源头外，在这里做形状校验：非法一律退回全量
					//   （宁可目录大，也绝不让技能凭空消失），并打日志让守卫/运维看得见。
					const raw = result?.names;
					if (raw !== null && !(raw instanceof Set)) {
						log(`[capabilities] attach 集形状非法（${Object.prototype.toString.call(raw)}）⇒ 保守退回全量`);
					}
					attached = raw instanceof Set ? raw : null;
					for (const problem of result?.problems ?? []) { log(`[capabilities] ${problem}`); }
					// ★ 会话级临时挂载：`capability_attach` 写入后调 control.invalidate()，
					//   这里重新 collect 时把本会话额外挂的名字并进可见集（不影响别的 agent）。
					const sessionId = options?.scope?.session?.id ?? options?.scope?.id ?? '';
					const extra = sessionAttachments?.namesFor?.(sessionId);
					if (extra?.size && attached instanceof Set) {
						attached = new Set([...attached, ...extra]);
					}
				} catch (error) {
					// 能力库读失败 ⇒ 保守退回全量，绝不因配置错误让技能消失
					log(`[capabilities] attach 解析失败，退回全量：${String(error?.message ?? error)}`);
					attached = null;
				}
			}
			const candidates = [];
			for (const [name, entry] of index) {
				const parsed = parsedOf(entry?.path);
				if (!parsed) { continue; }
				const visible = attached === null || attached.has(name);
				const directory = dirname(String(entry.path ?? ''));
				candidates.push({
					name: parsed.name,
					description: parsed.description,
					...(parsed.whenToUse ? { whenToUse: parsed.whenToUse } : {}),
					// ★ 只在目录可见性上收窄；userInvocable 恒 true ⇒ /name 手势仍可加载
					invocation: {
						modelInvocable: parsed.invocation.modelInvocable && visible,
						userInvocable: parsed.invocation.userInvocable,
					},
					provider: BUNDLED_PROVIDER_NAME,
					source: 'bundled',
					rank: BUNDLED_RANK,
					locator: { path: String(entry.path), directory },
					resourceBase: { kind: 'directory', path: directory },
					path: String(entry.path),
					metadata: { tier: entry.tier === 'extended' ? 'extended' : 'core', attached: visible },
				});
			}
			return candidates;
		},
		async get(candidate) {
			// locator 由本 provider 的 list() 产出，但按「文件可能已消失」处理
			const file = typeof candidate?.locator?.path === 'string'
				? candidate.locator.path
				: (typeof candidate?.path === 'string' ? candidate.path : undefined);
			if (!file) { return undefined; }
			const parsed = parsedOf(file);
			if (!parsed) { return undefined; }
			const directory = dirname(file);
			return {
				name: parsed.name,
				description: parsed.description,
				...(parsed.whenToUse ? { whenToUse: parsed.whenToUse } : {}),
				invocation: candidate.invocation ?? parsed.invocation,
				source: 'bundled',
				provider: BUNDLED_PROVIDER_NAME,
				resourceBase: { kind: 'directory', path: directory },
				path: file,
				metadata: candidate.metadata,
				content: parsed.body,
			};
		},
	};
}

/** 兜底：从随包根按名字读全文（我们自己的 read_skill / skill_load 不依赖 registry）。 */
export function readBundledSkillBody(index, name) {
	const entry = index?.get?.(name);
	if (!entry?.path || !existsSync(entry.path)) { return undefined; }
	const parsed = parseBundledSkill(entry.path);
	if (!parsed) { return undefined; }
	return { ...parsed, path: entry.path, directory: dirname(entry.path), tier: entry.tier };
}
