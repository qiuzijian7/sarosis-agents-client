/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// 命令静态分析（对齐 opencode 的 tree-sitter / openclaw 的 analyzeShellCommand）。
// 纯函数、无 Node 内置依赖 → 可在 renderer（common/）安全使用，无需走主进程 IPC。
//
// 两个用途：
//  ① 混淆 / 下载即执行检测（P0-1）：detectCommandObfuscation
//  ② 抽取文件读/写/删 + 网络副作用，喂给审批 reason 文案（P2-2）：classifyCommandEffects

export interface IObfuscationFinding {
	kind: 'remote-pipe' | 'decode-pipe' | 'iex' | 'invoke-expression' | 'eval' | 'command-substitution' | 'backtick' | 'process-substitution';
	matched: string;
	/** true = 明确恶意（下载即执行 / 解码即执行），应直接阻断；false = 需提示但可放行 */
	block: boolean;
}

const REMOTE_PIPE = /\b(?:curl|wget|Invoke-WebRequest|iwr)\b[^|;]*\|\s*(?:ba)?sh\b/i;
const DECODE_PIPE = /\bbase64\s+(?:-d|--decode)\b[^|;]*\|\s*(?:ba)?sh\b/i;
const IEX = /\biex\b/i;
const INVOKE_EXPR = /\bInvoke-Expression\b/i;
const EVAL = /\beval\s+/i;
const CMD_SUB = /\$\([^)]*\)/;
const BACKTICK = /`[^`]*`/;
const PROC_SUB = /<\s*\([^)]*\)/;

/**
 * 检测命令中的混淆 / 下载即执行模式。
 * - block:true 的项（remote-pipe / decode-pipe / iex / invoke-expression）明确恶意，调用方应直接拒绝。
 * - 其余（eval / 命令替换 / 反引号 / 进程替换）属常见写法，仅返回供提示，由既有 BLOCKING_SHELL_TOKENS 决定审批。
 */
export function detectCommandObfuscation(command: string): IObfuscationFinding[] {
	const findings: IObfuscationFinding[] = [];
	const add = (re: RegExp, f: Omit<IObfuscationFinding, 'matched'>) => {
		const m = command.match(re);
		if (m) { findings.push({ ...f, matched: m[0] }); }
	};
	add(REMOTE_PIPE, { kind: 'remote-pipe', block: true });
	add(DECODE_PIPE, { kind: 'decode-pipe', block: true });
	add(IEX, { kind: 'iex', block: true });
	add(INVOKE_EXPR, { kind: 'invoke-expression', block: true });
	add(EVAL, { kind: 'eval', block: false });
	add(CMD_SUB, { kind: 'command-substitution', block: false });
	add(BACKTICK, { kind: 'backtick', block: false });
	add(PROC_SUB, { kind: 'process-substitution', block: false });
	return findings;
}

export interface IEffectClassification {
	reads: string[];
	writes: string[];
	deletes: string[];
	network: boolean;
}

const NETWORK_CMDS = /\b(?:curl|wget|ssh|scp|rsync|ftp|telnet|Invoke-WebRequest|iwr|git|npm|pnpm|yarn|docker|kubectl|aws|az|gcloud)\b/i;
const DELETE_CMDS = /\b(?:rm|del|Remove-Item|rmdir|rmtree|grm|trash)\b/i;
const WRITE_CMDS = /\b(?:mv|move|cp|copy|tee|touch|Set-Content|Out-File|New-Item)\b/i;

/** 按未加引号的 `|` 切分管道段（保留引号边界，粗略处理）。 */
function splitPipes(cmd: string): string[] {
	const segs: string[] = [];
	let cur = '';
	let q: '"' | "'" | '`' | null = null;
	let i = 0;
	while (i < cmd.length) {
		const c = cmd[i];
		if (q) {
			cur += c;
			if (c === q) { q = null; }
			i++;
			continue;
		}
		if (c === '"' || c === "'" || c === '`') { q = c as '"' | "'" | '`'; cur += c; i++; continue; }
		if (c === '|' && cmd[i + 1] !== '|') { segs.push(cur); cur = ''; i++; continue; }
		cur += c; i++;
	}
	segs.push(cur);
	return segs;
}

/** 粗略 token 化（按空白切分并去引号外壳），用于抽取命令名与路径参数。 */
function tokenize(seg: string): string[] {
	return seg.trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/^["'`]|["'`]$/g, ''));
}

/**
 * 从命令抽取文件读/写/删与网络副作用（供审批 reason 文案）。
 * 属启发式，可能误报（如 `>=` 比较）；只用于提升确认卡片可读性，不作安全判定依据。
 */
export function classifyCommandEffects(command: string): IEffectClassification {
	const eff: IEffectClassification = { reads: [], writes: [], deletes: [], network: false };
	for (const seg of splitPipes(command)) {
		const toks = tokenize(seg);
		const head = toks[0]?.toLowerCase() ?? '';
		if (NETWORK_CMDS.test(head)) { eff.network = true; }
		if (DELETE_CMDS.test(head)) {
			for (const a of toks.slice(1)) { if (!a.startsWith('-') && !a.startsWith('/')) { eff.deletes.push(a); } }
		}
		if (WRITE_CMDS.test(head)) {
			for (const a of toks.slice(1)) { if (!a.startsWith('-') && !a.startsWith('/')) { eff.writes.push(a); } }
		}
	}
	// 重定向 `>` / `>>` 抽取写入目标（跳过 fd 前缀 1>/2> 与 & 句柄）
	for (const m of command.matchAll(/>>?\s*([^\s|&;<>]+)/g)) {
		const tgt = m[1].replace(/^["'`]|["'`]$/g, '');
		if (tgt && !tgt.startsWith('&') && !tgt.startsWith('=') && !/^\d$/.test(tgt)) {
			eff.writes.push(tgt);
		}
	}
	return eff;
}

/** 由副作用分类生成人类可读的审批 reason 文案（P2-2）。 */
export function buildShellSafetyReason(effects: IEffectClassification): string {
	const parts: string[] = [];
	if (effects.deletes.length) { parts.push(`删除 ${effects.deletes.slice(0, 4).join('、')}`); }
	if (effects.writes.length) { parts.push(`写入 ${effects.writes.slice(0, 4).join('、')}`); }
	if (effects.network) { parts.push('发起网络请求'); }
	return parts.length ? `命令副作用：${parts.join('；')}` : '命令副作用：未知';
}
