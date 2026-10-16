// @vssaros/dsh-skills — core（纯业务逻辑，零 I/O、零 dsh 依赖）。
//
// 契约真源：`src/vs/sessions/contrib/agentStudio/common/skills.ts` 的 `ISkillDefinition` / `SkillActivation`，
// 以及 `skillInstaller.ts` 的 frontmatter 解析口径（**`activation` 缺省 = `'manual'`**，已核对）。
// 方案 6.9 方案 C：契约共享、实现各自一份；core 归插件，`src/vs` 不得 import 本包。
//
// 与 IDE 的差异（有意为之，写在这里免得以后当 bug 查）：
// - IDE 的 skill 来源有三层（内置目录 / `~/.vssaros/skills/<id>/SKILL.md` / 运行时内存注册）。本模块
//   只覆盖第二层（用户全局目录）——内置目录随产品发布在 `src/vs` 里，Host 进程未必可达；运行时内存注册
//   属于别的引擎的生命周期。两层都记为覆盖缺口。
// - `activation: always`（每 turn 注入）在 dsh 的技能来源接口里没有等价物：provider 只能"提供候选"，
//   注入时机由消费者（`dsh-tool-skill`）决定。所以 always/auto 在这里只会让技能**可被模型/用户取用**，
//   不会自动注入——语义缺口，见 README 4.41。

/** dsh 侧读的技能文件名（与 VsSaros 一致）。 */
export const SKILL_FILE = 'SKILL.md';

/**
 * 候选的技能优先级档：与 dsh 的 `BUNDLED_SKILL_RANK = 600` 同档（"打包技能与本地捆绑根"这一档）。
 * 为什么是 600 而不是更低（更低=更高优先级）：VsSaros 用户技能**不应该**盖掉 Harness 自己打包的技能
 * （例如插件开发技能），重名时同档由注册顺序决定。若将来发现重名冲突需要改档，改这一个常量。
 */
export const VSAROS_SKILL_RANK = 600;

/**
 * 候选的 `source`：**必须是字符串**（dsh 的 `SkillCandidate` 契约）。
 *
 * 取值风格对齐官方 provider 的短来源标签（`user-dsh` / `project-dsh` / `custom` / `bundled`）；
 * 本插件的技能来自 VsSaros 注入的技能目录，所以用插件自己的标签。**路径信息不靠它承载**——
 * 另有 `path` 与 `locator.path` 两项（`get()` 回取正文靠的是它们）。
 */
export const VSAROS_SKILL_SOURCE = 'vssaros';

/**
 * 本插件注册的技能来源名（= `cordis.patch.yml` 的行 id = 插件的 `name` 导出）。
 *
 * **为什么放进 core 并让候选也用它**：dsh 的校验器有一条 `candidate.provider === providerName`
 * （`dsh-skill/lib/index.js` 的 `validateCandidate`），也就是**每个候选都必须自报注册名**——
 * 少给或给错都会让目录构建抛错、带着这个错结束整个回合。2026-10-11 实测正是这么连撞两道：
 * 先 `non-string source`，改完立刻撞上 `non-string provider`。把"注册名"和"候选里的 provider"
 * 绑到**同一个常量**，这类漂移就不可能再发生。
 */
export const VSAROS_SKILL_PROVIDER = 'vssaros-skills';

/**
 * VsSaros `activation` → dsh 调用策略。`manual` = 只有用户显式调用（`/skill <id>`），
 * 所以只给 `userInvocable`；`auto` / `always` 都允许模型自己挑（关键词匹配/每轮注入那层语义见文件头注释）。
 */
export const ACTIVATION_POLICY = {
	manual: { modelInvocable: false, userInvocable: true },
	auto: { modelInvocable: true, userInvocable: true },
	always: { modelInvocable: true, userInvocable: true },
};

/** 与 `skillInstaller.ts` 一致的缺省：没有 `activation` 字段 = `manual`。 */
export const DEFAULT_ACTIVATION = 'manual';

/** 技能名（kebab-case）——dsh 的技能名规则，本地先挡住，免得把注定被拒的候选塞进目录。 */
export function isSkillName(name) {
	return typeof name === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}

/**
 * 解析 SKILL.md 的 YAML frontmatter——**只认顶层 `key: value` 标量**（VsSaros 的用法就这些），
 * 不引 YAML 依赖。值两侧的成对引号会被剥掉；数组写成 `a, b`。
 */
