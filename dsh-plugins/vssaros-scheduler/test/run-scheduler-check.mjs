// @vssaros/dsh-scheduler — 包内自检（工作台模板 S15）。
//   跑法：node dsh-plugins/vssaros-scheduler/test/run-scheduler-check.mjs
//   两类断言：
//     ① 静态契约（清单 / patch / 入口 / 组件 / 共享层 / 容器查询 / 锚点 / 零 iframe）—— 与 check-workbench-style.mjs 同口径
//     ② 纯逻辑（migrate.toOfficialRequest：cron / one-shot / interval 的规范化与拒绝理由；
//        Host 侧 buildCreateRule：表单 → 官方 request 的转换与拒绝）
//
// ★ 2026-10-31：工作台由「官方 chunk 副本」改为**自建引擎 + 自绘界面** ⇒ 针对官方副本的那批断言
//   （出处 / MIT / 子块装载 / 渲染 TaskManagerPage / 数据走 remote.schedule）全部作废，
//   换成「入口即组件 + 数据走同源 API + 假 loader 真跑一遍」。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { toOfficialRequest } from '../lib/migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
	if (ok) { pass += 1; console.log('  ok   ' + name + (detail ? '  — ' + String(detail).slice(0, 90) : '')); }
	else { fail += 1; console.log('  FAIL ' + name + (detail ? '  — ' + String(detail).slice(0, 200) : '')); }
};

const pkg = JSON.parse(read('package.json'));

console.log('── 清单与激活 ──');
check('包名', pkg.name === '@vssaros/dsh-scheduler', pkg.name);
check('清单声明工作台 title', !!pkg.vssaros?.workbench?.title, pkg.vssaros?.workbench?.title);
check('注入自有宿主 @vssaros/dsh-workbenches', (pkg.dsh?.client?.inject || []).includes('@vssaros/dsh-workbenches'));
const patchField = pkg.dsh?.bundle?.patch;
check('清单带 dsh.bundle.patch', /cordis\.patch\.yml/.test(String(Array.isArray(patchField) ? patchField.join(',') : patchField)), JSON.stringify(patchField));
check('files 里含 cordis.patch.yml', (pkg.files || []).includes('cordis.patch.yml'));
const patch = read('cordis.patch.yml');
check('cordis.patch.yml 有 insert 段', /-\s*insert:/.test(patch));
check('patch 的 name 与包名一致', patch.includes(`'@vssaros/dsh-scheduler'`), patch.split('\n').find((l) => l.includes('name:'))?.trim());

