#!/usr/bin/env node
// check-team-workflow-ui.mjs ★ 「团队工作流」UI 已移除守卫（2026-11-09）
//
// 范围：只针对 SuperAgent 侧栏 `dev/src/client/team-plans.tsx` 里那个标题就叫「团队工作流」的
//   Section（含 TeamFlow 导入/导出表单、保存/运行按钮）及其 locale 文案。
//   **不是** `/x/workflow/` 工作台（那套是 vssaros-workflow，早就 hidden+offline 下线）。
//
// 为什么单独一道守卫：这个区块很容易被"顺手加回来"。它曾是 SuperAgent v2 P5 的交付物，
//   用户 2026-11-07 先移除了顶栏 `work` 页签，2026-11-09 再移除侧栏区块；
//   Host 侧的 `team/retrospective.workflows` / `team/workflows/:id/*` / `team/teamflow/*`
//   **必须保留**（组队匹配仍读已保存的工作流，删了会让 workflows.spec.ts 与组队链路断掉）。
//   ⇒ 守卫同时钉住「UI 不在」和「数据与适配器还在」两侧，防止误删或复活。
//
// 跑法：node dsh-plugins/check-team-workflow-ui.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = rel => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const problems = []
const ok = (label, condition, detail = '') => {
	if (condition) { console.log(`  ✓ ${label}`) }
	else { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); problems.push(label) }
}

const panel = read('dsh-plugins/vssaros-superagent/dev/src/client/team-plans.tsx')
const locales = read('dsh-plugins/vssaros-superagent/dev/src/client/locales.ts')
const bundle = read('dsh-plugins/vssaros-superagent/lib/client.js')
const host = read('dsh-plugins/vssaros-superagent/lib/index.js')
const spec = read('dsh-plugins/vssaros-superagent/dev/tests/panel-overview.spec.tsx')

console.log('check-team-workflow-ui：SuperAgent「团队工作流」UI 已移除')

// ① UI 真源：区块、testid、表单、保存/运行/导入导出动作都不该回来
{
	const forbidden = ['team-teamflow', 'team.workflows', 'team.wfSave', 'team.wfRun', 'team.tfExport', 'team.tfImport',
		'team/workflows/:id/save', 'team/workflows/:id/run', 'team/workflows/:id/teamflow', 'team/teamflow/import']
	const hits = forbidden.filter(k => panel.includes(k))
	ok('① 侧栏面板真源里没有团队工作流区块 / 动作', hits.length === 0, hits.join(','))
	ok('① 面板不再 import 表单控件或本地 state（它们只服务该区块）',
		!/import \{ useState \}|Input/.test(panel))
	ok('① TeamPlans 其余区块仍在（审批 / 步骤 / 技能待审 / 归档计划）',
		['needsYou', 'team.staffing', 'team.steps', 'team.distillPending', 'team.approval', 'team.archivedPlans']
			.every(k => panel.includes(k)))
}

// ② locale 文案：14 个键全部删掉，不留死文案
{
	const keys = ['team.wfRunSent', 'team.workflows', 'team.wfDraft', 'team.wfSave', 'team.wfRun', 'team.wfRuns', 'team.wfSteps',
		'team.tfWorkspace', 'team.tfWorkspaceHint', 'team.tfExport', 'team.tfImport', 'team.tfExported', 'team.tfExportedRef', 'team.tfImported']
	const left = keys.filter(k => locales.includes(`'${k}'`))
	ok('② 团队工作流 / TeamFlow 的 locale 文案已删除', left.length === 0, left.join(','))
}

// ③ 构建产物与真源同形（忘了 build 会让真机还留着旧 UI）
{
	ok('③ 运行 bundle 里也没有 TeamFlow 表单 / 区块标题',
		!bundle.includes('team-teamflow') && !bundle.includes('导出到 TeamFlow') && !bundle.includes('从 TeamFlow 导入'))
	ok('③ build --check 在根链里（保证产物不会悄悄回退）',
		read('package.json').includes('vssaros-superagent/dev/scripts/build.mjs --check'))
}

// ④ Host 侧数据 / 适配器必须保留（误删会让组队匹配与 workflows.spec.ts 断掉）
{
	// 带引号的完整路由字面量：只查裸 `includes('team/workflows/:id/save')` 会被
	//   `save_REMOVED` 这类前缀骗过 ⇒ 必须精确到路由表里的那一整条。
	const needed = ["'GET team/retrospective'", '"GET team/retrospective"',
		"'POST team/workflows/:id/save'", '"POST team/workflows/:id/save"',
		"'POST team/workflows/:id/run'", '"POST team/workflows/:id/run"',
		"'POST team/workflows/:id/teamflow'", '"POST team/workflows/:id/teamflow"',
		"'POST team/teamflow/import'", '"POST team/teamflow/import"']
	const groups = [
		["'GET team/retrospective'", '"GET team/retrospective"'],
		["'POST team/workflows/:id/save'", '"POST team/workflows/:id/save"'],
		["'POST team/workflows/:id/run'", '"POST team/workflows/:id/run"'],
		["'POST team/workflows/:id/teamflow'", '"POST team/workflows/:id/teamflow"'],
		["'POST team/teamflow/import'", '"POST team/teamflow/import"'],
	]
	const missing = groups.filter(g => !g.some(k => host.includes(k))).map(g => g[0])
	ok('④ Host 侧工作流数据与 TeamFlow 适配器仍在（只删 UI，不删能力）', missing.length === 0, missing.join(','))
	ok('④ dev/tests/workflows.spec.ts 仍在（Host 逻辑没有被连带删除）',
		read('dsh-plugins/vssaros-superagent/dev/tests/workflows.spec.ts').includes('workflows'))
}

// ⑤ 反向断言：React 测试真跑「即使 Host 返回 workflows，面板也不渲染」
{
	ok('⑤ panel-overview 有两条「UI 已移除」反向断言',
		/shows no team-workflow UI/.test(spec) && /shows no TeamFlow import\/export controls/.test(spec)
		&& /\[data-testid="team-teamflow"\]/.test(spec) && /not\.toContain\('团队工作流'\)/.test(spec))
	ok('⑤ 守卫已接入根链', read('package.json').includes('node dsh-plugins/check-team-workflow-ui.mjs'))
}

// ⑥ 反向突变（内存副本）：把 UI 片段塞回真源 ⇒ 判据必须变红
{
	const verdict = (src) => forbiddenHits(src) === 0
	const forbiddenHits = (src) => ['team-teamflow', 'team.workflows', 'team.tfExport'].filter(k => src.includes(k)).length
	ok('⑥ 反向突变基线全绿', verdict(panel))
	const revived = panel.replace('{waiting.length > 0 &&', '{workflows.length > 0 && <div data-testid="team-teamflow">{t(\'team.workflows\')}</div>}\n    {waiting.length > 0 &&')
	ok('⑥ 把「团队工作流」区块塞回真源 ⇒ 判据变红', revived !== panel && !verdict(revived))
}

console.log(problems.length ? `\n✗ check-team-workflow-ui：${problems.length} 项失败` : '\n✓ check-team-workflow-ui：全部通过')
process.exitCode = problems.length ? 1 : 0
