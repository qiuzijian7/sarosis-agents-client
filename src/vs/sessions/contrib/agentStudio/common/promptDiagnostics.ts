/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 提示词可观测性 —— 回答「**谁变了 / 谁失败了**」，而不只是「一共多大」。
 *
 * ## 为什么需要这一层
 * 本项目已有的提示词日志全是**聚合数字**：
 *   · `Tiered prompt: stable=18917 context=3120 volatile=0` —— 只有字符数；
 *   · `Fork prefix-cache: aligned=false childFp=e8659e01` —— 只有一个指纹值；
 *   · `Enriched user message (2000 → 9000 chars)` —— 只有总长度。
 * 于是三类高频问题**没有任何线索**：
 *   ① 缓存命中率骤降 → 前缀断了，但断在 system 还是 tools？哪一段变的？
 *   ② 某个 XML 标签没出现 → 是本轮无内容，还是 provider 抛错被静默吞掉？
 *   ③ stable 层本该会话内恒定，真变了却只能靠 chars 偶然发现。
 *
 * 这与 `promptOverhead`（聚合残差答不了「谁在吃 context」，已由 `promptBudget.ts`
 * 按段归因解决）是**同一族问题**：可观测性必须落到「可归因的最小单元」。
 *
 * ## 与 promptBudget 的分工（勿混淆）
 *   · `promptBudget.ts` —— **体量**归因：谁占了多少 token。
 *   · 本模块           —— **变化与失败**归因：谁变了、谁失败了。
 * 两者都按「段」为单位，段名来自 driver 的同一份 `promptSegments` 登记。
 *
 * ## 指纹口径
 * 复用 `forkContext.fnv1a`（**全仓唯一 hash 真源**）。绝不在此另写 hash ——
 * 否则本模块报「前缀没变」而 fork 判定报「变了」会同时成立。
 *
 * 纯函数、零依赖 → 可单测、可在 common 层安全使用。
 */

import { fnv1a } from './forkContext.js';

// ─── 前缀指纹快照 ───────────────────────────────────────────────────────

export interface IPromptSegmentFingerprint {
	readonly name: string;
	readonly fp: string;
	readonly chars: number;
}

export interface IPromptPrefixSnapshot {
	/** 冻结前缀（stable + context）整体指纹 —— 与 provider 前缀缓存直接相关。 */
	readonly frozenFp: string;
	readonly stableFp: string;
	readonly contextFp: string;
	/** volatile 指纹。**不进冻结前缀**，其变化属预期，不影响前缀缓存。 */
	readonly volatileFp: string;
	/** 各命名段指纹（来自 driver 的 promptSegments 登记）。 */
	readonly segments: ReadonlyArray<IPromptSegmentFingerprint>;
	readonly stableChars: number;
	readonly contextChars: number;
	readonly volatileChars: number;
}

export interface IPromptPrefixInput {
	readonly stable: string;
	readonly context: string;
	readonly volatile: string;
	/** 命名段（stable + context 的段；volatile 不在其中）。 */
	readonly segments?: ReadonlyArray<{ readonly name: string; readonly text: string }>;
}

export function snapshotPromptPrefix(input: IPromptPrefixInput): IPromptPrefixSnapshot {
	const stable = input.stable ?? '';
	const context = input.context ?? '';
	const volatileText = input.volatile ?? '';
	// frozen 指纹按「stable + context」拼接后取 —— 与 composeFrozenPrefix 的语义一致：
	// 两层内容互换位置也应视为变化，故不能用 fp(stable)+fp(context) 简单相加。
	return {
		frozenFp: fnv1a(`${stable}\n\n${context}`),
		stableFp: fnv1a(stable),
		contextFp: fnv1a(context),
		volatileFp: fnv1a(volatileText),
		segments: (input.segments ?? []).map((s) => ({
			name: s.name,
			fp: fnv1a(s.text ?? ''),
			chars: (s.text ?? '').length,
		})),
		stableChars: stable.length,
		contextChars: context.length,
		volatileChars: volatileText.length,
	};
}

// ─── 前缀变化对比 ───────────────────────────────────────────────────────