console.log('── 自建工作台（入口 lib/client.js 即组件，不再搬官方 chunk）──');
const entryRaw = read('lib/client.js');
const entry = strip(entryRaw);
check('入口不写 chunk: 字段', !/^\s*chunk\s*:/m.test(entry));
check('入口自己注册（不再 require.async 装载子块）',
	/desktopWorkbenches\.register\(/.test(entry) && !/require\.async\(/.test(entry));
// ⚠ 只看 **strip 掉注释后的代码**：文件头注释里仍然提到官方包（说明为什么要替换掉它），
//   那是有意保留的历史，不该被判成"还在依赖它"。
check('代码里不再引用官方 chunk 出处', !entry.includes('@deepseek-ai/dsh-client-ui-schedule'));
// ★ 为什么这条必须钉住：自建的 `schedule` 服务**没有 @Remote** ⇒ 浏览器 `remote.schedule.*`
//   不存在 ⇒ UI 只能通过同源 Host 路由取数。谁改回 remote.schedule，真机就是"面板空白"。
check('不依赖 remote.schedule（数据走同源 API）', !/remote\.schedule/.test(entry));
for (const api of ['/x/scheduler/api/list', '/x/scheduler/api/create', '/x/scheduler/api/update', '/x/scheduler/api/delete', '/x/scheduler/api/history']) {
	check('数据走 ' + api, entry.includes(api));
}
check('根节点有 data-vssaros-surface="workbench"', /data-vssaros-surface['"]?\s*:\s*['"]workbench/.test(entry));
check('≥3 个 data-* 锚点', new Set(entry.match(/data-[a-z0-9-]{3,30}/g) || []).size >= 3);
check('零 iframe', !/<iframe|createElement\(['"]iframe/.test(entry));
check('有真机锚点 data-vssaros-scheduler-create', /data-vssaros-scheduler-create/.test(entry));
// 宿主据此吸顶 ⇒ 必须恰好 1 个。
// ⚠ `(?!-)`：不带它的话 `data-dsh-workbench-toolbar-x` 也会命中 ⇒ 改个名也测不出来（突变验证抓到的）。
const toolbarHits = (entry.match(/data-dsh-workbench-toolbar(?!-)/g) ?? []).length;
check('工具条锚点恰好 1 个', toolbarHits === 1, String(toolbarHits));
check('有容器查询 @container（会被塞进 320–420px 侧栏）', /@container/.test(entry));
check('静态 inject 留空（服务走可选注入）', /module\.exports\.inject\s*=\s*\[\]/.test(entry));
// ★ 2026-10-31 真机事故：`ctx.tools` 是 cordis 服务，Host 侧**没写进 inject 就直读**会抛
//   `cannot get property "tools" without inject` ⇒ apply 失败 ⇒ 插件激活不了（页面路由也没注册）。
//   自建引擎要注册 5 个工具 ⇒ 必须静态声明 `tools`（与 vssaros-loop 同款）。
check('Host 侧静态 inject 声明 tools', /export const inject = \['tools'\]/.test(strip(read('lib/index.js'))));
check('工具注册不再直读 ctx.tools（走 registerScheduleTools）', /registerScheduleTools\(/.test(strip(read('lib/index.js'))));
const bare = entry.split('\n').filter((l) => !l.includes('var(--') && (/(?<![&\w])#[0-9a-fA-F]{3,8}\b/.test(l) || /\b(rgba?|hsla?)\(/.test(l)));
check('无裸色值', bare.length === 0, bare.slice(0, 2).join(' | '));

console.log('── 迁移逻辑：toOfficialRequest ──');
const TZ = 'Asia/Shanghai';
{
	const r = toOfficialRequest({ type: 'cron', name: '每日', prompt: '跑一下', cron: '0 9 * * *' }, TZ);
	check('cron 五字段 ⇒ 生成 request', !!r.request && r.request.cron?.expression === '0 9 * * *', JSON.stringify(r.request?.cron));
	check('cron 带时区', r.request?.cron?.time_zone === TZ);
	check('缺 name 时用「未命名任务」', toOfficialRequest({ type: 'cron', prompt: 'x', cron: '0 9 * * *' }, TZ).request?.title === '未命名任务');
}
check('cron 六字段 ⇒ 拒绝并说明「五字段」', /五字段/.test(toOfficialRequest({ type: 'cron', prompt: 'x', cron: '0 0 9 * * *' }, TZ).unsupported || ''));
check('cron 方言（L/W/#/@）⇒ 拒绝', /方言/.test(toOfficialRequest({ type: 'cron', prompt: 'x', cron: '0 9 L * *' }, TZ).unsupported || ''));
check('缺 prompt ⇒ 拒绝', /没有 prompt/.test(toOfficialRequest({ type: 'cron', cron: '0 9 * * *' }, TZ).unsupported || ''));
{
	const r = toOfficialRequest({ type: 'one-shot', prompt: 'x', at: '2026-11-01T09:30:00' }, TZ);
	check('one-shot ISO ⇒ 拆成 date + time', r.request?.at?.date === '2026-11-01' && r.request?.at?.time === '09:30:00', JSON.stringify(r.request?.at));
	check('one-shot 非 ISO ⇒ 拒绝', /不是 ISO/.test(toOfficialRequest({ type: 'one-shot', prompt: 'x', at: '明天早上' }, TZ).unsupported || ''));
}
check('interval <60s ⇒ 拒绝（官方下限）', /下限 60s/.test(toOfficialRequest({ type: 'interval', prompt: 'x', intervalSeconds: 30 }, TZ).unsupported || ''));
check('interval 90.7s ⇒ 取整 90', toOfficialRequest({ type: 'interval', prompt: 'x', intervalSeconds: 90.7 }, TZ).request?.every_seconds === 90);
check('未知 type ⇒ 拒绝并列出支持的三种', /只收 cron \/ one-shot \/ interval/.test(toOfficialRequest({ type: 'weekly', prompt: 'x' }, TZ).unsupported || ''));

console.log('── 新建自动化任务（Host 侧 /api/create 与规则转换）──');
{
	const hostSrc = strip(read('lib/index.js'));   // 同上：注释里提到官方签名不算依赖
	check('Host 侧走自建引擎 engine.create（不再是官方签名）', /engine\.create\(/.test(hostSrc) && !/schedule\.create\(\s*sessionId\s*,/.test(hostSrc));
	check('Host 侧有 /api/create 路由', /\/api\/create/.test(hostSrc));
	// ★ 2026-10-31（自建引擎接管后）：删除**不再需要 sessionId** —— 任务存在
	//   `<数据根>/scheduler/tasks.json`，不寄生会话（这是与官方最大的差别之一）。
	//   旧断言（官方签名 `{ sessionId, id }`）已随官方路径一起作废。
	check('Host 侧 delete 不依赖 sessionId（自建引擎）',
		!/需要 id 与 sessionId/.test(hostSrc) && /engine\.remove\(id\)/.test(hostSrc));
	check('Host 侧有 /api/update 与 /api/history 路由', /\/api\/update/.test(hostSrc) && /\/api\/history/.test(hostSrc));
	check('弹窗自带 data 锚点（真机探针可断言）', /data-vssaros-scheduler-create/.test(entryRaw));

	const { buildCreateRule } = await import('../lib/index.js');
	check('daily ⇒ { daily:{ time, time_zone } }', JSON.stringify(buildCreateRule({ kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }).request)
		=== JSON.stringify({ daily: { time: '09:00:00', time_zone: 'Asia/Shanghai' } }),
		JSON.stringify(buildCreateRule({ kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }).request));
	check('time 补秒（HH:mm ⇒ HH:mm:ss）', buildCreateRule({ kind: 'daily', time: '9:00', timeZone: 'UTC' }).error !== undefined
		|| buildCreateRule({ kind: 'daily', time: '09:00', timeZone: 'UTC' }).request.daily.time === '09:00:00');
	check('weekly 未选星期 ⇒ 拒绝', /星期/.test(buildCreateRule({ kind: 'weekly', time: '09:00', weekdays: [] }).error || ''));
	check('weekly 去重排序（[3,1,1] ⇒ [1,3]）', JSON.stringify(buildCreateRule({ kind: 'weekly', time: '09:00', weekdays: [3, 1, 1] }).request.weekly.weekdays) === '[1,3]');
	check('every <60s ⇒ 拒绝（官方下限）', /60 秒/.test(buildCreateRule({ kind: 'every', everySeconds: 30 }).error || ''));
	check('every 90s ⇒ every_seconds=90', buildCreateRule({ kind: 'every', everySeconds: 90 }).request.every_seconds === 90);
	check('once 缺日期 ⇒ 拒绝', /日期/.test(buildCreateRule({ kind: 'once', time: '09:00' }).error || ''));
	check('once ⇒ { at:{ date, time, time_zone } }', JSON.stringify(buildCreateRule({ kind: 'once', date: '2026-11-01', time: '09:30', timeZone: 'UTC' }).request)
		=== JSON.stringify({ at: { date: '2026-11-01', time: '09:30:00', time_zone: 'UTC' } }));
	check('cron ⇒ { cron:{ expression, time_zone } }', buildCreateRule({ kind: 'cron', expression: '0 9 * * 1-5', timeZone: 'UTC' }).request.cron.expression === '0 9 * * 1-5');
	check('未知 kind ⇒ 拒绝', /不支持/.test(buildCreateRule({ kind: 'weeklyx' }).error || ''));
	check('缺时区 ⇒ 退回 UTC', buildCreateRule({ kind: 'daily', time: '09:00' }).request.daily.time_zone === 'UTC');

	// 官方 request → 自建 rule（过渡层，UI 换完可连 buildCreateRule 一起删）
	const { officialToSelfRule } = await import('../lib/core/task.js');
	check('daily ⇒ 自建 rule（atMinute）', JSON.stringify(officialToSelfRule({ daily: { time: '09:30:00', time_zone: TZ } }))
		=== JSON.stringify({ kind: 'daily', atMinute: 570, timeZone: TZ }));
	check('weekly 的 ISO 星期 ⇒ JS 约定（7 → 0）', JSON.stringify(officialToSelfRule({ weekly: { time: '09:00:00', time_zone: TZ, weekdays: [1, 7] } }).weekdays) === '[0,1]');
	check('every_seconds ⇒ every', officialToSelfRule({ every_seconds: 120 }).everySeconds === 120);
	check('cron ⇒ 自建 rule', officialToSelfRule({ cron: { expression: '0 9 * * *', time_zone: TZ } }).expression === '0 9 * * *');
	check('无法识别 ⇒ undefined', officialToSelfRule({}) === undefined);

	// ★ 2026-10-31：`/api/list` 的行**同时**给出官方扁平字段与自绘兼容字段。
	//   官方字段是给（将来随时可切回的）官方 `TaskManagerPage` 的：它按
	//   `kind/time/timeZone/weekdays/everySeconds/expression/scheduledAt` 取数，
	//   写成自建形状 `rule:{kind,atMinute}` 会**静默显示空白** ⇒ 这里钉死。
	const { rowOf } = await import('../lib/index.js');
	const daily = rowOf({
		id: 't-1', title: '每天任务', prompt: 'p', status: 'active', kind: 'prompt', sessionId: 's-1',
		rule: { kind: 'daily', atMinute: 570, timeZone: 'Asia/Shanghai' },
		next: { target: Date.parse('2026-11-01T01:30:00Z') },
	});
	check('行带官方扁平字段（kind/time/timeZone/scheduledAt）',
		daily.kind === 'daily' && daily.time === '09:30:00' && daily.timeZone === 'Asia/Shanghai'
		&& daily.scheduledAt === '2026-11-01T01:30:00.000Z', JSON.stringify(daily));
	check('行保留自绘兼容字段（ruleText/next/lastDelivered）',
		typeof daily.ruleText === 'string' && daily.ruleText.length > 0 && typeof daily.next === 'string' && 'lastDelivered' in daily);
	const weekly = rowOf({ id: 't-2', title: 'w', rule: { kind: 'weekly', atMinute: 0, weekdays: [0, 1], timeZone: 'UTC' } });
	check('weekly 星期 0（周日）⇒ 官方 ISO 7', JSON.stringify(weekly.weekdays) === '[7,1]', JSON.stringify(weekly.weekdays));
	const every = rowOf({ id: 't-3', title: 'e', rule: { kind: 'every', everySeconds: 3600, timeZone: 'UTC' } });
	check('every ⇒ everySeconds 原样给出', every.everySeconds === 3600 && every.kind === 'every');
}

console.log('── 循环任务并进「任务」页（0.6.0）──');
{
	// 用户 2026-11-02：循环不再单独占工作台入口 ⇒ 收进自动化任务的两个页签（任务 / 运行记录）。
	const cliSrc = read('lib/client.js');
	const toolSrc2 = read('lib/tools.js');
	check('页签收成两个（任务 / 运行记录，带计数）',
		/taskTotal/.test(entry) && /运行记录 \(\$\{allRecords\.length\}\)/.test(entry) && !/}, '定时任务'\)/.test(entry));
	check('循环数据走 loop 插件的同源路由（不需要 Host 转发）',
		/\/x\/loop\/api\/list/.test(entry) && /\/x\/loop\/api\/show/.test(entry));
	check('循环动作：干跑 / 跑一轮 / 放回 blocked',
		/\/x\/loop\/api\/dry-run/.test(entry) && /\/x\/loop\/api\/run/.test(entry) && /\/x\/loop\/api\/answer/.test(entry));
	check('循环卡片混排进任务页（类型徽标 + 账本计数）',
		/vssSchedKind/.test(entry) && /账本 \$\{counts\.done/.test(entry) && /is-loop/.test(entry));
	check('循环详情弹窗（护栏摘要 + 账本表 + 回答）',
		/data-sched-loop-detail/.test(entry) && /data-sched-loop-ledger/.test(entry) && /'data-sched-act': 'loop-answer'/.test(entry));
	// ★ 2026-11-03：loop 插件已卸载 ⇒ 不再请求 /x/loop/api/*（404 会污染日志），列表恒空。
	check('loop 插件卸载后不再请求其接口（循环 UI 恒不渲染）',
		!/getJson\(API_LOOP_LIST\)/.test(cliSrc) && /setLoops\(\{ ok: false, items: \[\]/.test(cliSrc));
	// 「自动化任务里不要有 loop 选项」的四条硬约束（用户 2026-11-03）
	check('新建弹窗不再有 loop 选项', !/value: 'loop'/.test(cliSrc));
	check('新建表单默认 kind=prompt', /kind: 'prompt', loopName: ''/.test(cliSrc));
	check('工具 schema 的 kind enum 不含 loop',
		/enum: \['prompt', 'action'\]/.test(toolSrc2) && !/enum: \['prompt', 'loop'/.test(toolSrc2));
	check('工具不再有 loopName 参数', !/loopName/.test(toolSrc2));
	// 只查 WB_DESCRIPTOR.description 那一行（submit 里的旧分支文案仍带「触发循环」，属不可达死代码）。
	check('工作台描述不再提 loop',
		/description: '自动化任务（自建调度）：定时\/周期\/一次性任务，投递到会话并记录运行历史。'/.test(cliSrc)
		&& !/description: '[^']*触发循环/.test(cliSrc));
}

console.log('── 工具卡片 + 会话自动填充 + 任务定位（0.8.0）──');
{
	// 对照官方 dsh-tool-schedule / dsh-client-ui-schedule 的三件事：
	// ① 聊天里的工具卡片（presentCall）；② 会话不用人填；③ 能跳到具体任务。
	const toolSrc = strip(read('lib/tools.js'));
	const presentCalls = (toolSrc.match(/presentCall:/g) ?? []).length;
	check('5 个工具都有 presentCall（聊天里的工具卡片）', presentCalls === 5, String(presentCalls));
	check('卡片契约与官方同款（card:generic + kind other/read）',
		/card: 'generic'/.test(toolSrc) && /kind: 'read'/.test(toolSrc) && /kind: 'other'/.test(toolSrc));
	check('创建结果里给出入口与定位方式', /__vssarosSchedulerFocus/.test(toolSrc));
	// ★★ 2026-11-03 真机炸点：dsh 的 value-schema spec 要求 `type:'object'` **显式** `additionalProperties`，
	//   缺了 ⇒ 真机报 `tool "schedule_list" returned invalid output: "value" must match exactly one oneOf branch (matched 0)`。
	//   （本地用 dsh 自己的 valueSchemaSpecToJsonSchema 复现：编译直接抛 `schema.additionalProperties must be explicitly true or false`）
	const schemaHeads = [...toolSrc.matchAll(/output:\s*\{[\s\S]{0,40}?schema:\s*\{\s*(?:\r?\n\s*)?type: 'object',?\s*(?:\r?\n\s*)?(additionalProperties: (?:true|false))?/g)];
	check('5 个工具的 output.schema 根都显式 additionalProperties',
		schemaHeads.length === 5 && schemaHeads.every((m) => !!m[1]),
		`schema 根数=${schemaHeads.length}，带 additionalProperties=${schemaHeads.filter((m) => m[1]).length}`);
	check('当前会话从 body 的 data-vssaros-session-id 读（读不到不猜）',
		/dataset\?\.vssarosSessionId/.test(entry));
	check('新建任务默认绑当前会话', /sessionId: currentSessionId\(\)/.test(entry));
	check('弹窗有「用当前会话」按钮', /'use-session'/.test(entry) && /用当前会话/.test(entry));
	check('外部定位入口：__vssarosSchedulerFocus + 一次性焦点键',
		/window\.__vssarosSchedulerFocus/.test(entry) && /vssaros\.scheduler\.focus/.test(entry));
	check('命中后高亮并滚动到卡片', /is-focus/.test(entry) && /scrollIntoView/.test(entry));
}

console.log('── 装载契约：入口在假 loader + 假 React 下真跑一遍 ──');
{
	// 为什么要有这一段：工作台出问题的形态全是"装得上但静默不生效" —— id 写错、factory 里的
	// require 名字拼错、注册期就去读没就绪的服务 ⇒ 页面空白，而宿主**不报错**。
	// 这里用 vm 造一个假 loader + 假 React，把 factory 真跑一遍（不渲染）。
	const code = read('lib/client.js');
	let def = null;
	let loadError = '';
	const sandbox = {
		console,
		window: { __ModuleLoader__: { load: (d) => { def = d; } } },
		document: {
			getElementById: () => null,
			createElement: () => ({ style: {}, dataset: {}, remove() {} }),
			head: { appendChild: () => undefined },
		},
	};
	vm.createContext(sandbox);
	try { vm.runInContext(code, sandbox, { filename: 'lib/client.js' }); } catch (error) { loadError = String(error?.message ?? error); }
	check('入口能被装载（顶层不抛）', !loadError, loadError);
	check('loader id 与包名一致', !!def && def.id === pkg.name, def && def.id);

	const FakeReact = {
		createElement: () => null, useCallback: (fn) => fn, useState: (v) => [v, () => {}],
		useEffect() {}, useLayoutEffect() {}, useRef: () => ({ current: null }), useId: () => 'id',
		useMemo: (fn) => fn(), useSyncExternalStore: () => undefined, Fragment: 'Fragment',
		Component: class {}, memo: (c) => c,
	};
	const requireStub = (id) => {
		if (id === 'react') { return FakeReact; }
		throw new Error('未预期的 require：' + id);
	};
	let part = null;
	let factoryError = '';
	try { part = def.factory(requireStub); } catch (error) { factoryError = String(error?.message ?? error); }
	check('factory 能执行（require 名都对）', !factoryError, factoryError);
	check('导出 apply()', !!part && typeof part.apply === 'function');
	check('静态 inject 留空', !!part && Array.isArray(part.inject) && part.inject.length === 0, part && JSON.stringify(part.inject));

	const registrations = [];
	const injected = [];
	const child = {
		effect: (fn) => fn(),
		desktopWorkbenches: { register: (descriptor, Component) => { registrations.push({ descriptor, Component }); return () => {}; } },
	};
	const ctx = { effect: (fn) => fn(), inject: (deps, cb) => { injected.push([...deps]); cb(child); } };
	let applyError = '';
	try { part.apply(ctx); } catch (error) { applyError = String(error?.message ?? error); }
	check('apply() 不抛', !applyError, applyError);
	// ★ 自建后只依赖 desktopWorkbenches ⇒ 不存在"调度服务缺席 ⇒ 工作台消失"的失败模式。
	check('注入集只有 desktopWorkbenches', injected.length === 1 && injected[0].join(',') === 'desktopWorkbenches', injected.map(d => d.join('+')).join(' '));
	check('真的注册了一个工作台', registrations.length === 1, registrations.length + ' 个');
	const reg = registrations[0];
	check('注册的组件是函数', !!reg && typeof reg.Component === 'function');
	const d = reg ? reg.descriptor : {};
	check('注册描述符 title 与清单同值', d.title === pkg.vssaros.workbench.title, d.title);
	check('注册描述符 description 与清单同值', d.description === pkg.vssaros.workbench.description, d.description);
	check('注册描述符 repository 与清单同值', d.repository === pkg.vssaros.workbench.repository, d.repository);
	check('注册描述符 icon 与清单同值', d.icon === pkg.vssaros.workbench.icon, d.icon);
	check('注册描述符 customFrame 与清单同值', d.customFrame === pkg.vssaros.workbench.customFrame, String(d.customFrame));
	check('注册描述符 headerLayout 与清单同值', d.headerLayout === pkg.vssaros.workbench.headerLayout, d.headerLayout);
	// ★ 2026-10-31（用户：「自动化任务 工作台中，不要有 浮动工具栏」）：
	//   描述符与清单都要声明 `floatingActions: false`（宿主据它隐藏 S2 浮动胶囊）⇒ 两处必须同值。
	check('注册描述符 floatingActions 与清单同值', d.floatingActions === pkg.vssaros.workbench.floatingActions, String(d.floatingActions));
	// ★ 2026-11-03（用户：「自动化任务 工作台中，不应该有 ai 助手栏」）：
	//   宿主对未声明 customFrame 的工作台默认走「左对话 / 右业务」分栏 ⇒ 页面里常驻 AI 助手栏。
	//   本工作台是纯管理页 ⇒ 声明 `splitConversation: false`（宿主 conversationMode ⇒ 'detach' ⇒ 业务占满）。
	check('注册描述符 splitConversation = false（不要 AI 助手栏）', d.splitConversation === false, String(d.splitConversation));
	check('清单同步声明 splitConversation = false', pkg.vssaros.workbench.splitConversation === false, String(pkg.vssaros.workbench.splitConversation));
}

console.log('── 到点投递 + 模型侧自动取会话（0.7.0）──');
{
	// ★★ 2026-11-03 审计出的两个硬缺口，这两条断言就是防它们复发：
	//   ① `engine.onFire` 此前**全仓零消费者** ⇒ 任务到点只写历史，prompt 从没投给会话；
	//   ② `schedule_create` 的 `execute(args)` 拿不到 exec ⇒ 模型必须自己编 sessionId。
	const hostSrc = strip(read('lib/index.js'));
	const toolSrc = strip(read('lib/tools.js'));
	const taskSrc = strip(read('lib/core/task.js'));
	check('Host 真的订阅 onFire 并调 runs.run（不是只有事件定义）',
		/svc\.onFire\(/.test(hostSrc) && /runsSvc\.run\(/.test(hostSrc) && /const svc = engine/.test(hostSrc));
	check('投递结果回写 history（delivered / deliveryError）',
		/svc\.markDelivery\?\./.test(hostSrc) && /markDelivery: \(taskId, atMs, result/.test(strip(read('lib/engine.js'))));
	// 运行记录必须把三态显示出来（否则"没投出去"和"还没投"在 UI 上一样）
	check('运行记录表格有「投递」列', /h\('th', null, '投递'\)/.test(entry) && /deliveryCell\(r\)/.test(entry));
	// 0.8.9 把截断变量从 reason 换成 short（会话失效显示短句），判据跟着换。
	check('投递三态都渲染（已投递 / 未投递+原因 / 投递中 / 旧记录 —）',
		/已投递/.test(entry) && /未投递\$\{short/.test(entry) && /投递中/.test(entry) && /'—'/.test(entry));
	check('投递用 bridge 的 vssarosRuns（与 loop 同一条原语）',
		/ctx\.inject\(\['vssarosRuns'\]/.test(hostSrc));
	// 0.9.0 起改为投递前 `bindingOf` 预检（未绑定 / 跨环境 / 会话被删 都当场记账并跳过）。
	check('没绑会话 ⇒ 归属预检拦截（不猜会话、不假装投递）',
		/bindingOf\(task, hostConfig\)/.test(hostSrc) && /未绑定会话（不投递）/.test(hostSrc));
	check('后台回合的审批放行来自 config.allowTools', /config\?\.allowTools/.test(hostSrc));
	check('schedule_create 从 exec 取当前会话（对齐官方 exec.agent.session.id）',
		/async execute\(args = \{\}, exec\)/.test(toolSrc) && /exec\?\.agent\?\.session\?\.id/.test(toolSrc));
	check('schedule_create 的 sessionId 不再写"必填"', !/必填：绑定的会话 id/.test(toolSrc));
	check('rule 认 time:"HH:MM"（免换算）',
		/minuteOfClock\(ruleRaw\.time\)/.test(taskSrc) && /time: \{ type: 'string'/.test(toolSrc));
	check('every 也认官方形状 every_seconds', /ruleRaw\.every_seconds/.test(taskSrc));
	check('状态枚举收下 inactive（UI 暂停按钮用的就是它）', /TASK_STATUSES = \['active', 'inactive'/.test(taskSrc));
	// ⚠ 别写 `|| true`：那是假绿（这次草稿里就出现过）。真数出现次数。
	const engineSrc = strip(read('lib/engine.js'));
	check('有效期停用抽成 expireDue，且 tick 与 catchUp 都调用',
		/function expireDue\(/.test(engineSrc) && (engineSrc.match(/expireDue\(/g) ?? []).length >= 3,
		String((engineSrc.match(/expireDue\(/g) ?? []).length));
}

console.log('── 编辑弹窗接线（0.8.7）──');
{
	// 2026-11-03 用户报「编辑自动化任务弹窗里的按钮未接线」⇒ 三处根因，都是**静默失败**：
	//   ① getJson 直接 await fetch ⇒ 传输层一失败就抛未捕获异常 ⇒ 点了毫无反应（连错误都不显示）；
	//   ② 编辑分支没传 sessionId ⇒ 点「用当前会话」再保存等于没点；
	//   ③ updateSchedule 也不收 sessionId（两端都缺）。
	const clientSrc = strip(read('lib/client.js'));
	const hostSrc = strip(read('lib/index.js'));
	check('getJson 兜住传输层异常（失败降级成可见 error，不抛）', /连不上调度服务/.test(clientSrc));
	// ⚠ 这条**必须用原文**（不能用 strip）：`strip()` 遇到行内的空字符串字面量（`?? ''`）会配错引号，
	//   把紧随其后的内容一起吃掉 ⇒ 断言永远假红（试出来的）。
	check('编辑保存带上 sessionId（空串=解绑）', /sessionId: String\(form\.sessionId/.test(read('lib/client.js')));
	check('updateSchedule 接受 sessionId', /typeof body\?\.sessionId === 'string'/.test(hostSrc));
	check('保存中禁用按钮 + 文案（连点不重复提交）',
		/props\.saving \? '保存中…'/.test(clientSrc) && /setSaving\(true\)/.test(clientSrc));
}

console.log('── 操作回执 + 去装饰控件（0.8.8）──');
{
	// 2026-11-03 用户两条："立即运行一次按钮点击后没有反应" / "附件、工作区、访问权限、模型选择、试运行 都不生效"。
	// 前者是**没有提示槽**（setErr 的话无处渲染）；后者是照官方编辑器临摹的**假按钮**。
	const src = read('lib/client.js');
	check('任务页有提示槽（runNow 的回执真能显示）', /data-sched-msg/.test(src));
	check('立即运行：防连点 + 明确回执（含"结果见运行记录"）',
		/runningId/.test(src) && /已触发「/.test(src) && /投递结果见「运行记录」/.test(src));
	// 判据只看**调用点**（注释里保留用户原话"按钮未接线"是好事，别被它误伤）
	check('弹窗里的装饰假按钮已删除（附件/模型/试运行/工作区/权限 都不再绑 note）',
		!/note\(.附件/.test(src) && !/note\(.模型选择/.test(src) && !/note\(.试运行/.test(src)
		&& !/note\(.工作区/.test(src) && !/note\(.访问权限/.test(src));
	check('改为能力说明（附件/模型/权限沿用会话）', /任务本身不单独持有/.test(src));
}

console.log('── 投递失败文案可行动（0.8.9）──');
{
	// 2026-11-03 真机：任务绑的是 **dev 的会话 id**，产品版 Host 找不到 ⇒ bridge 抛一串 session 引用，
	// UI 只显示被截断的半截 id，用户问「未投递是什么意思、如何解决」。
	const host = read('lib/index.js');
	const cli = read('lib/client.js');
	check('bridge 的「会话找不到」翻译成可行动文案', /会话已失效（当前 Host 找不到/.test(host) && /用当前会话/.test(host));
	check('运行记录把会话失效显示成短句（不截半截 id）', /会话已失效（请重新绑定当前会话）/.test(cli));
	check('立即运行回执不再预设成「未绑会话」', /会话已失效时只记历史/.test(cli));
}

console.log('── 会话归属根治（0.9.0）──');
{
	// 2026-11-03 真机：任务绑的是 dev 的会话，在产品版 Host 里不存在 ⇒ bridge 抛一串 id。
	// 根治 = 写入盖章 + 投递前预检 + UI 可见；四条链路一节都不能少（用原文 read，别用 strip）。
	const host = read('lib/index.js');
	const cli = read('lib/client.js');
	const eng = read('lib/engine.js');
	const task = read('lib/core/task.js');
	const sb = read('lib/sessionBinding.js');
	check('归属模块：盖章 + 判定 + 存在性检查', /export function stampSession/.test(sb) && /export function bindingOf/.test(sb) && /export function sessionExists/.test(sb));
	check('创建盖章，且只在改 sessionId 时重盖', /stampSession\(raw, config\)/.test(eng) && /Object.hasOwn\(patch, 'sessionId'\)/.test(eng));
	check('normalizeTask 透传 sessionRoot', /payload.sessionRoot/.test(task));
	check('投递前预检（不发起注定失败的后台回合）', /bindingOf\(task, hostConfig\)/.test(host) && /会话归属校验未通过/.test(host));
	check('列表带出归属状态', /sessionBinding: b.state/.test(host));
	check('UI：卡片徽标 + 弹窗红字 + 重绑后清告警',
		/data-sched-binding/.test(cli) && /data-sched-binding-warn/.test(cli) && /setField\('sessionBinding', ''\)/.test(cli));
}

console.log('── cwd 归属重试（0.9.1，真因修复）──');
{
	// 17:15 那条 #8 的完整错误：session "X" belongs to "G:\…", not "C:\Users\qiuzijian"。
	// 会话**存在**，是 process.cwd() 与会话工作区不符 ⇒ 按报错里的真实工作区重试并缓存。
	const host = read('lib/index.js');
	const tsk = read('lib/core/task.js');
	check('runs.run 抽成 runOnce（可用不同 cwd 调）', /const runOnce = \(cwd\)/.test(host));
	check('从 belongs to 解析真实工作区并重试', /belongs to/.test(host) && /runOnce\(realCwd\)/.test(host));
	check('成功后把工作区缓存进 sessionCwd', /sessionCwd: realCwd/.test(host));
	check('normalizeTask 透传 sessionCwd', /payload.sessionCwd/.test(tsk));
	check('cwd 优先级：任务缓存 > config > process.cwd()', /task\.sessionCwd/.test(host) && /process\.cwd\(\)/.test(host));
	check('cwd 不符时有可行动文案', /cwd 与会话工作区不符/.test(host));
}

console.log(`\n[scheduler] ${pass} passing / ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
