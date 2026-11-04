// dsh-teamflow-workbench — 包内自检：工作台模板 S15 静态断言 + P2 宿主 seam 契约。
//   跑法：node incubator/dsh-plugin-teamflow/workbench/test/run-teamflow-check.mjs
//
// 「伪 ctx 真跑 apply」比源码正则强：注册、审批闸、路由、服务注入都是真调出来的。
// 端到端阶段驱动用假 vssarosRuns + 本仓 vssaros-workitem 真源账本，不需要起 Host。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { apply, TOOL_NAMES, WRITE_TOOLS, createHost } from '../lib/index.js';
import { createWorkItemService } from '../../../../dsh-plugins/vssaros-workitem/lib/index.js';
import { QA_REWORK_LIMIT } from '../lib/core/host/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const walk = (dir, out = []) => {
	for (const name of fs.readdirSync(dir)) {
		const p = path.join(dir, name);
		if (fs.statSync(p).isDirectory()) walk(p, out);
		else if (name.endsWith('.js')) out.push(p);
	}
	return out;
};
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
	if (ok) { pass += 1; console.log('  ok   ' + name); }
	else { fail += 1; console.log('  FAIL ' + name + (detail ? '  — ' + String(detail).slice(0, 200) : '')); }
};

console.log('── 1) 包结构与工作台静态契约（S15）──');
const pkg = JSON.parse(read('package.json'));
check('包名', pkg.name === 'dsh-teamflow-workbench', pkg.name);
check('外部包不带 vssaros 清单块', pkg.vssaros === undefined);
check('注入自有宿主 @vssaros/dsh-workbenches', (pkg.dsh?.client?.inject || []).includes('@vssaros/dsh-workbenches'));
const patchField = pkg.dsh?.bundle?.patch;
check('清单带 dsh.bundle.patch', /cordis\.patch\.yml/.test(String(Array.isArray(patchField) ? patchField.join(',') : patchField)));
check('files 里含 cordis.patch.yml', (pkg.files || []).includes('cordis.patch.yml'));
check('cordis.patch.yml 有 insert 段', /-\s*insert:/.test(read('cordis.patch.yml')));
check('数据根走 dshHomePath（不写死 ~/.dsh）', /!!js dshHomePath\(/.test(read('cordis.patch.yml')));
const patchText = read('cordis.patch.yml');
check('allowTools 是显式数组且无通配符',
	/allowTools:\s*\[[^\]]*\]/.test(patchText) && !/allowTools[^\n]*\*/.test(patchText));
