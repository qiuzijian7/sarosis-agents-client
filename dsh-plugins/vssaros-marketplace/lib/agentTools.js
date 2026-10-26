/**
 * 商城的**Agent 工具**（★ 2026-10-27，依据 `doc/marketplace-workbench-github-flow.html`）。
 *
 * ## 为什么需要这层
 * 商城工作台右侧内嵌了官方对话（`props.conversation`），但对话里的 Agent
 * 默认够不着商城 —— 它只能看到用户打字的文字。⇒ 补两个工具：
 *   ① `market_inspect_github`：读仓库元数据，并**判断该用哪种发布源**
 *   ② `market_publish`：按判断结果发布
 *
 * ## ★ 文档 §7 的核心教训（这个工具最初就踩了）
 * 服务端 `DistributionSchema` 只有 `npm` / `github-release` / `github-source`，**没有 subdir**。
 * 所以像 BrowserSkill 这种 **monorepo**（根 `package.json` 是 `private: true`、无 `dsh`）：
 * - 当 `github-source` 发 ⇒ **发布成功**（服务端只校验域名形态）
 * - 但安装时 pnpm 去 clone 仓库根 ⇒ `private: true` + 无 version ⇒ **pnpm 拒绝**
 * - 就算放行，根没有 `dsh` 字段 ⇒ 没有 cordis 补丁、没有 client 注入 ⇒ **装了没效果**
 *
 * ⇒ 正确做法是 `{ type: 'npm', name: '@wxg-prc-cpg/browser-skill-dsh-plugin' }`
 *   （作者已把子包发到 npm）。判定逻辑在 `githubInspect.js` 的 `recommendedDistribution`。
 *
 * ## 安全边界（写操作必须显式）
 * - `source` / `kind` / `slug` / `version` **全部必填**（不给默认值 ⇒ Agent 不能"顺手"发布）
 * - `via` 缺省时才自动识别；识别不出来 ⇒ **明确报错并给出原因**（不猜）
 * - 服务端 403/409 原文原样带出
 */

import { normalizeRepo, detectExternalDeps } from './githubInspect.js';

const KIND_SET = new Set(['skill', 'workflow', 'agent', 'mcp', 'plugin', 'workbench']);
const VIA_SET = new Set(['npm', 'github-source']);

/**
 * 作者**已经**写明运行前依赖的迹象（命中就不重复追加）。
 *
 * 只认很明确的词：安装脚本名、中英文的"需先装/前置依赖"、英文 prerequisite / requires。
 * ⚠ 宁可漏判（多追加一行，作者能改）也不要误判（作者的说明被我们当成了已有 ⇒ 依赖没传达）
 */
const DEP_MENTIONED = /install\.(?:sh|ps1)|需先装|需要先装|前置依赖|依赖安装|prerequisite|requires?\s+(?:the\s+)?(?:cli|extension)/i;

/** 识别结果的输出 schema（与 `inspectGithubRepo` 返回逐字段对齐）。 */
const INSPECT_SCHEMA = {
	type: 'object',
	properties: {
		ok: { type: 'boolean' },
		repo: { type: 'string' },
		slug: { type: 'string' },
		slugFromRepo: { type: 'string' },
		name: { type: 'string' },
		description: { type: 'string' },
		version: { type: 'string' },
		versionFrom: { type: 'string' },
		kind: { type: 'string' },
		recommendedDistribution: { type: 'object' },
		recommendWhy: { type: 'string' },
		npmCandidates: { type: 'array', items: { type: 'object' } },
		rootHasDsh: { type: 'boolean' },
		rootPrivate: { type: 'boolean' },
		hasWorkspaces: { type: 'boolean' },
		error: { type: 'string' },
	},
	required: ['ok'],
};

/**
 * @param {{
 *   inspectGithubRepo: (repo: string) => Promise<object>,
 *   publishDistribution: Function,
 *   market: () => object,
 * }} deps
 */
