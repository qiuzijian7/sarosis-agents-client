/*---------------------------------------------------------------------------------------------
 *  stagePresets — stage **参数预设**（保存/套用一组控件值）。
 *
 *  移植自 ComfyTV `src/composables/stages/useStagePresets.ts`。
 *
 *  ## 与「动作预设」的区别（容易混淆，务必分清）
 *
 *  本项目已有的 `actionSpawn.IMAGE_VARIANT_PRESETS` 是**动作预设** —— 「换个风格
 *  再生成一张」，点了会 spawn 新节点。
 *
 *  本模块是**参数预设** —— 把当前节点的控件组合（angle=90 / crop=x,y,w,h /
 *  grade_state=…）命名保存下来，之后一键套回同类节点。两者互不相关。
 *
 *  ## 关键设计（照搬 ComfyTV）
 *
 *  1. **dirty tracking**：套用预设后，用户手动改了任一控件 → 选中态清空（显示
 *     「自定义」而不是继续显示预设名，否则会误导用户以为参数还是预设值）。
 *  2. **suppressDirty**：套用预设本身会触发控件变更，必须在套用期间抑制 dirty
 *     标记，否则刚套上就立刻变「自定义」。
 *  3. **跨卡片同步**：一个卡片保存了预设，其它同类卡片的下拉列表要能看到 ——
 *     用模块级 revision 计数 + 订阅通知。
 *
 *  存储：localStorage（按 nodeType 分组）。ComfyTV 走后端 API，本项目的 stage
 *  参数是纯前端状态，没必要引入后端往返。
 *--------------------------------------------------------------------------------------------*/

export interface StagePreset {
	id: string;
	name: string;
	/** 控件名 → 值。只存该 stage 关心的字段。 */
	values: Record<string, unknown>;
}

const NS = 'saros:stage:presets';

function storageKey(nodeType: string): string {
	return `${NS}:${nodeType}`;
}

// ── 跨卡片同步 ───────────────────────────────────────────────────────────
// 一个卡片保存/删除预设后，其它同类卡片必须重新读取列表。
let revision = 0;
const listeners = new Set<() => void>();

export function getPresetsRevision(): number {
	return revision;
}

export function subscribePresets(fn: () => void): () => void {
	listeners.add(fn);
	return () => { listeners.delete(fn); };
}

function bumpPresets(): void {
	revision++;
	for (const l of listeners) { l(); }
}

// ── CRUD（全部异常安全：localStorage 在部分嵌入环境不可用）──────────────

export function listStagePresets(nodeType: string | undefined): StagePreset[] {
	if (!nodeType) { return []; }
	try {
		const raw = globalThis.localStorage?.getItem(storageKey(nodeType));
		if (!raw) { return []; }
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) { return []; }
		// 结构校验：localStorage 内容可能被外部改写或来自旧版本。
		return parsed.filter((p): p is StagePreset =>
			!!p && typeof p === 'object'
			&& typeof (p as StagePreset).id === 'string'
			&& typeof (p as StagePreset).name === 'string'
			&& !!(p as StagePreset).values && typeof (p as StagePreset).values === 'object');
	} catch {
		return [];
	}
}

function writeAll(nodeType: string, presets: StagePreset[]): void {
	try {
		globalThis.localStorage?.setItem(storageKey(nodeType), JSON.stringify(presets));
		bumpPresets();
	} catch {
		// 写失败只是丢失预设，不该影响渲染。
	}
}

/** 保存预设。同名则覆盖（对齐 ComfyTV saveStagePreset 的 upsert 语义）。 */
export function saveStagePreset(nodeType: string, name: string, values: Record<string, unknown>): StagePreset {
	const trimmed = name.trim() || '未命名';
	const all = listStagePresets(nodeType);
	const existing = all.find(p => p.name === trimmed);
	const preset: StagePreset = existing
		? { ...existing, values: { ...values } }
		: { id: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, name: trimmed, values: { ...values } };
	const next = existing
		? all.map(p => (p.id === preset.id ? preset : p))
		: [...all, preset];
	writeAll(nodeType, next);
	return preset;
}

export function deleteStagePreset(nodeType: string, id: string): void {
	const all = listStagePresets(nodeType);
	const next = all.filter(p => p.id !== id);
	if (next.length !== all.length) { writeAll(nodeType, next); }
}

/**
 * 从当前控件值里挑出该 stage 需要持久化的字段。
 *
 * 只取「由内嵌编辑器接管的字段」（stageHiddenFields）+ 显式白名单 —— 避免把
 * `force_run_token` / `project_id` / `parent_output_id` 这类运行时字段写进预设
 * （它们每次运行都变，存下来毫无意义且会污染套用结果）。纯函数。
 */
export function pickPresetValues(
	values: Record<string, unknown>,
	fields: ReadonlySet<string>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of fields) {
		const v = values[k];
		if (v !== undefined) { out[k] = v; }
	}
	return out;
}

/** 运行时字段黑名单 —— 永不进入预设。 */
export const PRESET_EXCLUDED_FIELDS: ReadonlySet<string> = new Set([
	'force_run_token', 'project_id', 'parent_output_id', 'stage_uid', 'selected_index', 'directRef',
]);

/**
 * 判断当前值是否与预设一致（dirty tracking 的判据）。
 * 只比较预设里记录的键 —— 其它字段的变化不影响「是否还是这个预设」。纯函数。
 */
export function matchesPreset(values: Record<string, unknown>, preset: StagePreset): boolean {
	for (const [k, v] of Object.entries(preset.values)) {
		const cur = values[k];
		// 用 String 比较：控件值可能是 number/string 混用（INT 控件回读可能是字符串）。
		if (String(cur) !== String(v)) { return false; }
	}
	return true;
}

/** 在预设列表里找出与当前值匹配的那个（无匹配 = 「自定义」）。纯函数。 */
export function findMatchingPreset(
	values: Record<string, unknown>,
	presets: readonly StagePreset[],
): StagePreset | undefined {
	return presets.find(p => matchesPreset(values, p));
}
