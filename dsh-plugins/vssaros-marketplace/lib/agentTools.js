/**
 * 商城的**Agent 工具**（★ 2026-10-27 用户要求「阶段 3：让对话真的能发布」）。
 *
 * ## 为什么需要这层
 * 阶段 2 把官方对话嵌进了商城工作台（右侧 `props.conversation`），
 * 但**对话里的 Agent 默认够不着商城** —— 它只能看到用户打字的文字。
 * ⇒ 补两个工具，让 Agent 能：
 *   ① `market_inspect_github`：读一个 GitHub 仓库的元数据（名称/描述/版本/类型）
 *   ② `market_publish_github`：把它发布成商城商品（`distribution: github-source`）
 *
 * ## 为什么这两个工具就够了
 * 商城的"安装源"本来就是 GitHub 地址（`github-source`）⇒ 发布**不需要上传包**，
 * 只登记 `{kind, slug, version, source}`。所以"发布一个 GitHub 项目"真的只是两件事：
 * 读元数据 + 登记来源。
 *
 * ## ⚠ 安全边界（写操作必须显式）
 * `market_publish_github` 是**写操作**（会在商城建商品 + 发版本）。
 * - 参数**强制** `slug` 与 `version`（不给默认值）⇒ Agent 不能"顺手"发布
 * - `slug` 规则与页面一致（`^[a-z0-9][a-z0-9_-]*$`，服务端同口径）
 * - `source` 只允许 GitHub 域（`publishExternal` 内部 `parseGitHubSource` 已卡死 ✓）
 * - 发布**不以作者身份**伪造：`market()` 用的就是当前登录态 ⇒ 越权会被服务端 403 如实抛出
 */

const KIND_SET = new Set(['skill', 'workflow', 'agent', 'mcp', 'plugin', 'workbench']);

/** 识别结果的输出 schema（与 `inspectGithubRepo` 的返回逐字段对齐）。 */
const INSPECT_SCHEMA = {
	type: 'object',
	properties: {
		ok: { type: 'boolean' },
		repo: { type: 'string' },
		slug: { type: 'string' },
		name: { type: 'string' },
		description: { type: 'string' },
		version: { type: 'string' },
		versionFrom: { type: 'string' },
		logo: { type: 'string' },
		kind: { type: 'string' },
		hasSkillMd: { type: 'boolean' },
		error: { type: 'string' },
	},
	required: ['ok'],
};

/**
 * @param {{ inspectGithubRepo: (repo: string) => Promise<object>, publishExternal: Function, market: () => object }} deps
 */
export function marketToolDefinitions(deps) {
	const { inspectGithubRepo, publishExternal, market } = deps;

	return [
		{
			name: 'market_inspect_github',
			description:
				'读取一个 GitHub 仓库的可发布信息（名称 / 描述 / 版本 / 类型 / logo），用于"把某个 GitHub 项目发布到 VsSaros 商城"之前先看清它是什么。'
				+ '全程只读，不会在商城留下任何东西。版本顺序：package.json → SKILL.md frontmatter → Releases 最新 tag。',
			parameters: {
				type: 'object',
				properties: {
					repo: {
						type: 'string',
						description: 'GitHub 仓库：`owner/repo` 或完整 URL（可带 /tree/main/xxx 子路径，只取前两段）。',
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
					const lines = [
						`${v.repo}  →  ${v.name || '(无名称)'}`,
						v.description ? `描述：${String(v.description).slice(0, 200)}` : '',
						`版本：${v.version}（来自 ${v.versionFrom}）`,
						`类型：${v.kind || '未判定（需手工指定 skill / plugin / …）'}`,
						`建议 slug：${v.slug}`,
					].filter(Boolean);
					return [{ type: 'text', text: lines.join('\n') }];
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
			name: 'market_publish_github',
			description:
				'把一个 GitHub 仓库发布（或更新版本）到 VsSaros 商城，安装源记为 `github-source`（安装时从 GitHub 取，不上传包）。'
				+ '⚠ 这是**写操作**：会在商城建商品并发版本。`slug` / `version` / `source` 必须由调用方明确给出，本工具不做猜测。'
				+ '发布成功后返回商城路径，可直接给用户点击。',
			parameters: {
				type: 'object',
				properties: {
					source: { type: 'string', description: 'GitHub 仓库地址（`owner/repo` 或完整 URL）。' },
					kind: {
						type: 'string',
						description: '商品类型：skill / workflow / agent / mcp / plugin / workbench。不确定时先调 market_inspect_github。',
					},
					slug: { type: 'string', description: '商城唯一标识（小写字母开头，只含 a-z0-9_-）。建议用 owner-repo。' },
					version: { type: 'string', description: '语义化版本号，如 1.0.0。必须显式给出。' },
					name: { type: 'string', description: '展示名称（可省略，商城会用 slug）。' },
					description: { type: 'string', description: '介绍文案（可省略）。' },
					changelog: { type: 'string', description: '本版更新说明（可省略）。' },
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
						url: { type: 'string' },
						error: { type: 'string' },
					},
					required: ['ok'],
				},
				render: (_args, v) => {
					if (!v || v.ok === false) {
						return [{ type: 'text', text: `发布失败：${(v && v.error) || '未知原因'}` }];
					}
					return [{ type: 'text', text: `已发布：${v.slug} v${v.version}\n商城地址：${v.url}` }];
				},
			},
			// 写操作 ⇒ 不并发（同 slug 并发会撞 409）
			isConcurrencySafe: () => false,
			execute: async (params) => {
				const source = String(params?.source ?? '').trim();
				const kind = String(params?.kind ?? '').trim();
				const slug = String(params?.slug ?? '').trim();
				const version = String(params?.version ?? '').trim();

				// 逐条挡在调用服务端之前 —— 报错要能直接告诉模型"该改什么"
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

				try {
					const res = await publishExternal({
						market: market(),
						kind,
						localId: slug,
						version,
						source,
						changelog: String(params?.changelog ?? '').trim(),
						meta: {
							...(String(params?.name ?? '').trim() ? { name: String(params.name).trim() } : {}),
							...(String(params?.description ?? '').trim() ? { description: String(params.description).trim() } : {}),
						},
					});
					return {
						ok: true,
						slug,
						version: String((res && res.version) || version),
						url: `/x/marketplace/?slug=${encodeURIComponent(slug)}`,
					};
				} catch (e) {
					// 服务端的 403/409 原文比"发布失败"有用得多 ⇒ 原样带出去
					return { ok: false, error: String((e && e.message) || e).slice(0, 400) };
				}
			},
		},
	];
}
