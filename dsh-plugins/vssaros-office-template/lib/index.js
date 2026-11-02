// @vssaros/dsh-office-template — host half：用**用户自己的** Word 文件当模板。
//
// 与 DSH Desktop 的 `office_template` 的差别（2026-11-02，用户选定的 B2 路线）：
//   · 没有"模板选择器"状态：Desktop 版要求 `modes.state(session).selectedDocumentTemplate` 与参数
//     一致（没有那套 composer UI 就取不到），本版直接收 `path`；
//   · 没有预置案例资产：模板就是用户给的文件（零版权风险、零包体积增量）；
//   · 没有 `present` 前置闸：本仓没有 `present` 工具，交付靠"存工作区 + 回绝对路径"。
//
// 真正的 OOXML 操作在 `lib/docx-template.py`（派生自 DSH Desktop 的同名 worker，MIT）：
// 段落 / run 级 ID、按 ID 替换、按源段落克隆新增、删段落，并在写盘前做 6 项"版式保留"校验
// （嵌入字体、样式/主题、页面几何、边框与图形框、字体分配、段落与 run 属性）。
//
// 为什么不在本进程里改 docx：OOXML 的结构化编辑 + 校验用 lxml 才可靠（python-docx 会丢
// 不支持的部件）；而 lxml 只在 Office 运行时负载里（`office-runtime/primary-runtime`）。
//
// 与其它 vssaros 插件同口径：**不 import 任何 `@deepseek-ai/*`**（避免 profile 侧解析依赖，
// 跨 dsh 版本更稳），工具定义是普通对象。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'vssaros-office-template';
// 只依赖 tools：工具在任何模板里都该可用（webServer / connection 缺了不该让插件 pending）。
export const inject = ['tools'];

/** worker 与本文件同目录（`lib/`）。 */
const WORKER = fileURLToPath(new URL('./docx-template.py', import.meta.url));
/** 单次调用的硬超时：写一份几十页 Word 也不会超过它；超时说明出了问题而不是"慢"。 */
const TIMEOUT_MS = 60_000;
/** 输出上限：段落清单可能很大（几百段 × run），1MB 够；超出即视为异常。 */
const STDOUT_LIMIT = 1024 * 1024;

const text = value => (typeof value === 'string' ? value.trim() : '');

/**
 * Office 运行时里的解释器（只读资源，绝不 pip install）。
 *
 * 优先 `config.python`（显式覆盖），否则从 `config.runtimePath` 推 —— 后者由 VsSaros 经
 * `--patch` 注入（`renderOfficeOverlay` 写的就是 officeBase）。
 * 找不到就**如实报错**并在文案里指出缺什么：静默退回系统 Python 会得到
 * "缺 lxml/python-docx"这种更远的错误，反而更难查。
 */
function interpreterOf(config) {
	const explicit = text(config?.python);
	if (explicit) {
		return isAbsolute(explicit) && existsSync(explicit) ? explicit : undefined;
	}
	const base = text(config?.runtimePath);
	if (!base) {
		return undefined;
	}
	const candidate = process.platform === 'win32'
		? join(base, 'primary-runtime', 'dependencies', 'python', 'python.exe')
		: join(base, 'primary-runtime', 'dependencies', 'python', 'bin', 'python3');
	return existsSync(candidate) ? candidate : undefined;
}

/**
 * 会话工作区目录。
 *
 * `exec.agent.session.header.cwd` 是 dsh 的会话契约（Desktop 版模板工具用的也是它）；
 * 拿不到就回落 `config.workspacePath`（VsSaros 注入的当前工作区），再没有就报错 ——
 * **不猜**（猜错会把文件写到别的项目里，这是最坏的失败）。
 */
function workspaceOf(config, exec) {
	const fromSession = text(exec?.agent?.session?.header?.cwd);
	if (fromSession) {
		return fromSession;
	}
	const fromConfig = text(config?.workspacePath);
	if (fromConfig) {
		return fromConfig;
	}
	throw new Error('拿不到会话工作区：请在 VsSaros 的工作区里调用（或让宿主注入 config.workspacePath）——'
		+ '模板必须落在当前工作区内，猜一个目录会把文件写到别的项目里。');
}

