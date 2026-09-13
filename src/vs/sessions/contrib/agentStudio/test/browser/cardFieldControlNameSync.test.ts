/*---------------------------------------------------------------------------------------------
 *  Unit test: 卡片字段 key ↔ 画布控件名 一致性守卫（2026-09-11 需求「卡片数据与画布节点 UI
 *  始终同步」的第一步 —— 产出「哪些字段不同名」的确定清单）。
 *
 *  为什么必须先做这步：双向同步的写路径是「按 key 写节点属性」——
 *  若交互 schema 的 key **不是**画布 widgets 里的控件名 → 写入**静默落空** ✗
 *  （最难查的一类 bug：界面无报错、数据不生效）。
 *
 *  真源：画布控件名 = `getNodeSpec(type).widgets[].name`（comfyHost/registry.ts）。
 *  ⚠ `grid-size` 的 `key` 本身是**虚拟的** —— 实际控件名是 `rowsKey` / `colsKey`（types.ts:31）。
 *
 *  本测试把当前的不一致项**固化成基线**：清单变化即失败 → 强制复核（同 build-failure-baseline 思路）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { NODE_CATALOG, catalogInteraction } from '../../browser/workflow/nodeCatalog.js';
import { getNodeSpec } from '../../webview/src/features/workflowEditor/comfyHost/registry.js';

/**
 * ★ 基线：当前已知「key 不在画布 widgets 里」的字段（形如 `节点类型 :: 字段kind :: key`）。
 * 新增/减少都会让本测试失败 → 强制复核是「该补映射」还是「该改 key」。
 *
 * 实测结论（2026-09-11，全仓库扫一遍）：**只有 1 处** ——
 *   `ComfyTV.StatEmojiStage :: image-ref :: comfytv_image_refs`
 * 原因：它是**节点属性（非 widget）**—— 静态表情包/ImagePicker 的参考图存在
 * `node.properties.comfytv_image_refs`（JSON 字符串），仍走同一条 `wf-node-control`
 * → `updateNodeData` 写入路径（画布 `properties` 即 store 的 `node.data`），
 * 只是**没登记在 `spec.widgets`** 里 ✗。
 * ⇒ 第二步实现时：该字段按**属性**写（同一写入口即可），守卫的「控件名」判据对它放宽。
 */
const EXPECTED_MISMATCHES: string[] = [
	'ComfyTV.StatEmojiStage :: image-ref :: comfytv_image_refs',
];

/** 交互 schema 的字段 → 它实际要写的画布控件名（可能是多个）。 */
function controlNamesOf(field: Record<string, unknown>): string[] {
	const key = String(field['key'] ?? '');
	if (!key) { return []; }
	if (field['kind'] === 'grid-size') {
		// 虚拟 key：真实控件名是 rowsKey / colsKey（缺省时按约定推导）
		const rows = typeof field['rowsKey'] === 'string' && field['rowsKey'] ? field['rowsKey'] : `${key}_rows`;
		const cols = typeof field['colsKey'] === 'string' && field['colsKey'] ? field['colsKey'] : `${key}_cols`;
		return [rows, cols];
	}
	return [key];
}

test('★★ 卡片字段 key ↔ 画布控件名 一致性清单（双向同步的前提）', () => {
	const mismatches: string[] = [];
	let checked = 0;
	for (const entry of NODE_CATALOG) {
		const type = String((entry as { type?: unknown }).type ?? '');
		if (!type) { continue; }
		const schema = catalogInteraction(type);
		if (!schema || !Array.isArray(schema.fields) || schema.fields.length === 0) { continue; }
		const spec = getNodeSpec(type);
		if (!spec) { continue; }   // 无 spec 的节点（非画布节点）不参与
		const widgetNames = new Set((spec.widgets ?? []).map(w => w.name));
		if (widgetNames.size === 0) { continue; }   // 无 widgets（编辑走弹窗）→ 不参与
		for (const f of schema.fields) {
			for (const name of controlNamesOf(f as unknown as Record<string, unknown>)) {
				checked++;
				if (!widgetNames.has(name)) {
					mismatches.push(`${type} :: ${String((f as { kind?: unknown }).kind ?? '?')} :: ${name}`);
				}
			}
		}
	}
	assert.ok(checked > 0, '应至少检查到一个卡片字段（否则守卫形同虚设）');
	assert.deepStrictEqual(
		mismatches,
		EXPECTED_MISMATCHES,
		`字段 key 与画布控件名不一致（同步会静默写错字段 ✗，需补映射或改 key）:\n${mismatches.join('\n')}`,
	);
});
