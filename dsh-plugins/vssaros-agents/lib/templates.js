// @vssaros/dsh-agents — 审批模板（2026-10-16，P2；BotHarness Approval Template 的收窄版）。
//
// 语义：**命中模板的过闸工具不再每次问**（tools.js 的 pre-execute 闸先查它）。
// 收窄边界（逐条如实）：
//   ① 只覆盖**本包自己的**过闸工具（WRITE_TOOLS = agent_switch_persona / agent_stop）——
//      别的插件/官方工具的审批走 dsh 原生流，我们不代理、不拦截 ✗（也拦不到 ✓）；
//   ② 粒度 = **工具名级**（不按参数细分）：agent_stop 的参数每次不同，参数级匹配既脆又
//      容易伪装安全 ✗；要放宽就连参数一起看审批理由（批准即所见 ✓）再决定加不加；
//   ③ 存 `<数据根>/agent-approval-templates.json`——插件自己的配置面（与 kanban 写口同判据：
//      读体限尺寸 + JSON 校验 + 失败给可读原因 ✓）；
//   ④ 模板文件的读取**失败一律按"没有模板"**（宁可多问一次，也不能因配置坏了把闸关掉 ✗）。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataRootOf } from './store.js';
import { WRITE_TOOLS } from './tools.js';

/** 模板文件名（数据根下；不放进 agents/ 目录——那是身份面，不是配置面 ✓）。 */
const FILE_NAME = 'agent-approval-templates.json';

/** 读模板清单。缺文件/坏 JSON ⇒ 空清单（理由见头注释 ④）。 */
export async function readApprovalTemplates(config) {
	try {
		const text = await readFile(join(dataRootOf(config), FILE_NAME), 'utf8');
		const parsed = JSON.parse(text);
		const list = Array.isArray(parsed?.templates) ? parsed.templates : [];
		// 只认封闭集里的工具名（WRITE_TOOLS 改名后旧模板自动失效，而不是默默放宽到不相干的工具 ✓）
		return list.filter(t => t && WRITE_TOOLS.includes(t.tool));
	} catch {
		return [];
	}
}

/** 写模板清单（先建目录；写前 JSON 校验自己的产物——写坏的下一次读会静默清空 ✗）。 */
async function writeApprovalTemplates(config, templates) {
	const root = dataRootOf(config);
	await mkdir(root, { recursive: true });
	const text = JSON.stringify({ version: 1, templates }, null, 2);
	JSON.parse(text); // 自证：产物必须是自己读得回来的合法 JSON ✓
	await writeFile(join(root, FILE_NAME), text, 'utf8');
}

/** API/页面用：清单 + 可模板化的工具封闭集。 */
export async function listApprovalTemplates(config) {
	return { tools: [...WRITE_TOOLS], templates: await readApprovalTemplates(config) };
}

/** 加模板（幂等：已存在则只更新 note）。tool 不在封闭集 ⇒ 抛 400 语义的错误。 */
export async function addApprovalTemplate(config, input) {
	const tool = String(input?.tool ?? '').trim();
	if (!WRITE_TOOLS.includes(tool)) {
		throw Object.assign(new Error(`不支持给 ${tool || '(空)'} 建模板——审批模板只覆盖：${WRITE_TOOLS.join('、')}`), { httpStatus: 400 });
	}
	const note = String(input?.note ?? '').trim().slice(0, 200);
	const list = await readApprovalTemplates(config);
	const existing = list.find(t => t.tool === tool);
	if (existing) {
		existing.note = note || existing.note;
	} else {
		list.push({ tool, note, createdAt: Date.now() });
	}
	await writeApprovalTemplates(config, list);
	return list;
}

/** 删模板（幂等：不存在的当成功）。 */
export async function removeApprovalTemplate(config, input) {
	const tool = String(input?.tool ?? '').trim();
	const list = await readApprovalTemplates(config);
	const next = list.filter(t => t.tool !== tool);
	if (next.length !== list.length) {
		await writeApprovalTemplates(config, next);
	}
	return next;
}

/**
 * 闸谓词（tools.js 的 pre-execute 用）：`has(tool)` = 该工具有模板 ⇒ 自动放行。
 * 每次现读文件（模板变更频率极低，一次 readFile 远比"缓存失效算错"便宜 ✓）；
 * 读失败按"没有"（头注释 ④ ✓）。
 */
export function templateGate(config) {
	return {
		has: async tool => (await readApprovalTemplates(config)).some(t => t.tool === tool),
	};
}
