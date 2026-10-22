/**
 * @vssaros/dsh-ego —— ego lite（`ego-browser`）在 DeepSeek Harness 里的**薄接入**。
 *
 * ## 它是什么 / 不是什么（先划清边界）
 *
 * · **是**：① 上游 `skills/ego-browser/` 的随包 vendored 副本（MIT，逐字未改）+ 一个 packaged
 *   skill provider；② 4 个工具（`ego_status` / `ego_guide` / `ego_spaces` / `ego_run`），解决
 *   "Windows 上 Host 进程的 PATH 是陈旧的、模型跑不动 heredoc"这两个真问题。
 * · **不是**：浏览器本体。ego lite 那个 Chromium 应用**不开源、单独下载**（上游 README 原文：
 *   "The ego lite browser is a separate, free download"），`globalThis.ego` 原生绑定由**它**注入
 *   （见上游 `docs/native-bindings-api.md`）。所以本包**不能**替代安装，只能在 app 就绪后更好用。
 *
 * ## 为什么不用 `@citrolabs/ego-deepseek-harness`（上游自带的 dsh 适配）
 *
 * 上游那个适配只做一件事：`ctx.skills.registerProvider` 塞一个技能，**没有工具**（`plugins/ego/dsh/src/index.js`
 * 只有 80 行，全是读 SKILL.md 的 frontmatter）。它在 macOS/CLI 场景够用；在这里不够，两个原因：
 *
 * ① Windows 上没有 heredoc（技能正文教的是 `ego-browser nodejs <<'EOF'`），且 PATH 只对**之后**
 *    启动的进程生效 —— 用户装完 app 再让模型在聊天框里跑，常见结果是 `command not found`；
 * ② 每次都要起终端 → 模型的每一步都变成"写命令、读回显、再写命令"，而 ego 的卖点恰恰是
 *    "写成一段 JS 一次跑完"（少轮次、少 token）。
 *
 * ⇒ 这里把"定位 CLI（不靠 PATH）+ 用 stdin 喂脚本（等价 heredoc、不落临时文件）"做成工具。
 *
 * ## 工具面（4 个，别再加：工具列表是固定预算）
 *
 * · `ego_status`（只读）——CLI 在哪、app 起没起、版本、任务空间几条；
 * · `ego_guide`（只读）——`ego-browser skill` 的完整指南（**API 的唯一真源**：它随安装的 app 版本走）；
 * · `ego_spaces`（只读）——任务空间清单（含 ownership）。
 * · `ego_run`（**动作**）——在 ego 的 node 上下文里执行一段 JS。它能驱动浏览器里**已登录**的站点
 *   ⇒ 逐次**审批**，且 fail-closed（没有审批通道就拒绝执行，可 `config.allowRun` 显式放行给无人值守）。
 *
 * ## 与上游技能的**不冲突**承诺
 *
 * 上游明确写了"用户的个人 `ego-browser` 技能优先于 bundled provider"。我们保持同一档
 * （`source: 'bundled'` + `rank: 600`），**不改名、不遮蔽**：用户自己装了一份就用他那份。
 * 万一两边重复，表现是"技能可选两份/取一份"，不会像同名**工具**那样让整条 entry 失效。
 */

import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, PROBE_TIMEOUT_MS,
	clampTimeout, resolveEgoCli, runEgoCli,
} from './core/cli.js';
import {
	buildPrelude, buildProbeScript, buildSpacesScript,
	formatMissingCli, formatRunReport, formatSpacesReport, formatStatusReport,
	parseMarkedJson, scriptPreview, truncateGuide,
} from './core/scripts.js';

export const name = 'vssaros-ego';
/** `tools` 是硬依赖（本插件就是工具族的载体）；`skills` 走可选注入（见 `apply`）。 */
export const inject = ['tools'];

const SKILL_PATH = fileURLToPath(new URL('../skills/ego-browser/SKILL.md', import.meta.url));
const SKILL_DIRECTORY = dirname(SKILL_PATH);
const SKILL_INVOCATION = Object.freeze({ modelInvocable: true, userInvocable: true });

/** 技能正文里的显式工具名（审批/诊断文案都要用它，避免拼错成两处不同的字面量）。 */
export const RUN_TOOL_NAME = 'ego_run';

const flag = raw => raw === '1' || raw === 'true';