/** 跑一次 worker：stdin 一个 JSON，stdout 一个 JSON，非零退出把 stderr 原文抛给模型。 */
async function invoke(config, exec, payload) {
	const python = interpreterOf(config);
	if (!python) {
		throw new Error('缺 Office 运行时负载（Python 解释器）：先跑 `node build/prepare-office-runtime.mjs` 构建'
			+ '（打包版应随包附带），或让宿主经 --patch 注入 config.runtimePath / config.python。');
	}
	const cwd = workspaceOf(config, exec);
	// 环境**清空**：只保留 Windows 起步必需项（否则 python 找不到 SystemRoot 起不来）。
	// 不继承 PATH —— worker 不该发现系统 Python 或别的工具。
	const env = {};
	if (process.platform === 'win32') {
		env.SystemRoot = process.env.SystemRoot ?? 'C:\\Windows';
		env.TEMP = process.env.TEMP ?? '';
		env.TMP = process.env.TMP ?? env.TEMP;
	}
	return await new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(python, ['-I', '-B', WORKER], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		let settled = false;
		const finish = (error, value) => {
			if (settled) { return; }
			settled = true;
			clearTimeout(timer);
			error ? rejectPromise(error) : resolvePromise(value);
		};
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			finish(new Error(`Word 模板处理超时（${TIMEOUT_MS / 1000}s）—— 文档可能过大或包结构异常`));
		}, TIMEOUT_MS);
		const abort = () => {
			child.kill('SIGKILL');
			finish(new Error('Word 模板处理已取消'));
		};
		if (exec?.signal?.aborted) { abort(); return; }
		exec?.signal?.addEventListener?.('abort', abort, { once: true });
		child.on('error', error => finish(new Error(`起不来 Python 解释器：${error.message}`)));
		child.stdout.on('data', chunk => {
			stdout += chunk.toString('utf8');
			if (stdout.length > STDOUT_LIMIT) {
				child.kill('SIGKILL');
				finish(new Error('Word 模板处理的输出超过上限（段落清单异常膨胀？）'));
			}
		});
		child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
		child.on('close', code => {
			exec?.signal?.removeEventListener?.('abort', abort);
			if (code !== 0) {
				// worker 的 stderr 是给模型看的人话（"Preserve the template…" 这类），原样带出去
				finish(new Error(text(stderr) || `Word 模板处理失败（退出码 ${code}）`));
				return;
			}
			try {
				finish(undefined, JSON.parse(stdout));
			} catch {
				finish(new Error(`Word 模板处理返回了无法解析的结果：${stdout.slice(0, 200)}`));
			}
		});
		child.stdin.end(JSON.stringify(payload), 'utf8');
	});
}

/** 段落替换项的参数 schema（与 python 侧 `set_text` 的契约一致）。 */
const FRAGMENTS = {
	type: 'array',
	description: '可选：按记录过的 run ID 拆分文本片段，用来保留混合字体/局部加粗；拼接结果必须等于 text。',
	items: {
		type: 'object',
		additionalProperties: false,
		properties: { source: { type: 'string' }, text: { type: 'string' } },
		required: ['source', 'text'],
	},
};

const PARAGRAPH = {
	type: 'object',
	additionalProperties: false,
	properties: {
		id: { type: 'string', description: 'office_template 返回的段落 ID（如 p3）' },
		text: { type: 'string', description: '该段落的完整新文本（不要只给改动部分）' },
		runs: FRAGMENTS,
	},
	required: ['id', 'text'],
};

