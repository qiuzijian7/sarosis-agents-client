/* E2E tests for MultiPanelStoryboard (多宫格故事板).
 *
 * Verifies the full data pipeline (对齐 workflowRun.runMultiPanelStoryboardNode
 * 的运行时链路，全部纯函数、无 Comfy 依赖)：
 *
 *   故事文本 ──splitStoryToPanels──▶ MultiPanelState
 *     ──panelsStateToJson──▶ panels_state widget JSON（持久化）
 *     ──parsePanelsState──▶ 编辑器载入（非法数据防错回退）
 *     ──buildMultiPanelPrompt──▶ main_prompt
 *     ──模板 prefix/suffix + {{grid_count}} 插值──▶ 完整生成 prompt
 *
 * Sections:
 * 1. Module import sanity
 * 2. gridLayoutForCount — 宫格数 → 行列布局
 * 3. createDefaultPanelsState — 工厂与非法入参
 * 4. panels_state round-trip (toJson ↔ parse)
 * 5. parsePanelsState 防错（垃圾 JSON / gridCount 越界 / panels 缺失 / 截断补齐 / 类型纠偏）
 * 6. buildMultiPanelPrompt — imagePrompt 优先级、对白格式、角色去重、空格占位
 * 7. isPanelsEmpty — 自动拆分触发条件
 * 8. splitStoryToPanels — 启发式拆句（均匀取样覆盖全文 / 不足留空 / 标记剥离）
 * 9. 端到端：故事文本 → 拆分 → 序列化 → 解析 → prompt → 模板组装 → 最终 prompt 结构
 *
 * Run with: npx tsx test/multiPanelStoryboard.test.ts
 */

import {
	GRID_COUNT_OPTIONS, gridLayoutForCount, createDefaultPanelsState,
	parsePanelsState, panelsStateToJson, buildMultiPanelPrompt,
	isPanelsEmpty, splitStoryToPanels, isMultiPanelStoryboardNode,
	type MultiPanelState, type MultiPanelData,
} from '../src/features/workflowEditor/comfyHost/multiPanelStoryboard';

// ─── Test harness (同 directorConsole.test.ts 风格) ───────────────────────────

let passed = 0;
let failed = 0;

function eq<T>(actual: T, expected: T, label: string): void {
	if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; }
	else { failed++; console.error(`✗ ${label}\n   expected: ${JSON.stringify(expected)}\n   actual:   ${JSON.stringify(actual)}`); }
}

