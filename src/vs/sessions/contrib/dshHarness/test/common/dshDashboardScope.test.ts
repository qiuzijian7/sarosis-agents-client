/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VsSaros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **两个 dashboard 的「数据口径」说明必须两侧都在**（README 5.115，报告 B 组）。
 *
 * 背景（本次查证的结论 ✓）：IDE 侧 Dashboard 与 dsh 侧 dashboard 页**本来就不是同一份数据** ——
 *
 *   · IDE 侧：`AgentStudioDashboardService` 的**本地聚合**（token 用量账本 / 指标快照 / 告警 ✓），
 *     另有 `<root>/dashboard/` 落盘 ✓；
 *   · dsh 侧：读 **dsh 自己的会话投影缓存** `<DSH_HOME>/storages/session_projcache/sessions/*.json`
 *     （checkpoint 落盘 ⇒ 可能比实时**略落后** ✓），只有会话遥测（turn / step / 耗时 / token / 子代理 / 待办）✓。
 *
 * ⇒ 同一个"会话数 / 用量"在两页**不必相同** ✓。这**不是 bug** ✓ —— 但用户会拿两页互相"对账" ✗ ⇒
 * 产品选择是**两侧都明说**（README 5.115 ✓）。这条守卫防的正是**沉默的半边** ✗：
 * 只改一侧的文案（或将来"顺手"删掉那句说明）⇒ 页面又回到"看起来矛盾但没人解释"的状态 ✓。
 *
 * ⚠ 它只断**文案存在且互相点名** ✓，不断措辞（措辞会变 ✓）；行为断言在探针里（`p3-09` 断 dsh 页 ✓）。
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

/** 从 cwd 往上找仓库根（同 `dshWorkflowWriteLock.test.ts` 的约定）。 */
function repoRoot(): string | undefined {
	let dir = path.resolve(process.cwd());
	for (let depth = 0; depth < 6; depth += 1) {
		if (fs.existsSync(path.join(dir, 'dsh-plugins')) && fs.existsSync(path.join(dir, 'src'))) { return dir; }
		const parent = path.dirname(dir);
		if (parent === dir) { break; }
		dir = parent;
	}
	return undefined;
}

suite('dshHarness / dashboard 数据口径（IDE 聚合 ⇄ dsh 投影缓存）', () => {

	test('★ 两侧都写明口径，且**互相点名**（防"只改了一侧、另一侧沉默" ✗）', function () {
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		const ideFile = path.join(root!, 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'browser', 'views', 'agentStudioDashboardView.ts');
		const dshFile = path.join(root!, 'dsh-plugins', 'vssaros-dashboard', 'lib', 'index.js');
		assert.ok(fs.existsSync(ideFile), `${ideFile} 不存在 ✗`);
		assert.ok(fs.existsSync(dshFile), `${dshFile} 不存在 ✗`);
		const ide = fs.readFileSync(ideFile, 'utf8');
		const dsh = fs.readFileSync(dshFile, 'utf8');

		// ① 口径说明**已从页面搬进规范文档**（2026-10-23 用户第二次要求「移除 口径 和 后面的文本」）
		//   ⇒ 断言跟着搬家：文档里必须有、且必须点名 IDE；页面上不许再出现（否则又是"删了又回来"）。
		const spec = fs.readFileSync(path.join(root!, 'doc', 'dashboard-widget-spec.html'), 'utf8');
		assert.ok(/口径/.test(spec), '规范文档少了口径说明 ✗（dsh 与 IDE 两侧数字不同就没人解释了）');
		assert.ok(/IDE/.test(spec), '规范文档的口径说明必须点名 IDE 那侧（不然读者不知道去哪儿找成本与告警 ✗）');
		assert.ok(!dsh.includes('data-vssaros-dashboard-scope'),
			'dsh 页又把口径说明加回页面了 ✗（用户明确要求移除；它应该在 doc/dashboard-widget-spec.html）');

		// ② IDE 侧：有那句说明，且点名 dsh 侧 ✓
		assert.ok(/数据口径/.test(ide), 'IDE 侧 Dashboard 少了口径说明 ✗（它是本地聚合，与 dsh 页不是同一份数据）');
		assert.ok(/dsh/.test(ide), 'IDE 侧的口径说明必须点名 dsh 侧 ✗');

		// ③ 两处都要说到"不必相同"这层意思（只写"数据来源"不够：真正的风险是**两个数字对不上** ✗）
		//   dsh 侧那句已搬进规范文档 ⇒ 断言也跟着去文档里找（页面只留标题）。
		assert.ok(/不必相同/.test(spec), '规范文档的口径说明要写清"两者数字不必相同" ✗');
		assert.ok(/不必相同/.test(ide), 'IDE 侧的口径说明要写清"两者数字不必相同" ✗');
	});
});