export function apply(ctx, config = {}) {
	// 装配期不做存在性断言：dev 下可能还没跑 builder（缺负载），那不该让整个插件 apply 失败
	//（工具在调用时如实报"缺 Office 运行时"就够了，别连累同一 profile 的其它功能）。

	// ── 写类工具的**审批闸**（2026-11-02）──────────────────────────────────────
	//   与 kb / kanban / workflow / marketplace / loop 同一把：官方派发前决策钩子
	//   `tools/pre-execute`（waterfall），返回 `{ kind: 'ask' }` ⇒ 只有审批服务回 `allowed-once`
	//   才执行；没有审批支持的部署 degrade 成 deny（fail-closed ✓）。
	//   闸 `office_template_write`（按模板出一份新稿，会落盘成 .docx）；`office_template` 只读（拿段落 ID）⇒ 放行。
	ctx.effect(() => ctx.on('tools/pre-execute', (exec, next) => {
		const toolName = exec && typeof exec.name === 'string' ? exec.name : '';
		if (toolName !== 'office_template_write') {
			return next();
		}
		const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {};
		const target = String(args.outPath ?? args.output ?? args.templatePath ?? '').trim() || '(未指定)';
		return {
			kind: 'ask',
			reason: `office_template_write 会按模板生成一份新文档并落盘：${target}`,
			displayReason: { zh: `允许按模板生成并写入「${target}」？`, en: `Allow generating and writing "${target}" from the template?` },
		};
	}), 'vssaros-office-template: write-tool approval gate');

	ctx.effect(() => ctx.tools.register({
		name: 'office_template',
		description: '把用户自己的 Word 文件当成模板，返回**稳定的段落 / run ID** 供 office_template_write 使用。'
			+ '适用于"按我方红头文件/周报模板的版式出一份新稿"：先用它拿 ID，再用 office_template_write 按 ID 替换正文，'
			+ '版式（页面、样式、嵌入字体、表格、页眉页脚）由 Worker 保留并校验。'
			+ '只读，不会改动传入的文件。⚠ 表格内的段落 can_remove=false（只能改文字不能删）。',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: '模板 .docx 的路径（相对会话工作区，或工作区内的绝对路径）' },
			},
			required: ['path'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					sha256: { type: 'string' },
					paragraphs: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								id: { type: 'string' },
								text: { type: 'string' },
								can_remove: { type: 'boolean' },
								runs: {
									type: 'array',
									items: {
										type: 'object',
										properties: {
											id: { type: 'string' }, text: { type: 'string' }, fonts: { type: 'string' },
											size: { type: 'string' }, bold: { type: 'boolean' },
										},
									},
								},
							},
						},
					},
				},
			},
			render: (args, value) => {
				const lines = [`模板 ${args?.path}：${value.paragraphs.length} 个段落（sha ${String(value.sha256).slice(0, 12)}…）`];
				for (const item of value.paragraphs) {
					const flag = item.can_remove ? 'removable' : 'keep';
					const preview = item.text.replace(/\s+/g, ' ').slice(0, 40);
					lines.push(`- ${item.id} [${flag}] runs=${item.runs.length}：${preview || '（空段）'}`);
				}
				lines.push('下一步：office_template_write 里给 replacements（每个 ID 一次，text 是**完整**段落文本）、'
					+ '可选 additions（after + source 段落 ID，按源段落样式克隆）与 removals（只删 can_remove=true 的）。');
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		// 只读，允许与同批只读工具并行（见 ToolDefinition.isConcurrencySafe 契约）
		isConcurrencySafe: () => true,
		async execute(args = {}, exec) {
			const path = text(args.path);
			if (!path) {
				throw new Error('path 必填：要当模板的 .docx 路径');
			}
			return await invoke(config, exec, { command: 'prepare', args: { path } });
		},
	}));

	ctx.effect(() => ctx.tools.register({
		name: 'office_template_write',
		description: '用 office_template 返回的段落 ID 改写模板，输出**新的** .docx（不覆盖原文件）。'
			+ 'replacements 给每个要改段落的完整文本（不是差异）；additions 按源段落样式克隆新段落插到 after 之后；'
			+ 'removals 删除多余正文段（只能删 can_remove=true 的）。'
			+ 'Worker 会在写盘前校验 6 项版式保留（嵌入字体/样式主题/页面几何/边框图形框/字体分配/段落与 run 属性），'
			+ '任一不过就以可读原因失败——按提示改，不要绕过。',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: '模板 .docx 路径（office_template 用过的同一个）' },
				output_path: { type: 'string', description: '新 .docx 路径（相对会话工作区；必须不存在）' },
				replacements: { type: 'array', items: PARAGRAPH, description: '按段落 ID 的整段替换（每个 ID 最多一次）' },
				additions: {
					type: 'array',
					items: {
						type: 'object',
						additionalProperties: false,
						properties: {
							after: { type: 'string', description: '插在这个段落 ID 之后' },
							source: { type: 'string', description: '按这个段落 ID 的样式克隆' },
							text: { type: 'string' },
							runs: FRAGMENTS,
						},
						required: ['after', 'source', 'text'],
					},
					description: '新增段落（沿用 source 段落的样式与字体）',
				},
				removals: { type: 'array', items: { type: 'string' }, description: '要删除的段落 ID（只允许 can_remove=true）' },
			},
			required: ['path', 'output_path', 'replacements'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					path: { type: 'string' },
					sha256: { type: 'string' },
					checks: { type: 'array', items: { type: 'string' } },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: `已生成 ${value.path}（sha ${String(value.sha256).slice(0, 12)}…）\n`
					+ `版式校验：${value.checks.join(' / ')}\n`
					+ '把绝对路径给用户即可（工作区内的文件会由界面展示）。',
			}],
		},
		// 写类：不声明 isConcurrencySafe（默认独占）
		async execute(args = {}, exec) {
			const path = text(args.path);
			const outputPath = text(args.output_path);
			if (!path || !outputPath) {
				throw new Error('path 与 output_path 都必填');
			}
			const replacements = Array.isArray(args.replacements) ? args.replacements : [];
			if (replacements.length === 0) {
				throw new Error('replacements 不能为空：至少要替换一处（只删段落时用 removals，别传空数组碰运气）');
			}
			return await invoke(config, exec, {
				command: 'write',
				args: {
					path,
					output_path: outputPath,
					replacements,
					...(Array.isArray(args.additions) ? { additions: args.additions } : {}),
					...(Array.isArray(args.removals) ? { removals: args.removals } : {}),
				},
			});
		},
	}));
}