export interface IPromptPrefixDelta {
	/** 冻结前缀是否变化 —— 只有这个为 true 才意味着**前缀缓存会断**。 */
	readonly frozenChanged: boolean;
	/** volatile 是否变化（属预期，单独列出以免与前缀断裂混为一谈）。 */
	readonly volatileChanged: boolean;
	/** 变化的层：'stable' / 'context'（不含 volatile）。 */
	readonly tiersChanged: ReadonlyArray<string>;
	readonly segmentsAdded: ReadonlyArray<string>;
	readonly segmentsRemoved: ReadonlyArray<string>;
	readonly segmentsChanged: ReadonlyArray<{ readonly name: string; readonly fromChars: number; readonly toChars: number }>;
	/**
	 * 冻结前缀变了但**没有任何段能解释**（段全等）——
	 * 说明变化来自未登记内容（裸 push 的段、层拼接顺序、或 driver 之外的追加）。
	 * 这是最需要警惕的情形：不可归因的前缀漂移。
	 */
	readonly unexplained: boolean;
}

export function diffPromptPrefix(prev: IPromptPrefixSnapshot | undefined, next: IPromptPrefixSnapshot): IPromptPrefixDelta {
	if (!prev) {
		return {
			frozenChanged: false, volatileChanged: false, tiersChanged: [],
			segmentsAdded: [], segmentsRemoved: [], segmentsChanged: [], unexplained: false,
		};
	}
	const tiersChanged: string[] = [];
	if (prev.stableFp !== next.stableFp) { tiersChanged.push('stable'); }
	if (prev.contextFp !== next.contextFp) { tiersChanged.push('context'); }

	const prevMap = new Map(prev.segments.map((s) => [s.name, s]));
	const nextMap = new Map(next.segments.map((s) => [s.name, s]));
	const segmentsAdded: string[] = [];
	const segmentsRemoved: string[] = [];
	const segmentsChanged: Array<{ name: string; fromChars: number; toChars: number }> = [];
	for (const [name, s] of nextMap) {
		const before = prevMap.get(name);
		if (!before) { segmentsAdded.push(name); }
		else if (before.fp !== s.fp) { segmentsChanged.push({ name, fromChars: before.chars, toChars: s.chars }); }
	}
	for (const name of prevMap.keys()) {
		if (!nextMap.has(name)) { segmentsRemoved.push(name); }
	}

	const frozenChanged = prev.frozenFp !== next.frozenFp;
	const anySegmentEvidence = segmentsAdded.length > 0 || segmentsRemoved.length > 0 || segmentsChanged.length > 0;
	return {
		frozenChanged,
		volatileChanged: prev.volatileFp !== next.volatileFp,
		tiersChanged,
		segmentsAdded,
		segmentsRemoved,
		segmentsChanged,
		unexplained: frozenChanged && !anySegmentEvidence,
	};
}

/**
 * 渲染前缀指纹日志。
 *
 * ⚠ 格式是**对外契约**（会被 grep 统计）：首行以 `[PromptFingerprint]` 开头，
 * 变化明细以 `  ` 缩进。改动前先看单测。
 *
 * @returns `{ text, level }` —— `level='warn'` 表示前缀断裂（需要关注），
 *          `'info'` 表示基线或仅 volatile 变化（预期行为）。
 */
export function formatPromptPrefixLog(
	snap: IPromptPrefixSnapshot,
	delta: IPromptPrefixDelta | undefined,
	note?: string,
): { readonly text: string; readonly level: 'info' | 'warn' } {
	const head =
		`[PromptFingerprint] frozen=${snap.frozenFp} stable=${snap.stableFp} context=${snap.contextFp} volatile=${snap.volatileFp}` +
		` | chars: stable=${snap.stableChars} context=${snap.contextChars} volatile=${snap.volatileChars}` +
		` | segments=${snap.segments.length}` +
		(note ? ` | ${note}` : '');

	if (!delta || (!delta.frozenChanged && !delta.volatileChanged)) {
		return { text: head, level: 'info' };
	}

	const lines: string[] = [head];
	if (delta.frozenChanged) {
		// 前缀断裂 = 本轮 provider 前缀缓存必然 miss，这是命中率骤降的头号原因。
		lines.push(`  ⚠ FROZEN PREFIX CHANGED → prompt cache will MISS this turn. tiers=[${delta.tiersChanged.join(', ') || '(none)'}]`);
		for (const s of delta.segmentsChanged) {
			lines.push(`    changed: ${s.name} (${s.fromChars} → ${s.toChars} chars)`);
		}
		if (delta.segmentsAdded.length > 0) { lines.push(`    added:   ${delta.segmentsAdded.join(', ')}`); }
		if (delta.segmentsRemoved.length > 0) { lines.push(`    removed: ${delta.segmentsRemoved.join(', ')}`); }
		if (delta.unexplained) {
			lines.push('    ⚠ UNEXPLAINED: no registered segment changed — the drift comes from unregistered content');
			lines.push('      (a bare *Parts.push instead of pushSeg, tier join order, or an append outside agentDriverService)');
		}
	}
	if (delta.volatileChanged && !delta.frozenChanged) {
		// volatile 不进前缀指纹 → 变化是设计预期，明确说出来避免被当成故障。
		lines.push('  volatile tier changed (expected — not part of the frozen prefix, does not break cache)');
	}
	return { text: lines.join('\n'), level: delta.frozenChanged ? 'warn' : 'info' };
}