export function parseFrontmatter(text) {
	const raw = typeof text === 'string' ? text : '';
	if (!raw.startsWith('---')) {
		return { meta: {}, body: raw };
	}
	const end = raw.indexOf('\n---', 3);
	if (end < 0) {
		return { meta: {}, body: raw };
	}
	const head = raw.slice(raw.indexOf('\n', 3) + 1, end);
	const after = raw.indexOf('\n', end + 1);
	const body = after < 0 ? '' : raw.slice(after + 1);
	const meta = {};
	for (const line of head.split(/\r?\n/)) {
		const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
		if (!match) {
			continue;
		}
		let value = match[2].trim();
		if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\'')))) {
			value = value.slice(1, -1);
		}
		meta[match[1]] = value;
	}
	return { meta, body };
}

function listValue(value) {
	if (typeof value !== 'string' || !value.trim()) {
		return undefined;
	}
	const items = value.split(',').map(s => s.trim()).filter(Boolean);
	return items.length ? items : undefined;
}

/**
 * 一个 SKILL.md → 可注册的技能（或一条**带原因的**跳过记录）。
 * 缺 `description` 直接跳过：dsh 用描述做技能路由，没有描述的技能进目录只会污染模型上下文。
 */
export function skillFromFile(text, { id, file }) {
	const { meta, body } = parseFrontmatter(text);
	const name = (meta.name || id || '').trim();
	if (!name) {
		return { error: `没有 name 且目录名不可用：${file}` };
	}
	if (!isSkillName(name)) {
		return { error: `技能名不是 kebab-case（dsh 会拒）：${name}（${file}）` };
	}
	const description = (meta.description || '').trim();
	if (!description) {
		return { error: `缺 description（dsh 用它路由）：${file}` };
	}
	const activation = ['manual', 'auto', 'always'].includes(meta.activation) ? meta.activation : DEFAULT_ACTIVATION;
	return {
		skill: {
			name,
			description,
			whenToUse: (meta.whenToUse || meta['when-to-use'] || '').trim() || undefined,
			path: file,
			content: body.trim(),
			activation,
			metadata: {
				activation,
				...(listValue(meta.match) ? { match: listValue(meta.match) } : {}),
				...(meta.category ? { category: meta.category } : {}),
				...(meta.version ? { version: meta.version } : {}),
			},
		},
	};
}

/** core 技能 → dsh `SkillCandidate`（`ctx.skills.registerProvider` 的 `list()` 返回值）。 */
export function toCandidate(skill) {
	return {
		name: skill.name,
		description: skill.description,
		...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
		path: skill.path,
		// ⚠ `source` 曾经是对象 `{ kind:'path', path }`（**错的**）：dsh 的校验器
		// （`dsh-skill/lib/index.js` 的 `validateCandidate`）明确要求 **string**——
		// `if (typeof candidate.source !== "string") throw new TypeError(...)`。
		//
		// 代价不是"少显示一个来源"，而是**整回合中止**：`list()` 逐条校验候选，一条违约就抛，
		// 带着这个错结束 turn（2026-10-11 实测：`p3-20` 的回合在 `turn/start` 之后立刻以
		// `skill provider "vssaros-skills" returned skill "cpu-usage-analysis" with a non-string source`
		// 收尾，**模型侧一个请求都没发出去** ⇒ 任何读到真实技能目录的 Host 每个回合都会失败）。
		// 之所以长期没被发现：`p3-04` 的断言是**按实现写的**（`c.source?.kind === 'path'`），
		// 等于把错误契约固化成了"期望"——该断言已一并订正为"字符串"。
		source: VSAROS_SKILL_SOURCE,
		invocation: ACTIVATION_POLICY[skill.activation] ?? ACTIVATION_POLICY[DEFAULT_ACTIVATION],
		rank: VSAROS_SKILL_RANK,
		// ⚠ 候选**必须自报注册名**（dsh 校验器有 `candidate.provider === providerName` 一条，
		// 少给会以 `non-string provider` 抛错、中止整个回合）。值与注册名同源，见常量定义处的说明。
		provider: VSAROS_SKILL_PROVIDER,
		locator: { path: skill.path },
		metadata: skill.metadata,
	};
}

/** core 技能 → dsh `SkillDefinition`（`get()` 的返回值，带正文）。 */
export function toDefinition(skill) {
	return {
		...toCandidate(skill),
		content: skill.content,
	};
}

/** 目录统计（页面自诊断与日志用）。 */
export function summarizeCatalog(entries) {
	const byActivation = { manual: 0, auto: 0, always: 0 };
	for (const skill of entries) {
		byActivation[skill.activation] = (byActivation[skill.activation] ?? 0) + 1;
	}
	return { count: entries.length, byActivation };
}