function scalar(value) {
	const trimmed = String(value).trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

/**
 * 读随包技能的 frontmatter（`name` / `description`）与正文。
 *
 * 为什么在这里自己解析：正文是**给模型看的**，我们只需要这几项元数据；用真 YAML 解析器
 * 会多一个依赖（而本包刻意只有 node 内建 ⇒ 装出来不会缺模块）。
 */
function readPackagedSkill() {
	const source = readFileSync(SKILL_PATH, 'utf8');
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
	if (!match) {
		throw new Error('ego-browser 技能缺少 frontmatter：' + SKILL_PATH);
	}
	const frontmatter = match[1];
	const field = key => {
		const value = new RegExp('^' + key + ':\\s*(.+)$', 'm').exec(frontmatter)?.[1];
		if (!value) { throw new Error('ego-browser 技能 frontmatter 缺 ' + key + '：' + SKILL_PATH); }
		return scalar(value);
	};
	return Object.freeze({ name: field('name'), description: field('description'), content: match[2].trimStart() });
}

/** 任务空间 id 归一：只接受正整数（`id` 是数字定位符；名称不是）。 */
function normalizeTaskSpace(raw) {
	if (raw === undefined || raw === null) { return undefined; }
	if (!Number.isInteger(raw) || raw <= 0) {
		throw new Error('taskSpace 必须是正整数（`ego.listTaskSpaces()` 返回的 `id`）。'
			+ '名称/显示名不是定位符；也不接受 0 或 "3" 这种字符串。');
	}
	return raw;
}

export function apply(ctx, config = {}) {
	const env = process.env;
	const configuredCli = typeof config.cliPath === 'string' && config.cliPath.trim() ? config.cliPath.trim() : '';
	/**
	 * `ego_run` 的免问开关（默认**关**）。
	 *
	 * 为什么留它：无人值守（定时任务 / 批处理）里没有审批通道，`ego_run` 会被 fail-closed 拒掉 ——
	 * 那是**对的**默认；但用户显式选择无人值守时，需要一个能开的口子，且必须写在这里（配置文件/
	 * 环境变量），不能由模型自己开 ✓。
	 */
	const allowRun = typeof config.allowRun === 'boolean' ? config.allowRun : flag(env.VSSAROS_EGO_ALLOW_RUN ?? '');
	/** 缺省超时（夹在 [MIN, MAX]）：单次 `ego_run` 的预算；模型可再按次覆盖。 */
	const defaultTimeoutMs = clampTimeout(
		typeof config.timeoutMs === 'number' ? config.timeoutMs : Number.parseInt(env.VSSAROS_EGO_TIMEOUT_MS ?? '', 10),
		DEFAULT_TIMEOUT_MS,
	);

	const log = line => {
		try { process.stdout.write(line + '\n'); } catch { /* 忽略 */ }
		ctx.logger?.info?.(line);
	};

	/** 每次都重新解析（用户可能在我们运行期间装好 app ⇒ 不该把"没找到"缓存成永久结论）。 */
	const resolveCli = () => resolveEgoCli({ explicit: configuredCli, env });

	/** 解析不到时的**同一份**错误文案（4 个工具共用 ⇒ 不会各说各话）。 */
	const missingCliError = resolved => new Error(formatMissingCli({
		platform: process.platform,
		tried: resolved.tried,
	}));

	/**
	 * `ego_run` 的审批（fail-closed）。
	 *
	 * 与 `dsh-plugins/vssaros-browser` 同一条纪律、同一处接缝（`ctx.get('approval')`）：
	 * 自己发起 + 自己判结果 ⇒ **任何部署下都是默认拒绝**（不依赖"运行时会不会问"）。
	 * 文案里必须**回显要找干什么**：`ego_run` 的语义完全由那段脚本决定（读页面标题 vs 读 cookie，
	 * 天壤之别），一句"会操作浏览器"对用户没有判断价值。
	 */
	const requireConsent = async ({ script, taskSpace, describe }, exec) => {
		if (allowRun) { return; }
		const approval = (() => { try { return ctx.get?.('approval'); } catch { return undefined; } })();
		if (!approval || typeof approval.request !== 'function') {
			throw new Error(RUN_TOOL_NAME + ' 会执行一段 JS 驱动 ego lite 里**已登录**的站点，因此需要用户确认；'
				+ '但本部署**没有审批通道** ⇒ 已按 fail-closed 拒绝。'
				+ '接线：启用 dsh 的审批服务（user-approval）；无人值守场景可显式设 `config.allowRun = true` 或环境变量 `VSSAROS_EGO_ALLOW_RUN=1`。');
		}
		const purpose = typeof describe === 'string' && describe.trim() ? describe.trim() : undefined;
		const preview = scriptPreview(script);
		const head = purpose
			? 'ego_run 要在 ego lite 里执行一段 JS：' + purpose
			: 'ego_run 要在 ego lite 里执行一段 JS（它可以用你已登录的站点）';
		const reason = head + '（脚本预览）：\n\n' + preview
			+ (taskSpace === undefined ? '' : '\n\n任务空间：#' + taskSpace);
		const outcome = await approval.request({
			...(exec?.agent === undefined ? {} : { agent: exec.agent }),
			...(exec?.callId === undefined ? {} : { callId: exec.callId }),
			...(exec?.signal === undefined ? {} : { signal: exec.signal }),
			toolName: RUN_TOOL_NAME,
			reason,
			displayReason: {
				zh: '允许 ' + RUN_TOOL_NAME + ' 在 ego lite 里执行这段脚本？\n\n' + preview,
				en: 'Allow ' + RUN_TOOL_NAME + ' to run this script in ego lite?\n\n' + preview,
			},
		});
		if (outcome !== 'allowed-once') {
			throw new Error(RUN_TOOL_NAME + ' 未获准（' + String(outcome) + '）⇒ 已拒绝执行（没有碰浏览器）。');
		}
	};

	/** 统一的"跑一段脚本并渲染"入口（三个只读工具共用，避免三份重复的错误处理）。 */
	const runScript = async ({ args, stdin, timeoutMs, onOutput }) => {
		const resolved = resolveCli();
		if (!resolved.path) { throw missingCliError(resolved); }
		const result = await runEgoCli({ cliPath: resolved.path, args, stdin, timeoutMs, env });
		return onOutput(result, resolved);
	};

	const statusTool = {
		name: 'ego_status',
		description: '诊断 ego lite（ego-browser）当前能不能用：CLI 在哪、原生绑定在不在、版本、任务空间几条。'
			+ '`probe: true` 会真的起一次 node 上下文（会拉起/连接 app，约 1–30s）；不带 probe 只看文件系统，秒回。'
			+ '**连不上先调它**：它会说出"没装 / 没运行 / 版本太老 / 要重启 VsSaros（PATH 陈旧）"里到底是哪一种，别靠猜。',
		parameters: {
			type: 'object',
			properties: {
				probe: { type: 'boolean', description: 'true = 真的连一次运行时并问版本/任务空间（慢但确定）；缺省只做静态检查' },
			},
		},
		output: {
			schema: { type: 'string' },
			render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
		},
		isConcurrencySafe: true,
		execute: async params => {
			const resolved = resolveCli();
			const probe = params?.probe === true;
			if (!resolved.path) {
				return formatStatusReport({ platform: process.platform, resolved: undefined, probe: false })
					+ '\n\n' + formatMissingCli({ platform: process.platform, tried: resolved.tried });
			}
			if (!probe) { return formatStatusReport({ platform: process.platform, resolved, probe: false }); }
			const result = await runEgoCli({ cliPath: resolved.path, args: ['nodejs'], stdin: buildProbeScript(), timeoutMs: PROBE_TIMEOUT_MS, env });
			const probed = parseMarkedJson(result.stdout);
			const probeError = result.code === 0
				? undefined
				: ('CLI 退出码 ' + result.code + (result.timedOut ? '（超时）' : '')
					+ (String(result.stderr ?? '').trim() ? '：' + String(result.stderr).trim().split(/\r?\n/)[0] : ''));
			const report = formatStatusReport({ platform: process.platform, resolved, probe: true, probeError, probed });
			const raw = String(result.stdout ?? '').trim();
			return raw ? report + '\n\n### 运行时原始输出\n\n' + raw.slice(0, 4000) : report;
		},
	};

	const guideTool = {
		name: 'ego_guide',
		description: '打印 ego-browser 的**完整使用指南**（`ego-browser skill` 的输出）——它是 ego API 的唯一真源，'
			+ '随你安装的 app 版本走。做任何浏览器任务**之前**先调它（或确认本回合已经读过）；'
			+ '指南末尾有 `[ego-browser:skill] end of guide` 才是完整输出。'
			+ '⚠ 不要用终端 heredoc 代替：Windows/PowerShell 没有 heredoc，用 `ego_run` 直接跑脚本更省轮次。',
		parameters: { type: 'object', properties: {} },
		output: {
			schema: { type: 'string' },
			render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
		},
		isConcurrencySafe: true,
		execute: async () => runScript({
			args: ['skill'],
			stdin: '',
			timeoutMs: PROBE_TIMEOUT_MS,
			onOutput: result => {
				const out = String(result.stdout ?? '');
				const err = String(result.stderr ?? '').trim();
				if (/Unknown command:\s*skill/i.test(out + '\n' + err)) {
					return '## 要升级 ego lite\n\n安装的版本太老（`ego-browser skill` 不认这个子命令）。'
						+ '让用户跑一次 `ego-browser upgrade`（或重装 ego lite），完成后重新调 `ego_guide`。\n\n'
						+ '### 原始输出\n\n' + (out + '\n' + err).trim();
				}
				if (result.code !== 0) {
					return '## 取指南失败（退出码 ' + result.code + '）\n\n' + (err || out).trim()
						+ '\n\n先用 `ego_status`（`probe: true`）确认 app 在运行。';
				}
				const guide = truncateGuide(out);
				const complete = out.includes('[ego-browser:skill] end of guide');
				return guide.text + (complete ? '' : '\n\n⚠ 输出里**没有** `[ego-browser:skill] end of guide` 结束行 ⇒ 可能被截断。'
					+ '要读后段请按主题用 `ego_run` 调 `help()`，别把上面那段当全文。');
			},
		}),
	};

	const spacesTool = {
		name: 'ego_spaces',
		description: '列出 ego lite 里的**任务空间**（Spaces）：id / 名称 / ownership / 最近标签页。只读，不选中也不认领。'
			+ '要用其中某一条：给 `ego_run` 传 `taskSpace: <id>`。用户自己开的空间（ownership=user）'
			+ '需要先 `ego.claimTaskSpace(id)` 才能被自动化操作（会改变归属 ⇒ 用 `ego_run` 并说明）。',
		parameters: { type: 'object', properties: {} },
		output: {
			schema: { type: 'string' },
			render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
		},
		isConcurrencySafe: true,
		execute: async () => runScript({
			args: ['nodejs'],
			stdin: buildSpacesScript(),
			timeoutMs: PROBE_TIMEOUT_MS,
			onOutput: result => {
				const payload = parseMarkedJson(result.stdout);
				const report = formatSpacesReport(payload);
				const err = String(result.stderr ?? '').trim();
				return err ? report + '\n\n### stderr\n\n' + err : report;
			},
		}),
	};

	const runTool = {
		name: RUN_TOOL_NAME,
		description: '在 ego lite 的 node 上下文里执行一段 JS（`ego-browser nodejs` 的语义，脚本走 stdin ⇒ 不需要 heredoc）。'
			+ '这是驱动浏览器的**主力工具**：`ego.createTaskSpace` / `ego.snapshot` / `ego.createTab` / CDP 都在这个上下文里，'
			+ '写法照 `ego_guide` 给的指南（先读指南再写脚本，别凭记忆调 API）。'
			+ '**必须** `console.log(...)` 才有输出（返回值不会自动回来）；多步任务尽量写成一段脚本一次跑完（省轮次）。'
			+ '⚠ 它可以用你**已登录**的站点 ⇒ 每次调用都要用户批准；没有审批通道时默认拒绝。'
			// 【选谁】2026-10-21：与 `browser` 工具双向提示（那边也写了同一件事的另一半）。
			// 只做提示、不做自动改道：两个浏览器**登录态不共通**，静默切换等于把用户骗进登录墙。
			+ '【选谁】要复用用户**当前那个本机 Chrome** 的登录态 / 已打开的标签页 ⇒ 用 `browser` 工具；'
			+ 'ego lite 是**另一个浏览器**（独立 Space、登录态不共通），适合"agent 后台长时间多页并行"这类活。'
			+ '`taskSpace` 只是本次调用的预选（`ego.useTaskSpace(id)`），不会记住。',
		parameters: {
			type: 'object',
			properties: {
				script: { type: 'string', description: '要执行的 JS（可含 top-level await）。要结果就 console.log(JSON.stringify(...))' },
				taskSpace: { type: 'integer', description: '本次调用预选的任务空间 id（正整数，来自 ego_spaces）；不给则不预选' },
				timeoutMs: { type: 'integer', description: '超时毫秒数（缺省 ' + DEFAULT_TIMEOUT_MS + '，夹在 ' + MIN_TIMEOUT_MS + '～' + MAX_TIMEOUT_MS + '）' },
				describe: { type: 'string', description: '一句话说明这段脚本要干什么（会显示在审批卡片上；越具体越好）' },
			},
			required: ['script'],
		},
		output: {
			schema: { type: 'string' },
			render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
		},
		// 有副作用 ⇒ 独占（同一时刻两个脚本抢同一个任务空间只会互相踩）。
		isConcurrencySafe: false,
		execute: async (params, exec) => {
			const script = typeof params?.script === 'string' ? params.script : '';
			if (!script.trim()) {
				throw new Error(RUN_TOOL_NAME + ' 需要 script（要执行的 JS 源码）。只读动作请优先用 ego_status / ego_spaces / ego_guide。');
			}
			const taskSpace = normalizeTaskSpace(params?.taskSpace);
			const timeoutMs = clampTimeout(Number.isFinite(params?.timeoutMs) ? params.timeoutMs : undefined, defaultTimeoutMs);
			// 审批在**碰浏览器之前**（参数校验也在它之前：不该让用户为一个必然失败的调用点确认）。
			await requireConsent({ script, taskSpace, describe: params?.describe }, exec);
			const resolved = resolveCli();
			if (!resolved.path) { throw missingCliError(resolved); }
			const body = [buildPrelude(taskSpace), script].filter(Boolean).join('\n');
			const result = await runEgoCli({ cliPath: resolved.path, args: ['nodejs'], stdin: body, timeoutMs, env });
			return formatRunReport({ result, taskSpace });
		},
	};

	ctx.effect(() => {
		const disposers = [statusTool, guideTool, spacesTool, runTool].map(def => ctx.tools.register(def));
		return () => {
			for (const disposer of disposers) {
				try {
					if (typeof disposer === 'function') { disposer(); } else { disposer?.dispose?.(); }
				} catch { /* 摘不掉不该影响卸载 */ }
			}
		};
	});

	/**
	 * 随包技能（上游 `skills/ego-browser/` 的逐字副本）。
	 *
	 * 走**可选注入**（`ctx.inject(['skills'], …)`）：拿不到 `skills` 服务时工具照常可用
	 * （指南随时能用 `ego_guide` 取），只是技能库里看不到它 —— 这比"整个插件不激活"好得多。
	 * `source: 'bundled'` + `rank: 600` 与上游适配同档：用户自己的 `ego-browser` 技能优先 ✓。
	 */
	try {
		const packaged = readPackagedSkill();
		const candidate = Object.freeze({
			name: packaged.name,
			description: packaged.description,
			invocation: SKILL_INVOCATION,
			provider: name,
			source: 'bundled',
			resourceBase: Object.freeze({ kind: 'directory', path: SKILL_DIRECTORY }),
			rank: 600,
			locator: SKILL_PATH,
			path: SKILL_PATH,
		});
		const provider = Object.freeze({
			name,
			async list() { return [candidate]; },
			async get(hit) {
				if (hit?.name !== candidate.name || hit?.locator !== candidate.locator) { return undefined; }
				return {
					name: candidate.name,
					description: candidate.description,
					invocation: SKILL_INVOCATION,
					provider: name,
					source: 'bundled',
					resourceBase: candidate.resourceBase,
					path: SKILL_PATH,
					content: packaged.content,
				};
			},
		});
		ctx.inject(['skills'], c => {
			c.skills.registerProvider(() => provider);
		});
	} catch (error) {
		// 技能坏了**不能**连累工具（工具才是 Windows 上不可替代的那部分）——但要喊出来。
		log('[vssaros-ego] 随包技能加载失败（工具仍可用）：' + String(error?.message ?? error));
	}

	log('[vssaros-ego] apply（cli=' + (configuredCli || '(自动探测)') + ' run=' + (allowRun ? 'allowed' : 'ask')
		+ ' timeout=' + defaultTimeoutMs + 'ms）');
}
