/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 命令输出的 token 效率管道（纯逻辑，零依赖，可独立单测）。
 *
 * ## 动机：本项目原先的输出处理信息密度最低（横向对标 2026-08-22）
 *
 * 原实现只有一步头尾截断：
 *
 *   s.slice(0, 32KB) + "... (N chars omitted) ..." + s.slice(-32KB)
 *
 * 于是 ANSI 转义、`\r` 重绘的进度帧、npm deprecation 噪音、依赖栈帧全部**原样占
 * token**，而真正有用的中段被永久丢弃。MiMo-Code 的
 * `tool/bash_token_efficient_pipeline.ts` + `bash_token_efficient_heuristic.ts`
 * 是两级设计：公共链先做无损降噪，再按命令形态（tsc / stacktrace / npm / pytest …）
 * 做结构化聚合。本模块移植其架构与三条工程契约。
 *
 * ## 公共链顺序有讲究（照搬 MiMo，不可随意调换）
 *
 *   progress → ansi → redact → longline
 *
 * - `progress` 必须在 `ansi` **之前**：CR 重绘帧的边界依赖 `\r`，而 ANSI 剥离会把
 *   夹在 CR 之间的光标控制序列去掉，先剥 ANSI 会让「同一行的多帧」黏成一片，
 *   无法再判断哪一帧是最终态。
 * - `longline` 必须在 `redact` **之后**：否则长密钥会先被行内截断成两半，
 *   脱敏的正则再也匹配不上（截断点恰好落在 token 中间是常态）。
 *
 * ## 三条工程契约（缺一个都会「优化」出反效果）
 *
 * 1. **passthrough**：命令已显式要求机器可读投影（`--json` / `-o json` / `| tee` /
 *    `| xxd` …）→ 一个字节都不动。用户已经在做投影，二次加工只会破坏格式。
 * 2. **never-worse**：任何一步若没让字节数变小，就丢弃该步结果用原文。启发式重写
 *    有可能变长（例如聚合摘要比原始 3 行还长），这条契约让「优化」永不为负。
 * 3. **opt-out**：命令含 `# nofilter` / `# raw` → 整个管道跳过。排障时需要原始输出。
 */

/** 单步处理器。 */
interface IPipelineStage {
	readonly name: string;
	readonly run: (input: string) => string;
}

/** 管道结果。 */
export interface IExecOutputPipelineResult {
	/** 处理后的文本。 */
	readonly text: string;
	/** 实际生效（即真的让字节变小）的步骤名，按执行序。用于日志与单测断言。 */
	readonly appliedStages: readonly string[];
	/** 是否因 passthrough / opt-out 整体跳过。 */
	readonly skipped: boolean;
	/** 跳过原因（`skipped` 为 true 时有值）。 */
	readonly skipReason?: string;
}

// ── passthrough / opt-out 判据 ──────────────────────────────────────────────

/**
 * 命令是否已在做机器可读投影 —— 此时输出不能动。
 *
 * 刻意只认**显式**的投影意图；不做「命令看起来像 xxx」的泛化猜测，否则会把普通
 * 构建命令误判成 passthrough 而丧失全部收益。
 */
function _isPassthroughCommand(command: string): boolean {
	if (!command) { return false; }
	return /(?:^|\s)--json(?:=|\s|$)/i.test(command)
		|| /(?:^|\s)-o\s+json\b/i.test(command)
		|| /(?:^|\s)--format[= ]json\b/i.test(command)
		|| /(?:^|\s)--output[= ]json\b/i.test(command)
		|| /\|\s*(?:tee|xxd|hexdump|od|base64)\b/i.test(command)
		|| /(?:^|\s)(?:xxd|hexdump|base64)\s/i.test(command);
}

/** 命令是否显式要求关闭过滤（排障用）。 */
function _isOptOutCommand(command: string): boolean {
	return /#\s*(?:nofilter|raw)\b/i.test(command);
}

// ── 公共链各步 ─────────────────────────────────────────────────────────────

/**
 * 折叠 `\r` 重绘：同一物理行被反复覆写时（进度条、下载百分比、webpack 进度），
 * 只保留最后一帧。
 *
 * 必须在 ANSI 剥离之前跑 —— 见模块头注释。
 */