// ─── 富化标签统计 ───────────────────────────────────────────────────────

/** 单个 XML 标签 provider 的产出统计。 */
export interface IEnrichTagStat {
	readonly tagName: string;
	/** 产出内容长度；失败或空产出为 0。 */
	readonly chars: number;
	/** provider 抛错。**必须可见** —— 改前是 `catch {}` 静默吞掉。 */
	readonly failed: boolean;
	/** 失败原因（已截断，避免长堆栈刷日志）。 */
	readonly error?: string;
	/** 产出为空（非失败）—— 属正常情况（如本轮无 git 变更）。 */
	readonly empty: boolean;
}

/**
 * 渲染富化明细日志。
 *
 * 逐标签可见是核心：改前只有一个总长度，导致「某标签为何没出现」无法回答 ——
 * 是本轮真无内容，还是 provider 抛错被静默吞了？（历史上「Enriched (0 chars
 * added)」的误判正源于这层缺失。）
 *
 * ⚠ 格式是对外契约：首行以 `[PromptEnrich]` 开头。
 */
export function formatEnrichmentLog(
	stats: ReadonlyArray<IEnrichTagStat>,
	origChars: number,
	finalChars: number,
): { readonly text: string; readonly level: 'info' | 'warn' } {
	const failed = stats.filter((s) => s.failed);
	const emitted = stats.filter((s) => !s.failed && !s.empty);
	const empty = stats.filter((s) => !s.failed && s.empty);

	const head =
		`[PromptEnrich] ${origChars} → ${finalChars} chars (+${finalChars - origChars})` +
		` | tags: ${emitted.length} emitted, ${empty.length} empty, ${failed.length} failed`;

	const lines: string[] = [head];
	if (emitted.length > 0) {
		const detail = [...emitted]
			.sort((a, b) => b.chars - a.chars)
			.map((s) => `${s.tagName}=${s.chars}`)
			.join(', ');
		lines.push(`  emitted: ${detail}`);
	}
	if (empty.length > 0) {
		lines.push(`  empty:   ${empty.map((s) => s.tagName).join(', ')}`);
	}
	for (const f of failed) {
		// 每个失败单独一行 —— 失败是缺陷信号，不做聚合折叠。
		lines.push(`  ⚠ FAILED: ${f.tagName} — ${f.error ?? '(no message)'}`);
	}
	return { text: lines.join('\n'), level: failed.length > 0 ? 'warn' : 'info' };
}