/**
 * 决定商品图标（★ 2026-10-26，用户：「通过商城助手上传的 plugin，没有图片」）。
 *
 * 三级优先：
 * ① 调用方**显式传**的（作者自己指定了图）
 * ② `inspect` 拿到的 `logo`（`github.com/<owner>.png?size=200`）
 * ③ **从 repo 现推** owner 头像 —— 这级不能少：`via` 显式给出时**不会调 inspect**
 *    （`info` 为 null），没有它就又变成"没图"了。推头像**不需要任何网络请求** ✓
 *
 * 拿不到 owner（source 不是合法 `owner/repo`）⇒ 返回空串
 * （调用方不写该字段、让服务端兜底 —— **不编造**一个假 URL）。
 */
function iconOf({ explicit, logo, repo }) {
	const e = typeof explicit === 'string' ? explicit.trim() : '';
	if (e) { return e; }
	const fromInfo = typeof logo === 'string' ? logo.trim() : '';
	if (fromInfo) { return fromInfo; }
	const owner = String(repo ?? '').split('/')[0];
	return owner ? `https://github.com/${owner}.png?size=200` : '';
}

export function marketToolDefinitions(deps) {
	const { inspectGithubRepo, publishDistribution, market } = deps;

	return [
		{
			name: 'market_inspect_github',
			description:
				'读取一个 GitHub 仓库的可发布信息，并判断**该用哪种发布源**（npm / github-source）。'
				+ '这是"把某个 GitHub 项目发布到 VsSaros 商城"的**第一步**，只读、不在商城留任何东西。'
				+ '会返回 recommendedDistribution（含理由）：monorepo 的根通常不能直接装，必须用它发到 npm 的子包。',
			parameters: {
				type: 'object',
				properties: {
					repo: {
						type: 'string',
						description: 'GitHub 仓库：`owner/repo` 或完整 URL（可带 /tree/main/xxx，只取前两段）。',
					},
				},
				required: ['repo'],
			},
			output: {
				schema: INSPECT_SCHEMA,
				render: (_args, v) => {
					if (!v || v.ok === false) {
						return [{ type: 'text', text: `识别失败：${(v && v.error) || '未知原因'}` }];
					}
					const dist = v.recommendedDistribution;
					const lines = [
						`${v.repo}  →  ${v.name || '(无名称)'}`,
						v.description ? `描述：${String(v.description).slice(0, 160)}` : '',
						`版本：${v.version}（来自 ${v.versionFrom}）`,
						`类型：${v.kind || '未判定（需手工指定）'}`,
						dist
							? `★ 建议发布源：${dist.type} · ${dist.name}`
							: '★ **该仓库不能直接发布**',
						v.recommendWhy ? `理由：${v.recommendWhy}` : '',
						`建议 slug：${v.slug}`,
					];
					const cands = (v.npmCandidates || []).filter(c => c.hasDsh);
					if (cands.length > 1) {
						lines.push(`其他候选（npm）：${cands.slice(1).map(c => `${c.name}@${c.version}`).join(', ')}`);
					}
					return [{ type: 'text', text: lines.filter(Boolean).join('\n') }];
				},
			},
			isConcurrencySafe: () => true,
			execute: async (params) => {
				const repo = String(params?.repo ?? '').trim();
				if (!repo) { return { ok: false, error: '缺少 repo 参数' }; }
				const info = await inspectGithubRepo(repo);
				if (!info || info.ok === false) {
					return { ok: false, error: String((info && info.error) || '识别失败'), repo };
				}
				return info;
			},
		},

		{
			name: 'market_publish',
			description:
				'把一个 GitHub 仓库（或其 npm 子包）发布 / 更新版本到 VsSaros 商城。'
				+ '⚠ 这是**写操作**：会在商城建商品并发版本。'
				+ '`via` 省略时会自动识别（推荐先用 market_inspect_github 看清）；'
				+ '**monorepo 必须用 via=npm + npmName**，否则装不上（发布照样会"成功"，但用户那边 pnpm 会拒绝）。',
			parameters: {
				type: 'object',
				properties: {
					source: { type: 'string', description: 'GitHub 仓库地址（`owner/repo` 或完整 URL）。' },
					kind: { type: 'string', description: '商品类型：skill / workflow / agent / mcp / plugin / workbench。' },
					slug: { type: 'string', description: '商城唯一标识（小写字母开头，只含 a-z0-9_-）。' },
					version: { type: 'string', description: '语义化版本号，如 0.3.3。必须显式给出。' },
					via: {
						type: 'string',
						description: '发布源形态：`npm`（monorepo 子包）或 `github-source`（仓库根就是插件）。省略 ⇒ 自动识别。',
					},
					npmName: { type: 'string', description: 'via=npm 时的 npm 包名，如 `@wxg-prc-cpg/browser-skill-dsh-plugin`。' },
					name: { type: 'string', description: '展示名称（可省略）。' },
					// ★ 2026-10-26（用户：「通过商城助手上传的 plugin，没有图片」）：
					//   原来工具**根本没有图标参数**，于是卡片只能显示 📦 兜底。
					//   两个都可省略 —— 省略时自动用仓库 owner 的头像（inspect 的 `logo`）。
					icon: { type: 'string', description: '小图标 URL（可省略；省略时自动用 GitHub owner 头像）。' },
					cover: { type: 'string', description: '卡片大图 URL（可省略；省略时同 icon）。' },
					description: { type: 'string', description: '介绍文案（可省略）。若商品依赖外部 CLI/扩展，**第一行写清依赖**。' },
					changelog: { type: 'string', description: '本版更新说明（可省略）。' },
					includeDependencyNote: {
						type: 'boolean',
						description: '是否自动在介绍末尾补一行「运行前依赖」（默认 true）。作者已在介绍里写明时不会重复追加。',
					},
				},
				required: ['source', 'kind', 'slug', 'version'],
			},
			output: {
				schema: {
					type: 'object',
					properties: {
						ok: { type: 'boolean' },
						slug: { type: 'string' },
						version: { type: 'string' },
						distribution: { type: 'object' },
						url: { type: 'string' },
						error: { type: 'string' },
					},
					required: ['ok'],
				},
				render: (_args, v) => {
					if (!v || v.ok === false) {
						return [{ type: 'text', text: `发布失败：${(v && v.error) || '未知原因'}` }];
					}
					const d = v.distribution || {};
					return [{
						type: 'text',
						text: `已发布：${v.slug} v${v.version}\n发布源：${d.type} · ${d.name}\n商城地址：${v.url}`,
					}];
				},
			},
			// 写操作 ⇒ 不并发（同 slug 并发会撞 409）
			isConcurrencySafe: () => false,
			execute: async (params) => {
				const source = String(params?.source ?? '').trim();
				const kind = String(params?.kind ?? '').trim();
				const slug = String(params?.slug ?? '').trim();
				const version = String(params?.version ?? '').trim();
				const via = String(params?.via ?? '').trim();
				const npmName = String(params?.npmName ?? '').trim();

				// ── 本地校验（错在本地就报，别等服务端 ──────────────────
				if (!source) { return { ok: false, error: '缺少 source（GitHub 地址）' }; }
				if (!KIND_SET.has(kind)) {
					return { ok: false, error: `kind 必须是 ${[...KIND_SET].join(' / ')} 之一，收到「${kind}」` };
				}
				if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) {
					return { ok: false, error: `slug 只能是小写字母开头的 a-z0-9_-（收到「${slug}」）` };
				}
				if (!/^\d+\.\d+\.\d+/.test(version)) {
					return { ok: false, error: `version 要是语义化版本（如 1.0.0），收到「${version}」` };
				}
				if (via && !VIA_SET.has(via)) {
					return { ok: false, error: `via 只能是 ${[...VIA_SET].join(' / ')}（收到「${via}」）` };
				}
				if (via === 'npm' && !npmName) {
					return { ok: false, error: 'via=npm 时必须给 npmName（npm 包名）' };
				}

				// ★ 外部依赖（文档 §10 最后一条）：把"跑起来还要装什么"写进介绍
				//   原则：**只追加、不覆盖、不重复** —— 作者的原文一个字都不动，
				//   我们在末尾加一段并标明"商城自动检测，发布后可编辑"。
				let finalDescription = String(params?.description ?? '').trim();
				if (params?.includeDependencyNote !== false && !DEP_MENTIONED.test(finalDescription)) {
					try {
						const deps = await detectExternalDeps(source);
						if (deps && deps.note) {
							// 原文为空时**不要**留前导空行（会变成"\n\n---"开头的介绍）
							const sep = finalDescription ? '\n\n---\n' : '';
							finalDescription = (finalDescription + sep + '运行前依赖（商城自动检测，发布后可编辑）：' + deps.note).slice(0, 2048);
						}
					} catch { /* 检测失败不影响发布 */ }
				}

				// ── 决定 distribution ──────────────────────────────────
				let distribution;
				// ★ 从 inspect 拿到的图标（只在这个作用域用，见 `iconOf` 的三级优先）
				//   ⚠ 不能直接把 `info` 提到外面：它在 `if (!distribution)` 块里 `const`，
				//     块外引用会 `info is not defined`（真机踩到）
				let logoFromInspect = '';
				if (via === 'npm') {
					distribution = { type: 'npm', name: npmName };
				} else if (via === 'github-source') {
					const repo = normalizeRepo(source);
					if (!repo) { return { ok: false, error: `source 不像 GitHub 地址：「${source}」` }; }
					distribution = { type: 'github-source', name: repo };
				} else {
					// 自动识别：拿不到推荐就**明确报错**，不猜
					const info = await inspectGithubRepo(source);
					// 记下 logo 供 meta 用（块外引用会 ReferenceError）
					if (info && typeof info.logo === 'string') { logoFromInspect = info.logo; }
					if (!info || info.ok === false) {
						return { ok: false, error: `识别失败：${(info && info.error) || '未知原因'}` };
					}
					if (!info.recommendedDistribution) {
						return {
							ok: false,
							error: `这个仓库不能直接发布：${info.recommendWhy}。`
								+ '如果是 monorepo，请用 via=npm + npmName（可先调 market_inspect_github 看候选）。',
						};
					}
					distribution = info.recommendedDistribution;
				}

				// ── 发布 ──────────────────────────────────────────────
				try {
					const res = await publishDistribution({
						market: market(),
						kind,
						localId: slug,
						version,
						distribution,
						changelog: String(params?.changelog ?? '').trim(),
						meta: {
							...(String(params?.name ?? '').trim() ? { name: String(params.name).trim() } : {}),
							...(finalDescription ? { description: finalDescription } : {}),
							// ★ 2026-10-26（用户：「通过商城助手上传的 plugin，没有图片」）：
							//   优先级 ① 调用方显式给 ② `inspect` 拿到的仓库 owner 头像
							//          ③ **从 source 现推**（`github.com/<owner>.png?size=200`）
							//   ⚠ 第 ③ 条很重要：`via` 显式给出时**不会调 inspect**（`info` 是 null），
							//     没有它就又变成"没图"了。推 owner 头像**不需要任何网络请求** ✓
							...(iconOf({
								explicit: params?.icon,
								logo: logoFromInspect,
								repo: normalizeRepo(String(params?.source ?? '')),
							}) ? { icon: iconOf({ explicit: params?.icon, logo: logoFromInspect, repo: normalizeRepo(String(params?.source ?? '')) }) } : {}),
							...(iconOf({
								explicit: params?.cover,
								logo: logoFromInspect,
								repo: normalizeRepo(String(params?.source ?? '')),
							}) ? { cover: iconOf({ explicit: params?.cover, logo: logoFromInspect, repo: normalizeRepo(String(params?.source ?? '')) }) } : {}),
						},
					});
					return {
						ok: true,
						slug,
						version: String((res && res.version) || version),
						distribution,
						url: `/x/marketplace/?slug=${encodeURIComponent(slug)}`,
					};
				} catch (e) {
					// 服务端 403/409 原文比"发布失败"有用得多 ⇒ 原样带出
					return { ok: false, error: String((e && e.message) || e).slice(0, 400) };
				}
			},
		},
	];
}