export function collapseProgressFrames(input: string): string {
	if (!input.includes('\r')) { return input; }
	return input
		.split('\n')
		.map(line => {
			if (!line.includes('\r')) { return line; }
			// 一行内的多帧：取最后一个非空帧（末尾可能是空的 CR）
			const frames = line.split('\r');
			for (let i = frames.length - 1; i >= 0; i--) {
				if (frames[i].trim().length > 0) { return frames[i]; }
			}
			return '';
		})
		.join('\n');
}

/** 剥 ANSI/控制序列：CSI（含 SGR）、OSC、DCS/APC/PM、以及裸控制字节。 */
export function stripAnsiSequences(input: string): string {
	if (!input) { return ''; }
	let out = input
		// CSI：ESC [ ... final-byte
		.replace(/\x1b\[[0-9;:?<>=]*[ -/]*[@-~]/g, '')
		// OSC：ESC ] ... (BEL | ST)
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
		// DCS / SOS / PM / APC：ESC (P|X|^|_) ... ST
		.replace(/\x1b[P^_X][^\x1b]*(?:\x1b\\)?/g, '')
		// 单字符 ESC 序列（ESC ( B 之类的字符集选择）
		.replace(/\x1b[()][A-Za-z0-9]/g, '')
		.replace(/\x1b[=>]/g, '');
	// backspace overstrike（`a\bb` → `b`），man page 风格加粗的产物
	while (/[^\n\x08]\x08/.test(out)) {
		out = out.replace(/[^\n\x08]\x08/g, '');
	}
	// 剩余裸控制字节（保留 \n 与 \t）
	return out.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/**
 * 终端注入序列清洗（P1-2，对齐 openclaw `stripDsrRequests`）。
 * 命令输出可能夹带 CSI 控制序列（设备状态报告 DSR、光标位置报告 CPR、OSC 转义、
 * 8-bit CSI）对宿主终端做 prompt injection。`ansi` 阶段已剥大部分，但只认 `ESC [`
 * 表单，这里显式兜底 8-bit CSI（0x9B）与裸 ESC 字母序列，并作为**独立、必定执行**
 * 的阶段（不依赖命令形态），确保任何命令输出都不会把注入序列透传给模型。
 */
export function stripTerminalInjectionSequences(input: string): string {
	if (!input) { return ''; }
	return input
		// 8-bit CSI（0x9B）表单
		.replace(/\x9b[0-9;:<>=?]*[ -/]*[@-~]/g, '')
		// 设备状态报告 / 光标位置报告：ESC [ ( ? | > | = )? <digits> ; <digits> ( c | R )
		.replace(/\x1b\[[?>=]?[0-9;]*(?:c|R)/gi, '')
		// OSC（ESC ] ... ST/BEL）兜底
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
		// 裸 ESC 后跟大小写字母（字符集 / 模式切换等）
		.replace(/\x1b[=>A-Za-z]/g, '');
}

/** 需要脱敏的凭据形态。顺序无关（各自独立匹配）。 */
const SECRET_PATTERNS: readonly { readonly re: RegExp; readonly label: string }[] = [
	{ re: /\bBearer\s+[A-Za-z0-9\-._~+/]{16,}=*/gi, label: 'Bearer' },
	{ re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, label: 'JWT' },
	{ re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, label: 'PEM' },
	{ re: /\bAKIA[0-9A-Z]{16}\b/g, label: 'AWS' },
	{ re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, label: 'GitHub' },
	{ re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9\-_]{16,}\b/g, label: 'APIKey' },
	{ re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: 'Slack' },
	// KEY=VALUE 形态（仅当 key 名含敏感词），保留 key 便于定位
	{ re: /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*[=:]\s*\S+/g, label: 'EnvSecret' },
];

/** 脱敏。必须在 longline 折叠之前 —— 见模块头注释。 */
export function redactSecretsInOutput(input: string): string {
	if (!input) { return ''; }
	let out = input;
	for (const { re, label } of SECRET_PATTERNS) {
		out = out.replace(re, (m, key?: string) =>
			label === 'EnvSecret' && key ? `${key}=<redacted>` : `<redacted:${label}>`);
	}
	return out;
}

/** 超长单行折叠阈值（字符）。minified bundle / base64 数据行的主要来源。 */
export const LONG_LINE_MAX = 500;

/** 折叠超长行：保留首尾各一段，中间标注省略字符数。 */
export function foldLongLines(input: string, maxChars: number = LONG_LINE_MAX): string {
	if (!input) { return ''; }
	const keep = Math.max(40, Math.floor(maxChars / 4));
	return input
		.split('\n')
		.map(line => {
			if (line.length <= maxChars) { return line; }
			const elided = line.length - keep * 2;
			return `${line.slice(0, keep)} <…${elided} chars elided…> ${line.slice(-keep)}`;
		})
		.join('\n');
}

// ── Shape 层：按命令形态做结构化聚合 ────────────────────────────────────────

/** 依赖栈帧标记 —— 这些帧对定位自己的 bug 无用，是 stacktrace 的主要体积来源。 */
const DEPENDENCY_FRAME_RE = /(?:[\\/]node_modules[\\/]|[\\/]site-packages[\\/]|[\\/]dist-packages[\\/]|(?:^|[\\/])internal[\\/]modules[\\/]|node:internal[\\/])/;

/** 一行是否是栈帧（Node `at ...` / Python `File "...", line N`）。 */
function _isStackFrameLine(line: string): boolean {
	const t = line.trim();
	return /^at\s+\S/.test(t) || /^File\s+"[^"]+",\s+line\s+\d+/.test(t);
}

/**
 * 折叠连续的**依赖**栈帧为一行计数标记，自己的代码帧全部保留。
 *
 * 只折叠「连续段」：中间夹了自己的代码帧就分段计数，保留调用顺序的可读性。
 */
export function foldDependencyStackFrames(input: string): string {
	if (!input) { return ''; }
	const lines = input.split('\n');
	const out: string[] = [];
	let run = 0;
	const flush = () => {
		if (run > 0) {
			out.push(`    <[${run} dependency frame(s) suppressed]>`);
			run = 0;
		}
	};
	for (const line of lines) {
		if (_isStackFrameLine(line) && DEPENDENCY_FRAME_RE.test(line)) {
			run++;
			continue;
		}
		flush();
		out.push(line);
	}
	flush();
	return out.join('\n');
}

/** TypeScript 诊断行：`path(line,col): error TSxxxx: message`。 */
const TSC_DIAG_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s*(.*)$/;

/** tsc 聚合的触发下限：少于这么多条诊断时原样保留（聚合反而更长）。 */
const TSC_AGGREGATE_MIN = 12;

/**
 * `tsc` 输出聚合：诊断条数很多时，按**错误码**与**文件**给出 Top 分布，
 * 并保留前若干条原始诊断作为样例。
 *
 * 动机：tsc 的错误往往是同一个根因在几十上百处重复（例如一个类型改动）。原先的
 * 头尾截断会同时「保留大量重复」+「丢弃中段」，是最坏组合。
 */
export function aggregateTscDiagnostics(input: string): string {
	if (!input) { return ''; }
	const lines = input.split('\n');
	const diags: { file: string; code: string; sev: string; raw: string }[] = [];
	const others: string[] = [];
	for (const line of lines) {
		const m = TSC_DIAG_RE.exec(line.trim());
		if (m) {
			diags.push({ file: m[1], code: m[5], sev: m[4], raw: line });
		} else if (line.trim().length > 0) {
			others.push(line);
		}
	}
	if (diags.length < TSC_AGGREGATE_MIN) { return input; }

	const byCode = new Map<string, number>();
	const byFile = new Map<string, number>();
	for (const d of diags) {
		byCode.set(d.code, (byCode.get(d.code) ?? 0) + 1);
		byFile.set(d.file, (byFile.get(d.file) ?? 0) + 1);
	}
	const top = (m: Map<string, number>, n: number) =>
		[...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);

	const errors = diags.filter(d => d.sev === 'error').length;
	const parts: string[] = [];
	parts.push(`${diags.length} diagnostics (${errors} error(s)) across ${byFile.size} file(s)`);
	parts.push('');
	parts.push('By error code:');
	for (const [code, n] of top(byCode, 5)) {
		const sample = diags.find(d => d.code === code)?.raw.trim() ?? '';
		const msg = TSC_DIAG_RE.exec(sample)?.[6] ?? '';
		parts.push(`  ${code} ×${n}  ${msg.slice(0, 100)}`);
	}
	parts.push('');
	parts.push('By file:');
	for (const [file, n] of top(byFile, 8)) { parts.push(`  ${file} ×${n}`); }
	if (byFile.size > 8) { parts.push(`  <…${byFile.size - 8} more file(s)…>`); }
	parts.push('');
	parts.push('First diagnostics verbatim:');
	for (const d of diags.slice(0, 10)) { parts.push(d.raw.trim()); }
	if (diags.length > 10) { parts.push(`<…${diags.length - 10} more diagnostic(s) — fix the above first…>`); }
	if (others.length > 0) {
		parts.push('');
		parts.push(...others.slice(0, 5));
	}
	return parts.join('\n');
}

/** npm/yarn/pnpm 噪音行。 */
const NPM_NOISE_RE = /^npm\s+(?:warn|WARN)\s+deprecated\b/;

/** npm deprecation 警告折叠为计数摘要。 */
export function foldNpmNoise(input: string): string {
	if (!input) { return ''; }
	const lines = input.split('\n');
	const out: string[] = [];
	const deprecated: string[] = [];
	for (const line of lines) {
		if (NPM_NOISE_RE.test(line.trim())) { deprecated.push(line.trim()); continue; }
		out.push(line);
	}
	if (deprecated.length === 0) { return input; }
	const first = deprecated[0].replace(/^npm\s+\w+\s+deprecated\s+/i, '').slice(0, 90);
	out.push(`<[×${deprecated.length}] npm deprecation warning(s) suppressed; first: ${first}>`);
	return out.join('\n');
}

// ── 组装 ───────────────────────────────────────────────────────────────────

/** 公共链（顺序不可调换，见模块头注释）。 */
const COMMON_STAGES: readonly IPipelineStage[] = [
	{ name: 'progress', run: collapseProgressFrames },
	{ name: 'ansi', run: stripAnsiSequences },
	{ name: 'inject', run: stripTerminalInjectionSequences },
	{ name: 'redact', run: redactSecretsInOutput },
	{ name: 'longline', run: input => foldLongLines(input) },
];

/**
 * 按命令选择 Shape 步骤。
 *
 * 只在命令**明确是**该形态时启用 —— Shape 是有损聚合，误用会丢信息。
 * 未匹配任何 Shape 时只跑公共链（仍是无损降噪）。
 */
function _shapeStagesFor(command: string): IPipelineStage[] {
	const stages: IPipelineStage[] = [];
	const c = command.toLowerCase();
	if (/\b(?:tsc|tsgo|vue-tsc)\b/.test(c) || /\bnpm\s+run\s+(?:compile|type-?check|build)\b/.test(c)) {
		stages.push({ name: 'tsc', run: aggregateTscDiagnostics });
	}
	if (/\b(?:npm|pnpm|yarn|bun)\b/.test(c)) {
		stages.push({ name: 'npm', run: foldNpmNoise });
	}
	// stacktrace 对任何解释器/测试命令都适用，且只折叠依赖帧（自己的帧全留）
	if (/\b(?:node|python3?|pytest|jest|vitest|mocha|npm|pnpm|yarn|bun|tsx|ts-node)\b/.test(c)) {
		stages.push({ name: 'stacktrace', run: foldDependencyStackFrames });
	}
	return stages;
}

/**
 * 运行 token 效率管道。
 *
 * @param raw 原始命令输出（已去掉 shell 提示符/回显的更佳，但不强制）。
 * @param command 产生该输出的命令，用于 passthrough 判定与 Shape 选择。
 */
export function runExecOutputPipeline(raw: string, command: string): IExecOutputPipelineResult {
	if (!raw) { return { text: '', appliedStages: [], skipped: false }; }
	if (_isOptOutCommand(command)) {
		return { text: raw, appliedStages: [], skipped: true, skipReason: 'opt-out marker (# nofilter / # raw)' };
	}
	if (_isPassthroughCommand(command)) {
		return { text: raw, appliedStages: [], skipped: true, skipReason: 'command already projects machine-readable output' };
	}

	const applied: string[] = [];
	let cur = raw;
	for (const stage of [...COMMON_STAGES, ..._shapeStagesFor(command)]) {
		let next: string;
		try {
			next = stage.run(cur);
		} catch {
			// 单步异常绝不能让整个工具失败 —— 保留上一步结果继续
			continue;
		}
		// never-worse 契约：没让字节变小的步骤一律丢弃
		if (next.length < cur.length) {
			cur = next;
			applied.push(stage.name);
		}
	}
	return { text: cur, appliedStages: applied, skipped: false };
}