/** 截断 provider 错误信息，避免长堆栈把日志刷爆。 */
export function summarizeProviderError(err: unknown, maxChars: number = 200): string {
	const raw = err instanceof Error ? (err.message || err.name) : String(err);
	const oneLine = raw.replace(/\s+/g, ' ').trim();
	return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars)}…` : oneLine;
}

// ─── 工具 description 送达可观测 ────────────────────────────────────────

/**
 * 需要验证「关键引导文案是否真的送达模型」的工具及其探针。
 *
 * ## 为什么需要（2026-08-22，日志 1787384463685）
 * 把重要引导写进 description 之后，一旦模型不遵守，此前**无法区分三种情形**：
 *   ① description 根本没进 tools schema（组装漏了 / 工具被折叠替换成桥接）；
 *   ② 进了但被截断（provider 或中间层对超长 description 做了裁剪）；
 *   ③ 完整送达、模型就是不听。
 * 靠 `toolsSchemaTokens` 的差值只能间接推断（13509→13912 说明「变长了」），
 * 每次都要人工换算、且无法定位到具体哪个工具。
 *
 * 本表让日志直接给出结论：每个关键工具的 description 实际长度 + 探针是否命中。
 * 探针取自**文案里的稳定子串**，故文案改写时探针要一起改（有验证脚本钉住）。
 *
 * ⚠ 特别注意「工具被折叠」这种情形：折叠后模型看到的是 `tool_search`/`tool_call`
 * 桥接，**真实工具的 description 压根不在 schema 里** —— 这时探针 miss 是正确结果，
 * 说明问题在折叠策略而不在文案。
 */
export const TOOL_GUIDANCE_PROBES: ReadonlyArray<{
	readonly tool: string;
	readonly probe: string;
	readonly label: string;
}> = [
		{ tool: 'file_read', probe: 'TOTAL line count', label: 'probeHint' },
		{ tool: 'file_read', probe: 'NEVER use shell commands to count lines', label: 'noShellCount' },
		{ tool: 'execute_code', probe: 'COMMAND SHAPE DECIDES', label: 'approvalShape' },
		{ tool: 'terminal', probe: 'COMMAND SHAPE DECIDES', label: 'approvalShape' },
	];

export interface IToolSchemaProbeResult {
	readonly tool: string;
	/** 该工具是否出现在本次请求的 tools 列表里（false = 被折叠或未启用）。 */
	readonly present: boolean;
	readonly descChars: number;
	/** label → 是否命中。skipped=true 表示该探针因配置条件不适用（如审批关闭），不计缺陷。 */
	readonly probes: ReadonlyArray<{ readonly label: string; readonly hit: boolean; readonly skipped?: boolean }>;
}

/**
 * 检查关键工具的 description 是否真的带着引导文案进入了本次请求。
 *
 * @param tools 本次请求实际发送的工具定义（executor 的 enabledTools）。
 * @param approvalEnabled 审批是否开启（tools.confirmToolCalls）。approvalShape 探针
 *   对应的 SHELL_APPROVAL_SHAPE_GUIDANCE 是**条件性下发**（审批关闭时整段不下发，
 *   见 compatibilityTools.shellApprovalGuidance）——关闭时该探针标 skipped，
 *   否则每 turn 假 warn（2026-09-05，日志 1788591795446）。
 */
export function probeToolGuidance(
	tools: ReadonlyArray<{ name?: string; description?: string }>,
	approvalEnabled = true,
): IToolSchemaProbeResult[] {
	const byName = new Map<string, string>();
	for (const t of tools) {
		if (t?.name) { byName.set(t.name, typeof t.description === 'string' ? t.description : ''); }
	}
	const wanted = [...new Set(TOOL_GUIDANCE_PROBES.map((p) => p.tool))];
	return wanted.map((tool) => {
		const desc = byName.get(tool);
		return {
			tool,
			present: desc !== undefined,
			descChars: desc?.length ?? 0,
			probes: TOOL_GUIDANCE_PROBES
				.filter((p) => p.tool === tool)
				.map((p) => {
					if (p.label === 'approvalShape' && !approvalEnabled) {
						return { label: p.label, hit: false, skipped: true };
					}
					return { label: p.label, hit: (desc ?? '').includes(p.probe) };
				}),
		};
	});
}

/**
 * 渲染 `[ToolSchemaDiag]` 日志。
 *
 * ⚠ 格式是**对外契约**（会被 grep）：首行以 `[ToolSchemaDiag]` 开头。
 * `level='warn'` 表示有工具在场但探针 miss —— 那是真正的缺陷（文案没进 schema）；
 * 工具不在场（被折叠）只是信息，用 info。
 */
export function formatToolSchemaDiagLog(
	results: ReadonlyArray<IToolSchemaProbeResult>,
	toolCount: number,
	schemaTokens: number,
): { readonly text: string; readonly level: 'info' | 'warn' } {
	const parts = results.map((r) => {
		if (!r.present) { return `${r.tool}: ABSENT(folded or disabled)`; }
		const probeStr = r.probes.map((p) => `${p.label}=${p.skipped ? 'OFF' : p.hit ? 'YES' : 'NO'}`).join(' ');
		return `${r.tool}: desc=${r.descChars}c ${probeStr}`;
	});
	// 只有「工具在场却探针 miss」才算缺陷：说明 description 组装丢了内容或被截断。
	// skipped（配置条件不适用，如审批关闭的 approvalShape）不算缺陷。
	const missing = results.some((r) => r.present && r.probes.some((p) => !p.hit && !p.skipped));
	const text = `[ToolSchemaDiag] tools=${toolCount} schemaTok=${schemaTokens} | ${parts.join(' | ')}`
		+ (missing ? '\n  ⚠ a guidance probe MISSED while the tool IS present → description assembly dropped or truncated it' : '');
	return { text, level: missing ? 'warn' : 'info' };
}