check('allowTools 默认空数组（fail-closed）', /allowTools:\s*\[\s*\]/.test(patchText));
check('入口不写 chunk: 字段', !/^\s*chunk\s*:/m.test(strip(read('lib/client.js'))));
const entryMtime = fs.statSync(path.join(ROOT, 'lib/client.js')).mtimeMs;
const chunkMtime = Math.max(...['lib/client.teamflow.js', 'lib/client.teamflow.ui.js', 'lib/client.teamflow.teams.js'].map((f) => fs.statSync(path.join(ROOT, f)).mtimeMs));
check('客户端入口不比子块旧（?rev 缓存纪律）', entryMtime >= chunkMtime,
	`入口 ${new Date(entryMtime).toISOString()} / 子块 ${new Date(chunkMtime).toISOString()}`);
{
	const teamsSrc = strip(read('lib/client.teamflow.teams.js'));
	const bareT = teamsSrc.split('\n').filter((l) => !l.includes('var(--') && (/(?<![&\w])#[0-9a-fA-F]{3,8}\b/.test(l) || /\b(rgba?|hsla?)\(/.test(l)));
	check('团队配置子块：无裸色值 + @container + 声明 chunk', bareT.length === 0 && /@container/.test(teamsSrc) && /chunk:\s*'client\.teamflow\.teams\.js'/.test(teamsSrc),
		bareT.slice(0, 2).join(' | '));
}
const component = walk(path.join(ROOT, 'lib')).map((p) => ({ p, text: strip(fs.readFileSync(p, 'utf8')) }))
	.filter((x) => /desktopWorkbenches\.register\(/.test(x.text))
	.sort((a, b) => (b.text.match(/\bwb-[a-z-]+/g) || []).length - (a.text.match(/\bwb-[a-z-]+/g) || []).length)[0];
check('找到工作台组件（含 register）', !!component, component?.p.split(/[\\/]/).pop());
const src = component ? component.text : '';
check('描述符带 package（local:<包名> 身份来源）', src.includes("package: 'dsh-teamflow-workbench'"));
check('描述符不写 repository', !/^\s*repository\s*:/m.test(src));
check('根节点有 data-vssaros-surface="workbench"', /data-vssaros-surface['"]?\s*:\s*['"]workbench/.test(src));
check('工具条锚点恰好 1 个', (src.match(/data-dsh-workbench-toolbar/g) || []).length === 1);
const wbClasses = new Set(src.match(/\bwb(?:-[a-z0-9]+)*\b/g) || []);
check('用到 ≥10 个 wb-* 原语', wbClasses.size >= 10, wbClasses.size + ' 个');
const bare = src.split('\n').filter((l) => !l.includes('var(--') && (/(?<![&\w])#[0-9a-fA-F]{3,8}\b/.test(l) || /\b(rgba?|hsla?)\(/.test(l)));
check('无裸色值', bare.length === 0, bare.slice(0, 2).join(' | '));
check('有 @container（窄栏重排）', /@container/.test(src));
check('≥3 个 data-* 锚点', new Set(src.match(/data-[a-z0-9-]{3,30}/g) || []).size >= 3);
check('零 iframe', !/<iframe|createElement\(['"]iframe/.test(src));

console.log('── 2) 伪 ctx 真跑 apply ──');
const scratch = mkdtempSync(path.join(tmpdir(), 'tf-p2-check-'));
const workItems = createWorkItemService();

function makeRuns(qaDefects = false, blankPhase = '') {
	const calls = [];
	const cancels = [];
	const run = async ({ sessionId }) => {
		calls.push(sessionId);
		if (blankPhase && sessionId.endsWith(`-${blankPhase}`)) return { finalText: '' };
		const ev = '[Verification evidence]\n- cmd: node --check lib/index.js → exit 0, 12/12 passed';
		if (sessionId.endsWith('-verify')) return { finalText: `${ev}\n验收结论：✅ 通过` };
		if (sessionId.endsWith('-acceptance')) return { finalText: `验收结论：✅ 通过\n${ev}` };
		if (sessionId.endsWith('-qa')) {
			if (!qaDefects) return { finalText: `${ev}\n无缺陷` };
			return { finalText: `${ev}\n| 编号 | 严重级(P0/P1/P2/P3) | 模块 | 检测命令 | 通过判据 |\n|---|---|---|---|---|\n| D-1 | P0 | 设置页 | node check.mjs | exit 0 |` };
		}
		return { finalText: `阶段产物完成\n${ev}` };
	};
	return {
		calls, cancels, run,
		cancel: async ({ sessionId }) => { cancels.push(sessionId); return { cancelled: true }; },
	};
}

function fakeCtx(services) {
	const tools = new Map();
	const hooks = [];
	const routes = [];
	const ctx = {
		effect: (fn) => fn(),
		on: (event, handler) => { hooks.push({ event, handler }); return () => {}; },
		tools: { register: (def) => { tools.set(def.name, def); return () => tools.delete(def.name); } },
		inject: (names, fn) => {
			const scope = { effect: ctx.effect };
			for (const n of names) if (n in services) scope[n] = services[n];
			return fn(scope);
		},
	};
	return { ctx, tools, hooks, routes };
}

function additionalPropertiesAreBoolean(node, found = []) {
	if (!node || typeof node !== 'object') return found;
	for (const [k, v] of Object.entries(node)) {
		if (k === 'additionalProperties') found.push(typeof v === 'boolean');
		if (v && typeof v === 'object') additionalPropertiesAreBoolean(v, found);
	}
	return found;
}

const runs = makeRuns(false);
const services = {
	vssarosRuns: runs,
	vssarosWorkItems: workItems,
	webServer: { register: (r) => { probe.routes.push(r); return () => {}; } },
	connection: { requestRejection: () => null },
};
let probe;
probe = fakeCtx(services);
apply(probe.ctx, { root: path.join(scratch, 'data-apply'), cwd: scratch, allowTools: [], timeoutMs: 600000 });

check('13 个 teamflow_* 工具全部注册', probe.tools.size === 13, [...probe.tools.keys()].join(','));
check('TOOL_NAMES 与注册集合一致', TOOL_NAMES.length === 13 && TOOL_NAMES.every((n) => probe.tools.has(n)));
check('teamflow_teams 是只读工具（不进审批闸）', probe.tools.has('teamflow_teams') && !WRITE_TOOLS.includes('teamflow_teams'));
check('agent/created 钩子已注册（补发挂起的团队上下文）', probe.hooks.some((x) => x.event === 'agent/created'));
for (const [name, def] of probe.tools) {
	check(`${name} output.render 是函数`, typeof def.output?.render === 'function');
	check(`${name} output.schema 是对象`, !!def.output?.schema && typeof def.output.schema === 'object');
	const flags = additionalPropertiesAreBoolean(def.parameters).concat(additionalPropertiesAreBoolean(def.output?.schema));
	check(`${name} additionalProperties 只用布尔`, flags.every(Boolean));
}
const gate = probe.hooks.find((h) => h.event === 'tools/pre-execute');
check('写工具审批闸已注册', !!gate);
const asked = gate?.handler({ name: 'teamflow_start' }, () => 'next');
check('teamflow_start 触发 {kind:ask}', asked && asked.kind === 'ask');
check('teamflow_status 只读放行', gate?.handler({ name: 'teamflow_status' }, () => 'next') === 'next');
check('WRITE_TOOLS 覆盖所有写工具', WRITE_TOOLS.includes('teamflow_start') && WRITE_TOOLS.includes('teamflow_merge'));
const route = probe.routes.find((r) => r.kind === 'prefix' && r.path === '/x/teamflow');
check('/x/teamflow 前缀路由已注册', !!route && typeof route.handler === 'function');

console.log('── 3) 端到端阶段驱动（假 runs + 真账本）──');
const host = createHost(
	{ root: path.join(scratch, 'data-run'), cwd: scratch, allowTools: [], timeoutMs: 600000 },
	{ runs: makeRuns(false), workItems },
);
const started = host.controller.start('给设置页加暗色切换并补测试', { cwd: scratch });
await host.controller.pending();
const st = host.controller.status(started.runId);
check('start 返回 runId / 阶段集 / 工作目录', !!started.runId && started.stages.length > 0 && started.cwd === scratch);
check('全部阶段完成', st.status === 'completed' && st.stages.every((s) => s.status === 'done'), st.status);
const acceptance = st.stages.find((s) => s.phase === 'acceptance');
check('验收阶段有独立 verifier 结论', !!acceptance?.independent && acceptance.independent.selfReported === false);
check('verifier 会话与 worker 不同', acceptance?.independent?.sessionId?.endsWith('-verify') && acceptance.independent.sessionId !== acceptance.sessionId);
check('verifier 真的被跑过', host.deps.runs.calls.includes(acceptance?.independent?.sessionId));
check('阶段会话 id 都是 tf- 前缀', host.deps.runs.calls.every((s) => s.startsWith('tf-')));
check('journal 落盘', fs.existsSync(host.store.journalFile(started.runId)));
check('账本落盘（复用 workitem 真源）', fs.existsSync(path.join(scratch, 'data-run', 'ledger.json')));
const ledger = host.store.readLedger();
check('账本里 done 条目与阶段数一致', Object.values(ledger?.items || {}).filter((e) => e.status === 'done').length === st.stages.length);

console.log('── 4) QA 回环上限 / 人工闸 ──');
const host2 = createHost(
	{ root: path.join(scratch, 'data-rework'), cwd: scratch, allowTools: [], timeoutMs: 600000 },
	{ runs: makeRuns(true), workItems },
);
const s2 = host2.controller.start('持续有缺陷的需求', { cwd: scratch });
await host2.controller.pending();
const st2 = host2.controller.status(s2.runId);
check('打回复验轮数不超上限', st2.reworkRounds === QA_REWORK_LIMIT, `${st2.reworkRounds}/${QA_REWORK_LIMIT}`);
check('超限停线转 needs-human', st2.status === 'needs-human' && String(st2.needsHuman?.reason).includes('超过'));
check('停线后没有继续跑新阶段', st2.stages.filter((s) => s.phase === 'qa').length <= QA_REWORK_LIMIT + 1);
check('answer 能放行人工闸', host2.controller.answer(s2.runId, '已修，继续').ok === true);
await host2.controller.pending();
check('merge 明确拒绝自动提交', host2.controller.merge(s2.runId).ok === false);

console.log('── 5) 分诊 / 取消 / 续跑 ──');
check('确定性分诊：修个错别字 → full', host.controller.triage('修个错别字', {}).mode === 'full');
check('确定性分诊：做个页面 → lite', host.controller.triage('做个页面', {}).mode === 'lite');
const host3 = createHost(
	{ root: path.join(scratch, 'data-cancel'), cwd: scratch, allowTools: [], timeoutMs: 600000 },
	{ runs: makeRuns(false), workItems },
);
const s3 = host3.controller.start('取消测试', { cwd: scratch });
const cancelled = host3.controller.cancel(s3.runId);
await host3.controller.pending();
check('cancel 置 cancelled 并尽力取消会话', cancelled.ok === true && cancelled.status === 'cancelled');
const resumed = host3.controller.resume(s3.runId);
await host3.controller.pending();
check('resume 从断点续跑', resumed.ok === true && resumed.resumed === true);
check('pause/resume_session 是会话级开关', host3.controller.pause('s1').paused.includes('s1')
	&& !host3.controller.resumeSession('s1').paused.includes('s1'));

console.log('── 6) 真机续跑暴露的两个回归 ──');
const roRoot = path.join(scratch, 'data-readonly');
const roCfg = { root: roRoot, cwd: scratch, allowTools: [], timeoutMs: 600000 };
const host4 = createHost(roCfg, { runs: makeRuns(false), workItems });
host4.store.saveJournal({
	id: 'tf-readonly-probe', name: 'teamflow-pipeline', status: 'running', requirement: '纯读探针',
	stages: [{ seq: 1, phase: 'prd', status: 'running' }], startedAt: Date.now(), reworkRounds: 0,
});
const beforeList = fs.readFileSync(host4.store.journalFile('tf-readonly-probe'), 'utf8');
host4.controller.list();
host4.controller.list();
const afterList = fs.readFileSync(host4.store.journalFile('tf-readonly-probe'), 'utf8');
check('list() 不改写运行中的 journal（无崩溃归正竞态）', beforeList === afterList);
const host4b = createHost(roCfg, { runs: makeRuns(false), workItems });
const bootRecovered = host4b.store.readJson(host4b.store.journalFile('tf-readonly-probe'), null);
check('插件加载时归正残留 running 一次', bootRecovered?.status === 'interrupted'
	&& bootRecovered.stages?.[0]?.status === 'interrupted');
const host5 = createHost(
	{ root: path.join(scratch, 'data-failstop'), cwd: scratch, allowTools: [], timeoutMs: 600000 },
	{ runs: makeRuns(false, 'dev'), workItems },
);
const s5 = host5.controller.start('修个错别字', { cwd: scratch });
await host5.controller.pending();
const st5 = host5.controller.status(s5.runId);
check('非 QA 阶段失败立即停线转 needs-human', st5.status === 'needs-human'
	&& st5.needsHuman?.stage === 'dev' && String(st5.needsHuman?.reason).includes('失败'));
check('停线后不再跑 qa/acceptance/verifier',
	!host5.deps.runs.calls.some((c) => /-(qa|acceptance|verify)$/.test(c)));

console.log('── 7) 重跑不残留上一轮结果（dev.outcome）──');
let blank6 = true;
const runs6 = {
	calls: [],
	async run({ sessionId }) {
		this.calls.push(sessionId);
		if (blank6 && sessionId.endsWith('-dev')) return { finalText: '' };
		const ev = '[Verification evidence]\n- cmd: node --check lib/index.js → exit 0, 12/12 passed';
		if (sessionId.endsWith('-verify')) return { finalText: `${ev}\n验收结论：✅ 通过` };
		if (sessionId.endsWith('-acceptance')) return { finalText: `验收结论：✅ 通过\n${ev}` };
		return { finalText: `阶段产物完成\n${ev}` };
	},
	async cancel() { return { cancelled: true }; },
};
const host6 = createHost(
	{ root: path.join(scratch, 'data-outcome'), cwd: scratch, allowTools: [], timeoutMs: 600000 },
	{ runs: runs6, workItems },
);
const s6 = host6.controller.start('修个错别字', { cwd: scratch });
await host6.controller.pending();
// status() 是投影视图（不含 outcome/childId/endedAt），残留发生在落盘 journal 上，
// 所以断言必须读 store，不能用 status() 的 stages。
const jf6 = host6.store.journalFile(s6.runId);
const dev6a = host6.store.readJson(jf6, null).stages.find((x) => x.phase === 'dev');
check('失败回合写出 outcome（复现残留前提）', dev6a?.status === 'failed' && /空回复/.test(String(dev6a?.outcome)));
blank6 = false;
host6.controller.resume(s6.runId);
await host6.controller.pending();
const dev6b = host6.store.readJson(jf6, null).stages.find((x) => x.phase === 'dev');
check('resume 重跑成功：dev done 且 outcome 不残留', dev6b?.status === 'done' && !dev6b.outcome);
check('resume 重跑成功：evidence/会话时间重新生成', !!dev6b.evidence && !!dev6b.childId && !!dev6b.endedAt);
const st6 = host6.controller.status(s6.runId);
const api6 = st6.stages.find((x) => x.phase === 'dev');
check('status() 投影里 dev 为 done 且带本轮 evidence', api6?.status === 'done' && !!api6.evidence);

console.log('── 8) 上游同形数据面（views / board / RPC 信封）──');
let qaCalls8 = 0;
const runs8 = {
	calls: [],
	async run({ sessionId }) {
		this.calls.push(sessionId);
		const ev = '[Verification evidence]\n- cmd: node --check lib/index.js → exit 0, 12/12 passed';
		if (sessionId.endsWith('-verify')) return { finalText: `${ev}\n验收结论：✅ 通过` };
		if (sessionId.endsWith('-acceptance')) return { finalText: `验收结论：✅ 通过\n${ev}` };
		if (sessionId.endsWith('-qa')) {
			qaCalls8 += 1;
			if (qaCalls8 > 1) return { finalText: `${ev}\n无缺陷` };
			return { finalText: `${ev}\n| 编号 | 严重级(P0/P1/P2/P3) | 模块 | 检测命令 | 通过判据 |\n|---|---|---|---|---|\n| D-1 | P1 | 设置页 | node check.mjs | exit 0 |` };
		}
		return { finalText: `阶段产物完成\n${ev}` };
	},
	async cancel() { return { cancelled: true }; },
};
const host8 = createHost(
	{ root: path.join(scratch, 'data-views'), cwd: scratch, allowTools: [], timeoutMs: 600000 },
	{ runs: runs8, workItems },
);
const s8 = host8.controller.start('修个错别字', { cwd: scratch, sessionId: 'sess-A' });
await host8.controller.pending();
const V = host8.views;
const scope8 = { sessionId: 'sess-A', cwd: scratch };
const lst8 = V.call('list', ['sess-A'], scope8);
check('list：信封 + runBrief 形状 + 工作区', lst8.ok && lst8.value.runs[0]?.id === s8.runId
	&& 'incompleteStages' in lst8.value.runs[0] && lst8.value.workspace.path === scratch, JSON.stringify(lst8).slice(0, 160));
check('作用域：别的目录看不到这条 run', V.call('list', [], { cwd: path.join(scratch, 'other') }).value.runs.length === 0);
check('作用域：无 cwd 时按发起会话推断', V.call('list', ['sess-A'], { sessionId: 'sess-A' }).value.runs.length === 1);
const snap8 = V.call('snapshot', [s8.runId, 'sess-A'], scope8).value;
check('run 跑完且走过一轮 QA 打回', snap8?.status === 'completed' && snap8.stages.filter((s) => s.label.includes('QA 缺陷修复')).length === 1, snap8?.status);
check('snapshot：qaFix 投影为 dev + 上游修复轮标签', snap8.stages.some((s) => s.phase === 'dev' && s.label === 'QA 缺陷修复（第 1 轮）')
	&& !snap8.stages.some((s) => s.phase === 'qaFix'));
check('snapshot：合成运行日志（阶段起止 + 独立验收）', snap8.logs.some((l) => l.message.startsWith('▶')) && snap8.logs.some((l) => l.message.startsWith('◆ 独立验收')));
const accSeq8 = snap8.stages.find((s) => s.phase === 'acceptance').seq;
const accDet8 = V.call('stageDetail', [s8.runId, accSeq8, 'sess-A'], scope8).value;
check('验收阶段详情并排独立验收者证据', /独立验收（会话 tf-.*-verify，结论 accepted，selfReported=false）/.test(accDet8.verifyEvidence) && accDet8.ownerSession === null,
	accDet8 && accDet8.verifyEvidence);
const qaSeq8 = snap8.stages.find((s) => s.phase === 'qa').seq;
const qaDet8 = V.call('stageDetail', [s8.runId, qaSeq8, 'sess-A'], scope8).value;
check('QA 复验轮次聚合为 attempts 时间线', Array.isArray(qaDet8.attempts) && qaDet8.attempts.length === 2
	&& qaDet8.attempts[0].status === 'failed' && qaDet8.attempts[1].status === 'done');
const bl8 = V.call('backlog', ['sess-A'], scope8).value;
check('看板三泳道都有卡', bl8.requirements.length === 1 && bl8.tasks.length === 2 && bl8.bugs.length === 1,
	`${bl8.requirements.length}/${bl8.tasks.length}/${bl8.bugs.length}`);
check('派生状态：需求已验收 / 任务已验收 / 缺陷已验证', bl8.requirements[0].status === 'accepted'
	&& bl8.tasks.every((t) => t.status === 'accepted') && bl8.bugs[0].status === 'verified',
	`${bl8.requirements[0].status} ${bl8.tasks.map((t) => t.status)} ${bl8.bugs[0].status}`);
check('卡片带 runId（跳流水线）', bl8.requirements[0].runId === s8.runId && bl8.tasks[0].runId === s8.runId);
const bugId8 = bl8.bugs[0].id;
const tr8 = V.call('backlogUpdate', ['bug', bugId8, 'reopened', 'sess-A', '人工复核'], scope8).value;
check('人工流转合法状态', tr8.ok === true && tr8.item.status === 'reopened');
check('非法状态被拒', V.call('backlogUpdate', ['bug', bugId8, 'accepted', 'sess-A', ''], scope8).value.ok === false);
const j8 = host8.store.readJson(host8.store.journalFile(s8.runId), null);
host8.board.sync(j8);
check('再次派生不冲掉人工流转', host8.board.find('bug', bugId8).status === 'reopened');
const reqDet8 = V.call('itemDetail', ['req', bl8.requirements[0].id, 'sess-A'], scope8).value;
check('需求详情：子任务 + 缺陷 + runInfo + 流转时间线', reqDet8.subtasks.length === 2 && reqDet8.bugs.length === 1
	&& reqDet8.runInfo?.runId === s8.runId && reqDet8.events.length >= 2);
const bugDet8 = V.call('itemDetail', ['bug', bugId8], scope8).value;
check('缺陷详情带可执行定义（检测命令/通过判据）', bugDet8.defectCheck === 'node check.mjs' && bugDet8.defectCriterion === 'exit 0' && bugDet8.severity === 'P1');
const prods8 = V.call('products', [null], scope8).value;
check('产品线清单：按工作目录分组，默认选中当前会话目录', prods8.current === prods8.products[0]?.key && prods8.products[0].totalRuns === 1
	&& prods8.products[0].title === path.basename(scratch));
const pv8 = V.call('productView', [prods8.current], {}).value;
check('产品线视图一次取全（元信息 + backlog + runs）', pv8.product.key === prods8.current && pv8.runs.length === 1 && pv8.backlog.bugs.length === 1
	&& pv8.product.lastVerdict === 'accepted');
check('产品线级 run/阶段详情同形', V.call('productRunDetail', [prods8.current, s8.runId], {}).value?.id === s8.runId
	&& V.call('productStageDetail', [prods8.current, s8.runId, accSeq8], {}).value?.phase === 'acceptance');
check('已结束 run 的中断请求如实返回 ok:false', V.call('cancel', [s8.runId], {}).value.ok === false);
check('未知方法返回错误信封', V.call('nope', [], {}).ok === false);
check('升级探测如实「查不到」，不伪造已是最新', V.call('updateStatus', [false], {}).value.error === 'registry-unreachable');
check('teamflow_start 记录发起会话 ownerSession', j8.ownerSession === 'sess-A' && typeof j8.reqId === 'string');

console.log('── 10) 团队配置（定义 / 会话团队 / 注入 / 对流水线的真实影响）──');
const prompts10 = [];
const runs10 = {
	calls: [],
	async run({ sessionId, prompt }) {
		this.calls.push(sessionId);
		prompts10.push({ sessionId, prompt });
		const ev = '[Verification evidence]\n- cmd: node --check lib/index.js → exit 0, 3/3 passed';
		if (sessionId.endsWith('-verify')) return { finalText: `${ev}\n验收结论：✅ 通过` };
		if (sessionId.endsWith('-acceptance')) return { finalText: `验收结论：✅ 通过\n${ev}` };
		if (sessionId.endsWith('-qa')) return { finalText: `${ev}\n无缺陷` };
		return { finalText: `阶段产物完成\n${ev}` };
	},
	async cancel() { return { cancelled: true }; },
};
const injected10 = [];
const agents10 = new Map();
const host10 = createHost(
	{ root: path.join(scratch, 'data-teams'), cwd: scratch, allowTools: [], timeoutMs: 600000 },
	{ runs: runs10, workItems, agents: () => ({ get: (id) => agents10.get(id) }) },
);
const T10 = host10.teams;
check('内置团队 3 个且都含 dev + acceptance', T10.all().teams.filter((x) => x.builtin).length === 3
	&& T10.all().teams.every((x) => ['dev', 'acceptance'].every((k) => x.stages.some((s) => s.key === k))));
check('校验：缺 acceptance 被拒（团队不能绕过独立验收）', T10.save({ name: '偷懒队', stages: [{ key: 'dev' }] }).ok === false);
check('校验：未知阶段 / 非法 id / 空名称被拒', T10.save({ name: 'x', stages: [{ key: 'deploy' }, { key: 'dev' }, { key: 'acceptance' }] }).ok === false
	&& T10.save({ id: 'Bad ID', name: 'x', stages: [{ key: 'dev' }, { key: 'acceptance' }] }).ok === false
	&& T10.save({ name: ' ', stages: [{ key: 'dev' }, { key: 'acceptance' }] }).ok === false);
check('内置团队只读、不可删', T10.save({ id: 'dev', name: '改内置', stages: [{ key: 'dev' }, { key: 'acceptance' }] }).ok === false && T10.remove('dev').ok === false);
const saved10 = T10.save({
	id: 'qa-heavy', name: '重测试团队', icon: '🧪', description: '技术方案后直接开发，QA 加码', mode: 'full',
	stages: [
		{ key: 'acceptance', role: '质量负责人' },
		{ key: 'dev' },
		{ key: 'qa', role: '资深测试', instructions: '覆盖边界值与回归用例' },
		{ key: 'tech', instructions: '写清回滚方案' },
	],
});
check('新建自定义团队：阶段按执行顺序规整、缺省角色补齐', saved10.ok && saved10.created
	&& saved10.team.stages.map((s) => s.key).join(',') === 'tech,dev,qa,acceptance' && saved10.team.stages[1].role === '高级全栈工程师');
check('自定义团队落盘到数据根 teams.json', fs.existsSync(T10.file) && JSON.parse(fs.readFileSync(T10.file, 'utf8')).teams.some((x) => x.id === 'qa-heavy'));
check('新建时自动生成 id', (() => { const r = T10.save({ name: '临时', stages: [{ key: 'dev' }, { key: 'acceptance' }] }); return r.ok && /^team(-\d+)?$/.test(r.team.id) && T10.remove(r.team.id).ok; })());

// 会话选择 + 注入：agent 在 → 直接注入；不在 → 挂起，agent/created 时补发；取消 → 清挂起 + 发作废通知。
agents10.set('sess-T', { inject: (m) => injected10.push({ sid: 'sess-T', m }) });
const selT = host10.views.call('selectTeam', ['sess-T', 'qa-heavy'], {}).value;
check('选择团队：返回精简形状 + 立即注入会话', selT.ok && selT.team.id === 'qa-heavy' && !('stages' in selT.team) && selT.delivery === 'inject'
	&& injected10.length === 1 && injected10[0].m.role === 'user' && injected10[0].m.source.kind === 'plugin:dsh-teamflow-workbench'
	&& /teamId=qa-heavy/.test(injected10[0].m.content[0].text) && /teamflow_start/.test(injected10[0].m.content[0].text));
check('getActiveTeam / listTeams 同形', host10.views.call('getActiveTeam', ['sess-T'], {}).value.team.id === 'qa-heavy'
	&& host10.views.call('listTeams', ['sess-T'], {}).value.teams.length === 4);
const selP = T10.select('sess-P', 'ui');
check('agent 未加载：挂起', selP.delivery === 'pending' && T10.pendingCount() === 1);
agents10.set('sess-P', { inject: (m) => injected10.push({ sid: 'sess-P', m }) });
check('agent/created 补发挂起上下文', T10.flushPending('sess-P') === true && T10.pendingCount() === 0 && injected10.at(-1).sid === 'sess-P');
T10.select('sess-Q', 'fix');
const clrQ = T10.clear('sess-Q');
check('选了又取消：清掉挂起，不再补发旧规则', T10.pendingCount() === 0 && clrQ.ok);
const clrP = host10.views.call('clearTeam', ['sess-P'], {}).value;
check('取消团队：发送作废通知', clrP.delivery === 'inject' && /已取消本会话的团队/.test(injected10.at(-1).m.content[0].text)
	&& T10.activeOf('sess-P') === null);

// 对流水线的真实影响：阶段裁剪、角色/要求进提示词、默认档位、团队快照。
const st10 = host10.controller.start('给设置页加暗色切换并补测试', { cwd: scratch, sessionId: 'sess-T' });
await host10.controller.pending();
const j10 = host10.store.readJson(host10.store.journalFile(st10.runId), null);
check('省略 teamId → 用会话当前团队', st10.ok && st10.team?.id === 'qa-heavy' && j10.team?.source === 'session');
check('阶段 = 档位阶段 ∩ 团队阶段（裁掉 prd）', st10.stages.join(',') === 'tech,dev,qa,acceptance' && st10.rationale.some((r) => /裁掉 prd/.test(r)));
check('团队默认档位生效', st10.mode === 'full' && st10.rationale.some((r) => /默认档位 full/.test(r)));
const qaPrompt10 = prompts10.find((p) => p.sessionId === `tf-${st10.runId}-qa`)?.prompt || '';
check('角色与团队要求写进阶段提示词', /你的角色：资深测试（🧪 重测试团队 团队）/.test(qaPrompt10) && /团队对本阶段的要求：覆盖边界值与回归用例/.test(qaPrompt10), qaPrompt10.slice(0, 200));
check('独立验收仍然跑（团队不影响验收闸）', runs10.calls.includes(`tf-${st10.runId}-verify`) && j10.status === 'completed');
T10.save({ ...saved10.team, stages: saved10.team.stages.map((s) => (s.key === 'qa' ? { ...s, role: '改过的角色' } : s)) });
const jAgain = host10.store.readJson(host10.store.journalFile(st10.runId), null);
check('团队定义快照进 run：之后改团队不影响已有 run', jAgain.stages.find((s) => s.phase === 'qa').role === '资深测试');
check('显式 teamId 优先于会话团队；design 勾选即启用', host10.controller.preview('做个页面', { teamId: 'ui', sessionId: 'sess-T' }).stages.includes('design'));
check('未知 teamId 明确报错（不静默退化成不裁剪）', host10.controller.start('修个错别字', { teamId: 'nope', cwd: scratch }).ok === false);
const guard10 = host10.controller.preview('重构数据库持久化层的抽象', { mode: 'lite', sessionId: 'nobody' });
check('护栏：指定轻档位遇到架构类需求被抬升', guard10.ok && guard10.mode !== 'lite' && guard10.rationale.some((r) => /护栏抬升/.test(r)), JSON.stringify(guard10.rationale));
check('无团队时照旧按默认阶段跑', host10.controller.preview('修个错别字', { sessionId: 'nobody' }).team === null);
const del10 = T10.remove('qa-heavy');
check('删除团队：解绑正在使用它的会话', del10.ok && del10.unboundSessions && T10.activeOf('sess-T') === null);
T10.save({ id: 'qa-heavy', name: '重测试团队', icon: '🧪', mode: 'full', stages: [{ key: 'tech' }, { key: 'dev' }, { key: 'qa' }, { key: 'acceptance' }] });
T10.select('sess-T', 'qa-heavy');

// 损坏文件保护：不覆盖用户文件，读出 error，写操作拒绝；修好后自动恢复。
const goodTeams = fs.readFileSync(T10.file, 'utf8');
fs.writeFileSync(T10.file, '{ "teams": [ broken');
const broken10 = T10.all();
check('teams.json 损坏：只剩内置团队 + 明确报错', broken10.teams.length === 3 && /无法解析/.test(broken10.error || ''));
check('teams.json 损坏：拒绝写入且不覆盖原文件', T10.save({ name: '新', stages: [{ key: 'dev' }, { key: 'acceptance' }] }).ok === false
	&& fs.readFileSync(T10.file, 'utf8') === '{ "teams": [ broken');
fs.writeFileSync(T10.file, goodTeams);
check('修好文件后自动恢复', T10.all().teams.length === 4 && !T10.all().error);
const cfg10 = host10.views.call('teamsConfig', [], { sessionId: 'sess-T' }).value;
check('teamsConfig：团队全量 + 阶段 / 必选 / 档位清单 + 当前会话团队', cfg10.teams.length === 4 && cfg10.phases.length === 7
	&& cfg10.required.join(',') === 'dev,acceptance' && cfg10.modes.length === 6 && cfg10.active === 'qa-heavy');
check('saveTeam / deleteTeam 走 RPC 信封', host10.views.call('saveTeam', [{ name: 'RPC 队', stages: [{ key: 'dev' }, { key: 'acceptance' }] }], {}).value.ok === true
	&& host10.views.call('deleteTeam', ['nope'], {}).value.ok === false);
const toolTeams = probe.tools.get('teamflow_teams');
const toolOut = toolTeams ? await toolTeams.execute({}, { agent: { session: { id: 'sess-X' } } }) : null;
check('teamflow_teams 工具列出团队与阶段', !!toolOut && toolOut.ok && toolOut.teams.some((x) => x.id === 'dev' && x.stages.length === 5) && toolOut.active === null);

console.log('── 11) 工作目录：下拉候选 / 探测 / 新建 ──');
const newDir11 = path.join(scratch, 'brand-new', 'app');
const filePath11 = path.join(scratch, 'a-file.txt');
fs.writeFileSync(filePath11, 'x');
const V10 = host10.views;
check('probeCwd：已存在目录', (() => { const p = V10.call('probeCwd', [scratch], {}).value; return p.exists && p.isDir && p.absolute; })());
check('probeCwd：不存在但可新建', (() => { const p = V10.call('probeCwd', [newDir11], {}).value; return !p.exists && p.creatable && p.absolute; })());
check('probeCwd：相对路径 / 同名文件 不可用', !V10.call('probeCwd', ['relative/dir'], {}).value.absolute
	&& V10.call('probeCwd', [filePath11], {}).value.isDir === false && V10.call('probeCwd', [filePath11], {}).value.creatable === false);
const miss11 = host10.controller.start('修个错别字', { cwd: newDir11 });
check('不存在的目录未确认新建 ⇒ 拒绝启动且不建目录', miss11.ok === false && miss11.cwdMissing === true && !fs.existsSync(newDir11), miss11.error);
check('相对路径 ⇒ 拒绝启动', host10.controller.start('修个错别字', { cwd: 'relative/dir' }).ok === false);
const mk11 = host10.controller.start('修个错别字', { cwd: newDir11, createCwd: true });
await host10.controller.pending();
check('确认新建 ⇒ 递归建目录并启动', mk11.ok === true && mk11.cwdCreated === true && fs.existsSync(newDir11) && fs.statSync(newDir11).isDirectory(), mk11.error);
const mkJ11 = host10.store.readJson(host10.store.journalFile(mk11.runId), null);
check('新建目录记进 run 日志', mkJ11.logs.some((l) => /已新建工作目录/.test(l.message)) && mkJ11.cwd === path.normalize(newDir11));
const again11 = host10.controller.start('修个错别字', { cwd: newDir11, createCwd: true });
await host10.controller.pending();
check('目录已存在时 createCwd 无副作用', again11.ok && again11.cwdCreated === false);
const opts11 = V10.call('cwdOptions', [], {}).value;
check('cwdOptions：流水线用过的目录（去重、带 run 数）+ Host 当前目录', opts11.hostCwd === scratch
	&& opts11.recent.some((r) => r.path.toLowerCase() === path.normalize(newDir11).toLowerCase() && r.runs === 2 && r.exists === true));

console.log('── 12) 服务掉线自愈 / 环境故障不污染后续阶段 / 断点续跑 ──');
// 真机事故（2026-11-04 15:33）：HMR config reload 失败 ⇒ bridge 的 vssarosRuns 被 dispose，
// 旧实现永久缓存 null，且把剩余 4 个阶段逐一刷成 blocked，整条 run 停死。
const runs12 = makeRuns(false);
let live12 = runs12;
const deps12 = {
	runs: runs12,
	workItems,
	resolveService: (name) => (name === 'vssarosRuns' ? live12 : (name === 'vssarosWorkItems' ? workItems : null)),
};
const host12 = createHost({ root: path.join(scratch, 'data-hmr'), cwd: scratch, allowTools: [], timeoutMs: 600000, runsRetryMs: 0 }, deps12);
const s12 = host12.controller.start('HMR 掉线自愈', { cwd: scratch });
// 模拟 HMR：旧注入快照被清，但服务已重建（ctx.get 能现取）。
deps12.runs = null;
await host12.controller.pending();
const j12 = host12.store.readJson(host12.store.journalFile(s12.runId), null);
check('HMR 后旧快照被清，但运行时现取服务 ⇒ 整条 run 照常跑完', j12.status === 'completed'
	&& j12.stages.every((s) => s.status === 'done') && runs12.calls.length >= 6,
	`${j12.status} / ${j12.stages.map((s) => s.status).join(',')}`);
check('现取服务路径不依赖注入快照', deps12.runs === null && runs12.calls.length >= 6);

// 服务彻底不可用：只停当前阶段，后续保持 pending，标记 recoverable。
const deps12b = { runs: null, workItems, resolveService: () => null };
const host12b = createHost({ root: path.join(scratch, 'data-hmr-down'), cwd: scratch, allowTools: [], timeoutMs: 600000, runsRetryMs: 0 }, deps12b);
const s12b = host12b.controller.start('服务掉线', { cwd: scratch });
await host12b.controller.pending();
const j12b = host12b.store.readJson(host12b.store.journalFile(s12b.runId), null);
check('服务不可用：只第一个阶段停线，后续阶段仍 pending（不逐一刷 blocked）', j12b.status === 'needs-human'
	&& j12b.stages[0].status === 'needs-human' && j12b.stages.slice(1).every((s) => s.status === 'pending'),
	j12b.stages.map((s) => s.status).join(','));
check('需人工原因标 recoverable，且如实说明是环境故障', j12b.needsHuman.recoverable === true
	&& /vssarosRuns 暂时不可用/.test(j12b.needsHuman.reason));
// 服务恢复后 resume：构造「PRD 已 done、tech 停线、其余 pending」的断点（对应真机事故现场）。
// 同时把 dev 标成旧版遗留的 blocked，验证 resume 一并收编。
const broken = host12b.store.readJson(host12b.store.journalFile(s12b.runId), null);
broken.stages[0].status = 'done'; broken.stages[0].outcome = null;
broken.stages[1].status = 'needs-human'; broken.stages[1].outcome = 'vssarosRuns 暂时不可用';
broken.stages[2].status = 'blocked'; broken.stages[2].outcome = 'vssarosRuns 不可用（bridge 未加载）';
host12b.store.saveJournal(broken);
let live12b = null;
deps12b.resolveService = (name) => (name === 'vssarosRuns' ? live12b : (name === 'vssarosWorkItems' ? workItems : null));
const runs12b = makeRuns(false);
live12b = runs12b;
const resumed12 = host12b.controller.resume(s12b.runId);
await host12b.controller.pending();
const j12c = host12b.store.readJson(host12b.store.journalFile(s12b.runId), null);
check('服务恢复后 resume 从断点跑完，已 done 的 PRD 不重跑', resumed12.ok === true && j12c.status === 'completed'
	&& j12c.stages.every((s) => s.status === 'done') && !runs12b.calls.some((c) => c.endsWith('-prd')),
	`${j12c.status} / calls=${runs12b.calls.join(',')}`);
check('旧版遗留的 blocked 阶段被 resume 收编且清掉旧 outcome', j12c.stages.every((s) => !s.outcome));

console.log('── 9) 上游 UI 子块：模块表求值 + 用真实数据形状渲染 ──');
const req9 = createRequire(import.meta.url);
let React9 = null;
let SSR9 = null;
try { React9 = req9('react'); SSR9 = req9('react-dom/server'); } catch (e) { check('仓库里能解析 react / react-dom/server（渲染自检依赖）', false, e.message); }
if (React9 && SSR9) {
	const loadChunk = (rel) => {
		let def = null;
		new Function('window', fs.readFileSync(path.join(ROOT, rel), 'utf8'))({ __ModuleLoader__: { load: (d) => { def = d; } } });
		return { def, exports: def.factory((id) => { if (id === 'react') return React9; throw new Error(`unexpected require ${id}`); }) };
	};
	const uiMod = loadChunk('lib/client.teamflow.ui.js');
	const ui = uiMod.exports;
	check('UI 子块声明 chunk 名', uiMod.def.chunk === 'client.teamflow.ui.js' && uiMod.def.id === 'dsh-teamflow-workbench');
	check('UI 子块导出上游组件', ['TeamFlowView', 'GlobalPanel', 'PipelinePanel', 'BoardPanel', 'RunDetailPane', 'ItemDetailPane']
		.every((k) => typeof ui[k] === 'function'));
	const regMod = loadChunk('lib/client.teamflow.js');
	const reg = regMod.exports;
	ui.shared.setTranslator(reg.fallbackTranslator(ui.locales.zh), () => 'zh');
	const render = (C, props) => { try { return SSR9.renderToString(React9.createElement(C, props)); } catch (e) { return `RENDER_ERROR ${e.message}`; } };
	const pipeHtml = render(ui.PipelinePanel, { active: snap8, api: null, runId: s8.runId, sessionId: 'sess-A', uiWorkspace: null });
	check('流水线画布用真实快照渲染（阶段卡 + 修复轮）', pipeHtml.includes('技术方案') && pipeHtml.includes('QA 缺陷修复（第 1 轮）') && !pipeHtml.startsWith('RENDER_ERROR'),
		pipeHtml.slice(0, 160));
	const boardHtml = render(ui.BoardPanel, { backlog: bl8, api: null, onRefresh: () => {}, sessionId: 'sess-A', onShowRun: () => {}, openArtifact: () => {} });
	check('Backlog 看板用真实看板渲染（需求/任务/缺陷卡）', boardHtml.includes(bl8.requirements[0].id) && boardHtml.includes(bugId8), boardHtml.slice(0, 160));
	const runHtml = render(ui.RunDetailPane, { snap: snap8, product: prods8.current, api: null, onCancel: () => {} });
	check('全局面板 run 详情渲染（阶段列表 + 日志）', runHtml.includes('产品验收') && runHtml.includes('独立验收'), runHtml.slice(0, 160));
	const itemHtml = render(ui.ItemDetailPane, { det: bugDet8, openArtifact: () => {}, onClose: () => {}, backlog: bl8 });
	check('条目详情渲染（缺陷可执行定义）', itemHtml.includes('node check.mjs'), itemHtml.slice(0, 160));
	const tabHtml = render(ui.TeamFlowView, { sessionId: 'sess-A', remote: reg.makeApi(() => ({})) });
	check('会话页签首帧渲染（品牌条 + 流水线/Backlog tab）', tabHtml.includes('团队工作台') && tabHtml.includes('Backlog'), tabHtml.slice(0, 160));

	// install：伪 ctx 记录两处注册（工作台描述符 + conversation.view 槽位）。
	const slotRegs = [];
	const wbRegs = [];
	const fakeSlots = { inject: (name, cb) => { cb(); return () => {}; }, register: (opts, C) => { slotRegs.push({ opts, C }); return () => {}; } };
	const ctx9 = {
		get: () => null,
		effect: (fn) => fn(),
		desktopWorkbenches: { register: (d, C) => { wbRegs.push({ d, C }); return () => {}; } },
		inject: (names, cb) => cb({ slots: fakeSlots, effect: (fn) => fn() }),
	};
	const teamsMod = loadChunk('lib/client.teamflow.teams.js');
	const teamsUi = teamsMod.exports;
	check('团队配置子块声明 chunk 名并导出 TeamsEditor', teamsMod.def.chunk === 'client.teamflow.teams.js' && typeof teamsUi.TeamsEditor === 'function');
	reg.install(ctx9, ui, teamsUi);
	const tab9 = slotRegs.find((r) => r.opts.name === 'conversation.view');
	check('会话页签注册在 conversation.view，order 落在「轨迹」(10) 与「技能」(20) 之间', !!tab9 && tab9.opts.id === 'teamflow'
		&& tab9.opts.order > 10 && tab9.opts.order < 20 && tab9.C === ui.TeamFlowView);
	check('页签名「🏭 团队工作台」', tab9 && tab9.opts.label() === '🏭 团队工作台');
	const inj9a = tab9 && tab9.opts.inject('sess-A');
	const inj9b = tab9 && tab9.opts.inject('sess-A');
	check('同一会话注入稳定的 remote（避免轮询重启风暴）', inj9a && inj9a.remote === inj9b.remote && typeof inj9a.remote.list === 'function' && inj9a.sessionId === 'sess-A');
	const sel9 = slotRegs.find((r) => r.opts.name === 'conversation.input.right');
	check('输入框旁团队选择器：conversation.input.right / 上游 TeamSelector', !!sel9 && sel9.opts.id === 'teamflow-team-select'
		&& sel9.C === ui.TeamSelector && typeof ui.TeamSelector === 'function');
	const selInj = sel9 && sel9.opts.inject('sess-A');
	check('团队选择器与会话页签共用同一会话 remote', selInj && selInj.remote === inj9a.remote && typeof selInj.remote.selectTeam === 'function');
	check('团队选择器已打「展开即重取」补丁', /if \(!open\) load\(\); setOpen\(!open\)/.test(read('lib/client.teamflow.ui.js')));
	check('工作台描述符：local 身份 + 上游全局面板外壳', wbRegs.length === 1 && wbRegs[0].d.package === 'dsh-teamflow-workbench');
	const pageHtml = wbRegs.length ? render(wbRegs[0].C, {}) : '';
	check('工作台页渲染：工作台外壳 + 新建流水线 + 上游全局面板', pageHtml.includes('data-vssaros-surface="workbench"')
		&& (pageHtml.match(/data-dsh-workbench-toolbar/g) || []).length === 1 && pageHtml.includes('启动流水线') && pageHtml.includes('data-teamflow-panel'),
	pageHtml.slice(0, 200));
	check('根节点挂共享层 .wb（字号/内边距/行高走共享规格）', /class="wb wb-teamflow"/.test(pageHtml));
	check('嵌入时不再出现上游自带标题栏（只剩一条工具条）', !pageHtml.includes('全局面板 · 按产品线') && pageHtml.includes('data-teamflow-back'));
	check('新建流水线是工具条下的独立一行（不挤在工具条里）', /data-dsh-workbench-toolbar[^]*?<\/div><div class="tf-composer"/.test(pageHtml));
	check('UI 子块已打「嵌入隐藏标题栏」补丁', /props\.embedded \? null/.test(read('lib/client.teamflow.ui.js')));
	check('续跑按钮覆盖 needs-human（服务掉线停线后仍可从断点重跑）',
		/activeRun\.status === 'needs-human'/.test(read('lib/client.teamflow.ui.js')));
	check('工作台页有「流水线 / 团队配置」标签与启动团队选择', pageHtml.includes('data-teamflow-view="teams"') && pageHtml.includes('团队配置')
		&& pageHtml.includes('data-teamflow-start-team') && pageHtml.includes('不指定团队'));
	const conf9 = host10.views.call('teamsConfig', [], { sessionId: 'sess-T' }).value;
	const edHtml = render(teamsUi.TeamsEditor, { api: null, initial: { ...conf9, select: 'qa-heavy' } });
	check('团队配置页渲染：列表含内置与自定义团队', edHtml.includes('data-teamflow-team="dev"') && edHtml.includes('data-teamflow-team="qa-heavy"')
		&& edHtml.includes('当前会话') && !edHtml.startsWith('RENDER_ERROR'), edHtml.slice(0, 200));
	check('团队配置页渲染：表单含 7 个阶段，必选阶段锁定', (edHtml.match(/data-teamflow-stage-conf=/g) || []).length === 7
		&& (edHtml.match(/必选/g) || []).length >= 2 && edHtml.includes('data-teamflow-team-save'));
	const edBuiltin = render(teamsUi.TeamsEditor, { api: null, initial: { ...conf9, select: 'dev' } });
	check('内置团队只读：提示复制、不出现保存/删除按钮', edBuiltin.includes('data-teamflow-team-copy') && !edBuiltin.includes('data-teamflow-team-save')
		&& !edBuiltin.includes('data-teamflow-team-delete'));
	const d9 = teamsUi.draftOf(conf9.teams.find((x) => x.id === 'qa-heavy'), conf9.phases);
	const p9 = teamsUi.payloadOf(d9);
	check('表单草稿 ↔ 保存载荷往返一致（只提交勾选阶段）', p9.stages.map((s) => s.key).join(',') === 'tech,dev,qa,acceptance'
		&& host10.teams.save({ ...p9 }).ok === true);
	const fakeWsCtx = {
		get: (name) => (name === 'workspaces'
			? { list: { getSnapshot: () => ({ items: [
				{ workspaceId: 'w1', path: 'G:\\Work\\alpha', title: 'alpha', sessionIds: ['a', 'b'] },
				{ workspaceId: 'w2', path: 'G:\\Work\\beta\\', title: 'beta', sessionIds: [] },
			] }) } }
			: name === 'sessions'
				? { list: { getSnapshot: () => ({ byId: {
					s1: { cwd: 'g:\\work\\BETA' }, s2: { cwd: 'G:\\Work\\beta' }, s3: { cwd: 'C:\\Users\\me' }, s4: { cwd: 'G:\\Work\\alpha' },
				} }) } }
				: null),
	};
	const dirs9 = reg.vssarosDirs(fakeWsCtx);
	check('工作目录候选：工作区 + 会话目录合并、大小写/尾斜杠去重、按会话数排序', dirs9.length === 3
		&& dirs9[0].path === 'G:\\Work\\alpha' && dirs9[0].sessions === 3 && dirs9.find((d) => d.title === 'beta')?.sessions === 2
		&& dirs9.some((d) => d.path === 'C:\\Users\\me'), JSON.stringify(dirs9));
	const cwdHtml = render(reg.CwdPicker, { ctx: fakeWsCtx, api: reg.makeApi(() => ({})), value: '', onChange: () => {}, create: false, onCreate: () => {}, refreshKey: 0 });
	check('工作目录下拉渲染：可输入（combobox）+ 展开按钮', /role="combobox"/.test(cwdHtml) && cwdHtml.includes('data-teamflow-cwd-toggle')
		&& cwdHtml.includes('data-teamflow-cwd-picker="closed"') && !cwdHtml.startsWith('RENDER_ERROR'), cwdHtml.slice(0, 200));
	check('工作台页用的是工作目录下拉而不是裸输入框', pageHtml.includes('data-teamflow-cwd-picker'));
}

try { rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
console.log('\n[teamflow] ' + pass + ' passing / ' + fail + ' failing');
process.exit(fail === 0 ? 0 : 1);