function ok(condition: boolean, label: string): void {
	if (condition) { passed++; }
	else { failed++; console.error(`✗ ${label}`); }
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. Module import sanity
// ══════════════════════════════════════════════════════════════════════════════

ok(typeof gridLayoutForCount === 'function', 'gridLayoutForCount imported OK');
ok(typeof createDefaultPanelsState === 'function', 'createDefaultPanelsState imported OK');
ok(typeof parsePanelsState === 'function', 'parsePanelsState imported OK');
ok(typeof panelsStateToJson === 'function', 'panelsStateToJson imported OK');
ok(typeof buildMultiPanelPrompt === 'function', 'buildMultiPanelPrompt imported OK');
ok(typeof isPanelsEmpty === 'function', 'isPanelsEmpty imported OK');
ok(typeof splitStoryToPanels === 'function', 'splitStoryToPanels imported OK');
ok(typeof isMultiPanelStoryboardNode === 'function', 'isMultiPanelStoryboardNode imported OK');
eq(GRID_COUNT_OPTIONS, [2, 4, 6, 9], 'GRID_COUNT_OPTIONS is [2,4,6,9]');

// ══════════════════════════════════════════════════════════════════════════════
// 2. gridLayoutForCount — 宫格数 → 行列布局
// ══════════════════════════════════════════════════════════════════════════════

eq(gridLayoutForCount(2), { cols: 2, rows: 1 }, '2 格 → 2×1');
eq(gridLayoutForCount(4), { cols: 2, rows: 2 }, '4 格 → 2×2');
eq(gridLayoutForCount(6), { cols: 3, rows: 2 }, '6 格 → 3×2');
eq(gridLayoutForCount(9), { cols: 3, rows: 3 }, '9 格 → 3×3');
// 非法值回退 2×2（与 normalizeCount 的默认 4 一致）
eq(gridLayoutForCount(5), { cols: 2, rows: 2 }, '非法 5 → 回退 2×2');
eq(gridLayoutForCount(0), { cols: 2, rows: 2 }, '0 → 回退 2×2');
eq(gridLayoutForCount(-1), { cols: 2, rows: 2 }, '负数 → 回退 2×2');

// ══════════════════════════════════════════════════════════════════════════════
// 3. createDefaultPanelsState — 工厂与非法入参
// ══════════════════════════════════════════════════════════════════════════════

const blank4 = createDefaultPanelsState(4);
eq(blank4.gridCount, 4, 'default state gridCount=4');
eq(blank4.panels.length, 4, 'default state has 4 panels');
eq(blank4.panels.map(p => p.index), [0, 1, 2, 3], 'panel index is 0-based sequential');
for (const p of blank4.panels) {
	eq([p.character, p.action, p.dialogue, p.imagePrompt], ['', '', '', ''], `panel ${p.index} fields all empty`);
}

// 非法 gridCount 回退默认 4
eq(createDefaultPanelsState(3).panels.length, 4, 'illegal gridCount 3 → fallback 4 panels');
eq(createDefaultPanelsState(16).gridCount, 4, 'illegal gridCount 16 → fallback 4');
eq(createDefaultPanelsState(NaN).gridCount, 4, 'NaN gridCount → fallback 4');
// 字符串数字可被 Number() 归一化
eq(createDefaultPanelsState('6' as unknown as number).gridCount, 6, "string '6' → 6");

// ══════════════════════════════════════════════════════════════════════════════
// 4. panels_state round-trip: state → JSON → parse
// ══════════════════════════════════════════════════════════════════════════════

const filledState: MultiPanelState = {
	gridCount: 6,
	panels: Array.from({ length: 6 }, (_, i): MultiPanelData => ({
		index: i,
		character: i === 0 ? '少年阿武' : '',
		action: `第${i + 1}格动作`,
		dialogue: i % 2 === 0 ? `台词${i + 1}` : '',
		imagePrompt: '',
	})),
};

const stateJson = panelsStateToJson(filledState);
ok(typeof stateJson === 'string' && stateJson.length > 0, 'panelsStateToJson produces non-empty string');
ok(stateJson.includes('"gridCount":6'), 'json contains gridCount');

const reparsed = parsePanelsState(stateJson);
eq(reparsed.gridCount, 6, 'round-trip preserves gridCount');
eq(reparsed.panels.length, 6, 'round-trip preserves panel count');
eq(reparsed.panels[0].character, '少年阿武', 'round-trip preserves panel 0 character');
eq(reparsed.panels[2].dialogue, '台词3', 'round-trip preserves panel 2 dialogue');
eq(reparsed.panels[5].action, '第6格动作', 'round-trip preserves panel 5 action');
// index 重编（不信任 json 里的 index，防止乱序/跳号）
eq(reparsed.panels.map(p => p.index), [0, 1, 2, 3, 4, 5], 'round-trip reindexes panels 0..N-1');

// ══════════════════════════════════════════════════════════════════════════════
// 5. parsePanelsState 防错 — 编辑器载入时的各种脏数据
// ══════════════════════════════════════════════════════════════════════════════

// 空串 → 默认 4 宫格空白
const emptyFallback = parsePanelsState('');
eq(emptyFallback.gridCount, 4, 'empty string → fallback 4-grid');
eq(emptyFallback.panels.length, 4, 'empty string → 4 empty panels');

// 垃圾 JSON → 默认 4 宫格空白
const garbage = parsePanelsState('not json at all');
eq(garbage.gridCount, 4, 'garbage json → fallback 4-grid');
ok(isPanelsEmpty(garbage), 'garbage json → panels empty');

// gridCount 越界 / 非法 → 回退 4
for (const bad of [5, 16, 0, -2, 'abc']) {
	const p = parsePanelsState(JSON.stringify({ gridCount: bad, panels: [] }));
	eq(p.gridCount, 4, `gridCount ${JSON.stringify(bad)} → fallback 4`);
}

// panels 缺失 → 全空白
const noPanels = parsePanelsState('{"gridCount":9}');
eq(noPanels.gridCount, 9, 'missing panels keeps gridCount');
eq(noPanels.panels.length, 9, 'missing panels → 9 empty panels');
ok(isPanelsEmpty(noPanels), 'missing panels → all empty');

// panels 不足 → 补空（旧数据扩容场景：2 宫格内容扩到 6）
const grew = parsePanelsState(JSON.stringify({
	gridCount: 6,
	panels: [
		{ index: 0, character: 'A', action: 'a1', dialogue: '', imagePrompt: '' },
		{ index: 1, character: '', action: 'a2', dialogue: 'd2', imagePrompt: '' },
	],
}));
eq(grew.panels.length, 6, 'panels shorter than gridCount → padded');
eq(grew.panels[0].action, 'a1', 'panel 0 content preserved after grow');
eq(grew.panels[1].dialogue, 'd2', 'panel 1 content preserved after grow');
ok(isPanelsEmpty({ gridCount: 6, panels: grew.panels.slice(2) }), 'grown panels 2..5 are empty');

// panels 超长 → 截断（缩容场景：9 宫格内容缩到 4）
const shrunk = parsePanelsState(JSON.stringify({
	gridCount: 4,
	panels: Array.from({ length: 9 }, (_, i) => ({ index: i, action: `act${i}` })),
}));
eq(shrunk.panels.length, 4, 'panels longer than gridCount → truncated');
eq(shrunk.panels.map(p => p.action), ['act0', 'act1', 'act2', 'act3'], 'truncation keeps first 4');

// 字段类型错误 → 纠偏为空串（不崩溃、不透传非字符串）
const weirdTypes = parsePanelsState(JSON.stringify({
	gridCount: 2,
	panels: [{ index: 0, character: 42, action: { nested: true }, dialogue: null, imagePrompt: ['x'] }],
}));
eq(weirdTypes.panels[0].character, '', 'non-string character → empty');
eq(weirdTypes.panels[0].action, '', 'object action → empty');
eq(weirdTypes.panels[0].dialogue, '', 'null dialogue → empty');
eq(weirdTypes.panels[0].imagePrompt, '', 'array imagePrompt → empty');

// ══════════════════════════════════════════════════════════════════════════════
// 6. buildMultiPanelPrompt — prompt 主体拼装规则
// ══════════════════════════════════════════════════════════════════════════════

// 6a. imagePrompt 优先于 action；对白以「对白「…」」追加
const priorityState: MultiPanelState = {
	gridCount: 2,
	panels: [
		{ index: 0, character: '', action: '被忽略的动作', dialogue: '', imagePrompt: '雨夜天台，少年撑伞' },
		{ index: 1, character: '', action: '奔跑', dialogue: '快跑！', imagePrompt: '' },
	],
};
const priorityPrompt = buildMultiPanelPrompt(priorityState);
ok(priorityPrompt.includes('第1格：雨夜天台，少年撑伞'), 'imagePrompt wins over action');
ok(!priorityPrompt.includes('被忽略的动作'), 'action dropped when imagePrompt present');
ok(priorityPrompt.includes('第2格：奔跑，对白「快跑！」'), 'action + dialogue joined with 「对白「…」」');

// 6b. 角色去重收集为首行前缀（跨格一致）
const charState: MultiPanelState = {
	gridCount: 3,
	panels: [
		{ index: 0, character: '阿武', action: '站立', dialogue: '', imagePrompt: '' },
		{ index: 1, character: '阿武', action: '回头', dialogue: '', imagePrompt: '' },
		{ index: 2, character: '小满', action: '招手', dialogue: '', imagePrompt: '' },
	],
};
const charPrompt = buildMultiPanelPrompt(charState);
ok(charPrompt.startsWith('角色：阿武、小满。'), 'characters deduped into prefix line');
eq(charPrompt.split('\n').length, 4, 'prefix line + one line per panel (3)');

// 6c. 全空格 → （待补充画面）占位
const blankPrompt = buildMultiPanelPrompt(blank4);
for (let i = 1; i <= 4; i++) {
	ok(blankPrompt.includes(`第${i}格：（待补充画面）`), `blank panel ${i} uses placeholder`);
}
ok(!blankPrompt.startsWith('角色：'), 'no character line when all characters empty');

// 6d. 空白字符 trim（前后空格不进 prompt）
const spaced: MultiPanelState = {
	gridCount: 2,
	panels: [
		{ index: 0, character: '  阿武  ', action: '  站立  ', dialogue: '  嗨  ', imagePrompt: '' },
		{ index: 1, character: '', action: '', dialogue: '', imagePrompt: '' },
	],
};
const trimmedPrompt = buildMultiPanelPrompt(spaced);
ok(trimmedPrompt.includes('角色：阿武。'), 'character trimmed before dedupe');
ok(trimmedPrompt.includes('第1格：站立，对白「嗨」'), 'action/dialogue trimmed');

// ══════════════════════════════════════════════════════════════════════════════
// 7. isPanelsEmpty — 「有上游故事文本时自动拆分」的触发条件
// ══════════════════════════════════════════════════════════════════════════════

ok(isPanelsEmpty(blank4), 'all-empty state → true');
ok(!isPanelsEmpty(filledState), 'filled state → false');
ok(!isPanelsEmpty({ gridCount: 4, panels: [...blank4.panels.slice(0, 3), { index: 3, character: '', action: 'x', dialogue: '', imagePrompt: '' }] }), 'one non-empty field → false');
// 空白字符不算内容
ok(isPanelsEmpty({ gridCount: 2, panels: [{ index: 0, character: ' ', action: '\t', dialogue: '\n', imagePrompt: ' ' }, { index: 1, character: '', action: '', dialogue: '', imagePrompt: '' }] }), 'whitespace-only fields count as empty');

// ══════════════════════════════════════════════════════════════════════════════
// 8. splitStoryToPanels — 故事文本启发式拆分
// ══════════════════════════════════════════════════════════════════════════════

// 8a. 多标点切句（。！？!?；; 与换行）
const story4 = '清晨，少年推开木门。中年人递来一张旧地图！地图上画着山脊小路；少年背起行囊出发。';
const split4 = splitStoryToPanels(story4, 4);
eq(split4.gridCount, 4, 'split keeps gridCount');
eq(split4.panels.length, 4, 'split produces 4 panels');
eq(split4.panels.map(p => p.imagePrompt), ['清晨，少年推开木门', '中年人递来一张旧地图', '地图上画着山脊小路', '少年背起行囊出发'], 'sentence punctuation stripped and split');
// 拆分结果每格内容存 imagePrompt（角色/动作/对白留空，用户可再补）
eq(split4.panels[0].character, '', 'split leaves character empty');
eq(split4.panels[0].dialogue, '', 'split leaves dialogue empty');

// 8b. ★ 均匀取样覆盖全文（句子多于宫格数时，不只取前 N 句——尾部情节不丢）
const tenSentences = Array.from({ length: 10 }, (_, i) => `情节${i + 1}`).join('。') + '。';
const split10to4 = splitStoryToPanels(tenSentences, 4);
// idx = floor(i * 10 / 4) → [0, 2, 5, 7]
eq(split10to4.panels.map(p => p.imagePrompt), ['情节1', '情节3', '情节6', '情节8'], 'uniform sampling picks idx [0,2,5,7] of 10 sentences');
ok(!split10to4.panels[3].imagePrompt.includes('情节10'), 'last panel is not simply the 4th sentence');

// 6 句 → 4 宫格：idx = floor(i*6/4) = [0,1,3,4]
const sixSentences = Array.from({ length: 6 }, (_, i) => `段${i + 1}`).join('！') + '！';
const split6to4 = splitStoryToPanels(sixSentences, 4);
eq(split6to4.panels.map(p => p.imagePrompt), ['段1', '段2', '段4', '段5'], 'uniform sampling idx [0,1,3,4] of 6 sentences');

// 8c. 句子不足 → 前几格有内容、后面留空（用户可补）
const split2to6 = splitStoryToPanels('开场画面。结束画面。', 6);
eq(split2to6.panels.length, 6, 'sentence-poor story still yields full grid');
eq(split2to6.panels[0].imagePrompt, '开场画面', 'sentence 0 → panel 0');
eq(split2to6.panels[1].imagePrompt, '结束画面', 'sentence 1 → panel 1');
eq(split2to6.panels[2].imagePrompt, '', 'panel 2 left empty for user');
eq(split2to6.panels[5].imagePrompt, '', 'panel 5 left empty for user');

// 8d. 行首/行尾标记剥离（markdown 符号）
const marked = '# 场景一\n- 场景二\n* 场景三\n> 场景四';
const splitMarked = splitStoryToPanels(marked, 4);
eq(splitMarked.panels.map(p => p.imagePrompt), ['场景一', '场景二', '场景三', '场景四'], 'leading #/-/*/> markers stripped');

// 8e. 空文本 → 全空面板
const splitEmpty = splitStoryToPanels('', 9);
eq(splitEmpty.gridCount, 9, 'empty text keeps gridCount');
ok(isPanelsEmpty(splitEmpty), 'empty text → all panels empty');
ok(isPanelsEmpty(splitStoryToPanels('。\n！\t。', 4)), 'punctuation-only text → all panels empty');

// ══════════════════════════════════════════════════════════════════════════════
// 9. 端到端：故事文本 → 拆分 → 序列化 → 解析 → prompt → 模板组装
//
// 复现 workflowRun.runMultiPanelStoryboardNode 的运行时链路：
//   panels_state（widget JSON）→ parse → buildMultiPanelPrompt（main_prompt）
//   → 模板 prefix("{{grid_count}}宫格漫画…") + main + suffix(一致性要求)
//   → 注入 IMAGE_QWEN_2512_MULTI_PANEL 节点 "5" 的 prompt
// prefix/suffix 与 imageWorkflows.ts 保持逐字一致（模板漂移时此节会失败）。
// ══════════════════════════════════════════════════════════════════════════════

const TEMPLATE_PREFIX = (n: number): string => `${n}宫格漫画，等宽白色边框，不要文字。\n\n`;
const TEMPLATE_SUFFIX = '\n\n一致性要求：所有宫格为同一角色、同一服装、同一光线，统一画面风格。';

// 9a. 全链路（6 宫格）
const e2eStory = '深夜，侦探推开档案室大门。灰尘在灯光下飞舞。他抽出一份泛黄的卷宗。卷宗里的照片与他手中的合影完全一致。侦探猛然抬头。窗外闪过一个黑影。';
const e2eSplit = splitStoryToPanels(e2eStory, 6);        // ① 故事 → 6 宫格
const e2eJson = panelsStateToJson(e2eSplit);             // ② 写回 panels_state widget
const e2eLoaded = parsePanelsState(e2eJson);             // ③ 运行时读取（或编辑器载入）
const e2eMain = buildMultiPanelPrompt(e2eLoaded);        // ④ main_prompt
const e2eFinal = TEMPLATE_PREFIX(6) + e2eMain + TEMPLATE_SUFFIX; // ⑤ 模板组装（{{grid_count}}=6）

ok(e2eFinal.startsWith('6宫格漫画，等宽白色边框，不要文字。'), 'final prompt starts with 6-grid prefix ({{grid_count}} interpolated)');
ok(e2eFinal.endsWith(TEMPLATE_SUFFIX), 'final prompt ends with consistency suffix');
ok(e2eFinal.includes('第1格：深夜，侦探推开档案室大门'), 'panel 1 content present');
ok(e2eFinal.includes('第6格：窗外闪过一个黑影'), 'panel 6 content present (tail story not lost)');
for (let i = 1; i <= 6; i++) {
	ok(e2eFinal.includes(`第${i}格：`), `final prompt contains panel ${i} line`);
}
// 6 句 → 6 格：每格非空
ok(!e2eFinal.includes('（待补充画面）'), 'no placeholder when sentences >= gridCount');
// main_prompt 行数 = 6（无角色行，splitStoryToPanels 不填角色）
eq(e2eMain.split('\n').length, 6, 'main prompt is exactly 6 lines (one per panel)');

// 9b. 带角色手填的端到端（4 宫格，编辑器填完再运行）
const manualState: MultiPanelState = {
	gridCount: 4,
	panels: [
		{ index: 0, character: '机械师老周', action: '在车间焊接机甲手臂', dialogue: '火花四溅', imagePrompt: '' },
		{ index: 1, character: '机械师老周', action: '举起成品手臂', dialogue: '', imagePrompt: '' },
		{ index: 2, character: '', action: '', dialogue: '', imagePrompt: '机甲手臂通电，蓝光亮起' },
		{ index: 3, character: '机械师老周', action: '戴上去试机', dialogue: '成了！', imagePrompt: '' },
	],
};
const manualJson = panelsStateToJson(manualState);
const manualLoaded = parsePanelsState(manualJson);
const manualFinal = TEMPLATE_PREFIX(4) + buildMultiPanelPrompt(manualLoaded) + TEMPLATE_SUFFIX;

ok(manualFinal.startsWith('4宫格漫画'), '4-grid prefix interpolated');
ok(manualFinal.includes('角色：机械师老周。'), 'character line present after round-trip');
ok(manualFinal.includes('第1格：在车间焊接机甲手臂，对白「火花四溅」'), 'panel 1 = action + dialogue');
ok(manualFinal.includes('第2格：举起成品手臂'), 'panel 2 action only (no trailing comma)');
ok(manualFinal.includes('第3格：机甲手臂通电，蓝光亮起'), 'panel 3 uses imagePrompt');
ok(manualFinal.includes('第4格：戴上去试机，对白「成了！」'), 'panel 4 action + dialogue');
ok(!manualFinal.includes('（待补充画面）'), 'no placeholder in fully filled grid');

// 9c. 拆分 → 直接序列化 → 再解析 → isPanelsEmpty 联动（自动拆分触发条件）
// 场景：上游有故事文本且面板全空时，run 前自动 splitStoryToPanels；拆过一次后不再触发
const autoState = createDefaultPanelsState(4);
ok(isPanelsEmpty(autoState), 'fresh state is empty (auto-split would trigger)');
const afterAuto = splitStoryToPanels('一段故事。两段故事。', 4);
ok(!isPanelsEmpty(parsePanelsState(panelsStateToJson(afterAuto))), 'after auto-split, state is no longer empty (no re-trigger)');

// ══════════════════════════════════════════════════════════════════════════════
// 10. Node type recognition
// ══════════════════════════════════════════════════════════════════════════════

ok(isMultiPanelStoryboardNode('ComfyTV.MultiPanelStoryboardStage'), 'recognizes multi-panel storyboard node');
ok(!isMultiPanelStoryboardNode('ComfyTV.StoryboardEditorStage'), 'rejects director-console node');
ok(!isMultiPanelStoryboardNode('ComfyTV.GridSplitStage'), 'rejects grid-split node');
ok(!isMultiPanelStoryboardNode(''), 'rejects empty type');

// ══════════════════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════════════════

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
