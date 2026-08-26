/*---------------------------------------------------------------------------------------------
 *  multiPanelStoryboard — 多宫格故事板数据契约（browser-local 纯函数）。
 *
 *  与 导演台编辑器（线性时间线分镜）不同，本节点是「网格宫格」布局：
 *  一个 gridCount（2/4/6/9）切成 N 个宫格，每格独立描述（角色/动作/对白/图像提示），
 *  最终由 qwen-image-2512 单图直出整张多宫格漫画（对齐 IMAGE_QWEN_2512_MULTI_PANEL）。
 *
 *  生成链路（run 时）：panels_state → buildMultiPanelPrompt() → runStageWorkflow
 *  （kind='image'，label='Qwen 2512 多宫格'，prefix {{grid_count}} 由模板注入）。
 *  全部纯函数，可单测。
 *--------------------------------------------------------------------------------------------*/

/** 单个宫格的内容。 */
export interface MultiPanelData {
	/** 0-based 宫格序号。 */
	index: number;
	/** 本格出场角色（跨格一致时集中到「角色：」前缀）。 */
	character: string;
	/** 画面动作描述。 */
	action: string;
	/** 台词（对白气泡）。 */
	dialogue: string;
	/** 完整图像提示（优先级高于 action+dialogue）。 */
	imagePrompt: string;
}

/** 多宫格故事板整体状态（JSON 序列化为 panels_state widget）。 */
export interface MultiPanelState {
	/** 宫格总数，取值 2/4/6/9。 */
	gridCount: number;
	panels: MultiPanelData[];
}

/** 允许的宫格数（对齐 qwen 单图直出的可靠上限）。 */
export const GRID_COUNT_OPTIONS: readonly number[] = [2, 4, 6, 9];

/** 宫格数 → 网格行列布局。 */
export function gridLayoutForCount(count: number): { cols: number; rows: number } {
	switch (count) {
		case 2: return { cols: 2, rows: 1 };
		case 4: return { cols: 2, rows: 2 };
		case 6: return { cols: 3, rows: 2 };
		case 9: return { cols: 3, rows: 3 };
		default: return { cols: 2, rows: 2 };
	}
}

function normalizeCount(count: unknown): number {
	const n = Number(count);
	return GRID_COUNT_OPTIONS.includes(n) ? n : 4;
}

/** 创建一个空白宫格状态。 */
export function createDefaultPanelsState(gridCount: number): MultiPanelState {
	const n = normalizeCount(gridCount);
	return {
		gridCount: n,
		panels: Array.from({ length: n }, (_, i) => ({
			index: i,
			character: '',
			action: '',
			dialogue: '',
			imagePrompt: '',
		})),
	};
}

/** 解析 panels_state JSON（防错：非法/截断 → 默认 4 宫格空白）。 */
export function parsePanelsState(json: string): MultiPanelState {
	if (!json) { return createDefaultPanelsState(4); }
	try {
		const raw = JSON.parse(json) as Partial<MultiPanelState>;
		const count = normalizeCount(raw?.gridCount);
		const rawPanels = Array.isArray(raw?.panels) ? raw.panels : [];
		const panels: MultiPanelData[] = Array.from({ length: count }, (_, i) => {
			const p = rawPanels[i] as Partial<MultiPanelData> | undefined;
			return {
				index: i,
				character: typeof p?.character === 'string' ? p.character : '',
				action: typeof p?.action === 'string' ? p.action : '',
				dialogue: typeof p?.dialogue === 'string' ? p.dialogue : '',
				imagePrompt: typeof p?.imagePrompt === 'string' ? p.imagePrompt : '',
			};
		});
		return { gridCount: count, panels };
	} catch {
		return createDefaultPanelsState(4);
	}
}

export function panelsStateToJson(state: MultiPanelState): string {
	return JSON.stringify(state);
}

/**
 * 把宫格状态拼成 qwen 多宫格 prompt 的「主体」（角色 + 每格内容）。
 * 「N宫格漫画」前缀与「一致性要求」后缀由模板 IMAGE_QWEN_2512_MULTI_PANEL 的
 * prefix/suffix 提供，这里只产 main_prompt 主体，避免重复。
 */
export function buildMultiPanelPrompt(state: MultiPanelState): string {
	const lines: string[] = [];
	// 角色：去重收集所有非空 character，作为跨格一致的前缀。
	const characters = [...new Set(state.panels.map(p => p.character.trim()).filter(Boolean))];
	if (characters.length) {
		lines.push(`角色：${characters.join('、')}。`);
	}
	for (const p of state.panels) {
		const parts: string[] = [];
		const img = p.imagePrompt.trim();
		if (img) {
			parts.push(img);
		} else {
			if (p.action.trim()) { parts.push(p.action.trim()); }
		}
		const dlg = p.dialogue.trim();
		if (dlg) { parts.push(`对白「${dlg}」`); }
		lines.push(`第${p.index + 1}格：${parts.join('，') || '（待补充画面）'}`);
	}
	return lines.join('\n');
}

/** 判断宫格内容是否全空（用于「有上游故事文本时自动拆分」的触发条件）。 */
export function isPanelsEmpty(state: MultiPanelState): boolean {
	return state.panels.every(p =>
		!p.character.trim() && !p.action.trim() && !p.dialogue.trim() && !p.imagePrompt.trim(),
	);
}

/**
 * 把故事文本启发式拆分成 N 宫格（每格一段描述，存 imagePrompt）。
 * 纯启发式（无需 LLM）：按换行/句末标点切句，均匀取样 N 句覆盖全文。
 * 句子不足 N 时前几格有内容、后面留空（用户可补）。
 */
export function splitStoryToPanels(text: string, gridCount: number): MultiPanelState {
	const n = normalizeCount(gridCount);
	const sentences = (text ?? '')
		.split(/[\r\n。！？!?；;]+/)
		.map(s => s.replace(/^[\s\-—·•*#>]+|[\s\-—·•*#]+$/g, '').trim())
		.filter(s => s.length > 0);
	const panels = Array.from({ length: n }, (_, i) => {
		let content = '';
		if (sentences.length >= n) {
			// 均匀取样 n 句覆盖全文（而非只取前 n 句，避免尾部情节丢失）。
			const idx = Math.min(sentences.length - 1, Math.floor(i * sentences.length / n));
			content = sentences[idx];
		} else if (i < sentences.length) {
			content = sentences[i];
		}
		return { index: i, character: '', action: '', dialogue: '', imagePrompt: content };
	});
	return { gridCount: n, panels };
}

export function isMultiPanelStoryboardNode(type: string): boolean {
	return type === 'ComfyTV.MultiPanelStoryboardStage';
}
