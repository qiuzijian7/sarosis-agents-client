// @vssaros/dsh-scheduler — 包内自检（工作台模板 S15）。
//   跑法：node dsh-plugins/vssaros-scheduler/test/run-scheduler-check.mjs
//   两类断言：
//     ① 静态契约（清单 / patch / 入口 / 组件 / 共享层 / 容器查询 / 锚点 / 零 iframe）—— 与 check-workbench-style.mjs 同口径
//     ② 纯逻辑（migrate.toOfficialRequest：cron / one-shot / interval 的规范化与拒绝理由）
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { toOfficialRequest } from '../lib/migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const listLib = (dir = path.join(ROOT, 'lib'), out = []) => {
	for (const name of fs.readdirSync(dir)) {
		const p = path.join(dir, name);
		if (fs.statSync(p).isDirectory()) { listLib(p, out); } else if (name.endsWith('.js')) { out.push(p); }
	}
	return out;
};
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

console.log('── 入口与组件 ──');
const entry = strip(read('lib/client.js'));
check('入口不写 chunk: 字段', !/^\s*chunk\s*:/m.test(entry));
// 组件选法（2026-10-28 起，与 check-workbench-style.mjs 同口径）：
//   ① 入口自己就 register ⇒ 组件=入口；② 否则入口 `require.async('./client.X.js')` 装载的子块；
//   ③ 都没有才退回「候选里 wb-* 最多」。
// 为什么改：0.3.0 起 UI 搬进了子块 `client.native.js`（官方 chunk 副本，wb-* 只有 3 个），
// 旧启发式会选到**别的**文件 ⇒ 对着不是工作台的东西下结论。
const chunks = [...entry.matchAll(/require\.async\(\s*['"]\.\/(client\.[\w-]+\.js)['"]\s*\)/g)].map((m) => m[1]);
const relOf = (p) => p.replace(ROOT + path.sep, '').split(path.sep).join('/');
const candidates = listLib().map((p) => ({ rel: relOf(p), text: strip(fs.readFileSync(p, 'utf8')) }))
	.filter((x) => /desktopWorkbenches\.register\(/.test(x.text));
const componentFile = (entry && /desktopWorkbenches\.register\(/.test(entry) ? { rel: 'lib/client.js', text: entry } : null)
	|| candidates.find((x) => chunks.includes(x.rel.split('/').pop()))
	|| candidates.sort((a, b) => (b.text.match(/\bwb-[a-z-]+/g) || []).length - (a.text.match(/\bwb-[a-z-]+/g) || []).length)[0];
check('找到工作台组件（含 register）', !!componentFile, componentFile?.rel);
const src = componentFile?.text || '';
/** 未 strip 的原文：region 标记是 `//` 行注释，strip 之后判不出来。 */
const compRaw = componentFile ? read(componentFile.rel) : '';
/**
 * 原生承载型（0.3.0）：工作台内容 = 官方 `@deepseek-ai/dsh-client-ui-schedule` 的页面副本。
 * 对它不能再要求 wb-* 用量 / 工具条锚点 / @container（官方页自带 h1 与 CSS），
 * 改用「出处 + 真装载 + 真接官方组件」三条 —— 否则"搬运"会变成绕开约定的口子。
 */
const nativeHost = /#region\s+vssaros:\s*native workbench adapter/.test(compRaw);
check('描述符带 repository（vssaros:scheduler）', /repository:\s*['"]vssaros:scheduler['"]/.test(src));
check('根节点有 data-vssaros-surface="workbench"', /data-vssaros-surface['"]?\s*:\s*['"]workbench/.test(src));
check('≥3 个 data-* 锚点', new Set(src.match(/data-[a-z0-9-]{3,30}/g) || []).size >= 3);
check('零 iframe', !/<iframe|createElement\(['"]iframe/.test(src));
check('原生承载型（官方页副本）', nativeHost, nativeHost ? '是' : '否（自绘）');
if (nativeHost) {
	check('写明官方出处', src.includes('@deepseek-ai/dsh-client-ui-schedule'));
	check('写明 MIT 许可', /\bMIT\b/.test(compRaw));
	check('入口装载该子块', chunks.includes(componentFile.rel.split('/').pop()), chunks.join(','));
	check('入口调 install(ctx)', /\.install\(ctx\)/.test(entry));
	check('真的渲染官方 TaskManagerPage', /\bh\(TaskManagerPage,/.test(src));
	check('数据走官方 remote（ctx.remote.schedule）', /ctx\.remote\.schedule/.test(compRaw));
	check('文案用官方命名空间 schedule.manager', /locale\.bind\(\s*["']schedule\.manager["']\s*\)/.test(compRaw));
	// 描述符 ↔ 清单逐字一致（宿主 register 校验 + IDE 侧守卫 dshPluginPackages.test.ts 同口径）
	const desc = src.slice(src.indexOf('WB_DESCRIPTOR'), src.indexOf('const h = react.createElement'));
	for (const field of ['title', 'description', 'repository']) {
		const literal = new RegExp(field + ':\\s*' + (field === 'title' ? 'WB_TITLE' : '"([^"]+)"')).exec(desc);
		const expected = field === 'title' ? pkg.vssaros.workbench.title : pkg.vssaros.workbench[field];
		check(`描述符 ${field} 与清单同值`, !!literal && (field === 'title' ? expected === pkg.vssaros.workbench.title : literal[1] === expected), literal ? literal[1] : '未匹配');
	}
	check('描述符 customFrame 与清单同值', new RegExp('customFrame:\\s*' + String(pkg.vssaros.workbench.customFrame)).test(desc));
	check('描述符 headerLayout 与清单同值', desc.includes('headerLayout: "' + pkg.vssaros.workbench.headerLayout + '"'));
	check('files 里含子块 client.native.js', (pkg.files || []).includes('lib/' + componentFile.rel.split('/').pop()));
} else {
	check('工具条锚点恰好 1 个', (src.match(/data-dsh-workbench-toolbar/g) ?? []).length === 1);
	const wbClasses = new Set((src.match(/'wb(?:-[a-z0-9]+)*/g) || []).map((s) => s.slice(1)));
	check('用到 ≥10 个 wb-* 原语', wbClasses.size >= 10, wbClasses.size + ' 个');
	check('有 @container（窄栏重排）', /@container/.test(src));
}
const bare = src.split('\n').filter((l) => !l.includes('var(--') && (/(?<![&\w])#[0-9a-fA-F]{3,8}\b/.test(l) || /\b(rgba?|hsla?)\(/.test(l)));
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

console.log('── 装载契约：原生子块在 loader 契约下真跑一遍 ──');
{
	// 为什么要有这一段（2026-10-28）：工作台内容现在是搬运来的官方 chunk，
	// 出问题的形态全是"装得上但静默不生效"：子块 id 写错、factory 里的 require 名字拼错、
	// install 在注册期就去读还没就绪的服务 ⇒ 页面空白/整块不出现，而宿主**不报错**。
	// 这里用 vm 造一个假 loader + 假 React，把 factory 真跑一遍（不渲染）。
	const BLOCK = 'lib/client.native.js';
	const code = read(BLOCK);
	let def = null;
	const sandbox = {
		window: { __ModuleLoader__: { load(value) { def = value; } } },
		console: { log() {}, warn() {}, error() {} },
	};
	vm.createContext(sandbox);
	let loadError = '';
	try { vm.runInContext(code, sandbox, { filename: BLOCK }); } catch (error) { loadError = String(error && error.message || error); }
	check('子块能被装载（顶层不抛）', !loadError, loadError);
	check('子块声明了自己的 chunk 名', !!def && def.chunk === 'client.native.js', def && def.chunk);
	check('子块挂在入口同 id 下', !!def && def.id === pkg.name, def && def.id);

	const FakeReact = {
		createElement: () => null, useCallback: (fn) => fn, useState: (v) => [v, () => {}],
		useEffect() {}, useLayoutEffect() {}, useRef: () => ({ current: null }), useId: () => 'id',
		useMemo: (fn) => fn(), useSyncExternalStore: () => undefined, Fragment: 'Fragment',
		Component: class {}, memo: (c) => c,
	};
	const requireStub = (id) => {
		if (id === 'react') { return FakeReact; }
		if (id === 'react-dom') { return { createPortal: () => null }; }
		if (id === 'react/jsx-runtime') { return { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }; }
		if (id === '@deepseek-ai/dsh-client-ui-primitives') { return new Proxy({}, { get: () => () => null }); }
		throw new Error('未预期的 require：' + id);
	};
	let part = null;
	let factoryError = '';
	try { part = def.factory(requireStub); } catch (error) { factoryError = String(error && error.message || error); }
	check('factory 能执行（require 名都对）', !factoryError, factoryError);
	check('导出 install()', !!part && typeof part.install === 'function');
	check('静态 inject 留空（服务走可选注入）', !!part && Array.isArray(part.inject) && part.inject.length === 0, part && JSON.stringify(part.inject));

	const registrations = [];
	const injected = [];
	const child = {
		effect: (fn) => { const dispose = fn(); return dispose; },
		desktopWorkbenches: { register: (descriptor, Component) => { registrations.push({ descriptor, Component }); return () => {}; } },
		locale: { bind: () => (key) => String(key) },
		// ★ 关键：注册期**不该**碰 remote.schedule（懒创建）—— 这里放一个会抛的 getter，
		//   谁提前读就立刻红，而不是等到真机上"面板一片空白"。
		remote: Object.defineProperty({}, 'schedule', {
			get() { throw new Error('注册期读取 remote.schedule（应懒创建）'); },
		}),
		sessions: { list: { getSnapshot: () => ({}), subscribe: () => () => {} } },
		workspaces: { list: { getSnapshot: () => ({}), subscribe: () => () => {} } },
		uiWorkspace: { startSession() {}, openSession() {} },
		on: () => () => {},
	};
	const ctx = { inject: (deps, cb) => { injected.push(deps); cb(child); } };
	let installError = '';
	try { part.install(ctx); } catch (error) { installError = String(error && error.message || error); }
	check('install() 不抛（注册期不读未就绪服务）', !installError, installError);
	const sets = injected.map((deps) => [...deps]);
	const all = sets.flat();
	// ★★ 2026-10-28 真机事故：`remote.schedule` 是**独立服务键**，只注入 `remote` 时读它会抛
	//   `cannot get property "remote.schedule" without inject` ⇒ 工作台渲染成「加载失败」。
	//   所以这两条分开断言（只查 `remote` 会漏掉它）。
	check('注入集包含 remote', all.includes('remote'));
	check('注入集包含 remote.schedule（独立服务键）', all.includes('remote.schedule'), all.join(','));
	for (const needed of ['locale', 'uiWorkspace', 'sessions', 'workspaces']) {
		check('注入集包含 ' + needed, all.includes(needed));
	}
	// 两级结构：注册必须挂在「只依赖 desktopWorkbenches」的那一层 ⇒ 调度服务缺席时工作台仍然存在（显示不可用）。
	const wbSet = sets.find((deps) => deps.includes('desktopWorkbenches'));
	check('有只依赖 desktopWorkbenches 的注册层', !!wbSet && wbSet.length === 1, wbSet ? wbSet.join(',') : '无');
	check('服务层与注册层分开', !!wbSet && sets.some((deps) => !deps.includes('desktopWorkbenches') && deps.includes('remote.schedule')));
	check('真的注册了一个工作台', registrations.length === 1, registrations.length + ' 个');
	const reg = registrations[0];
	check('注册的组件是函数', !!reg && typeof reg.Component === 'function');
	const d = reg ? reg.descriptor : {};
	check('注册描述符 title 与清单同值', d.title === pkg.vssaros.workbench.title, d.title);
	check('注册描述符 repository 与清单同值', d.repository === pkg.vssaros.workbench.repository, d.repository);
	check('注册描述符 customFrame 与清单同值', d.customFrame === pkg.vssaros.workbench.customFrame, String(d.customFrame));
	check('注册描述符 headerLayout 与清单同值', d.headerLayout === pkg.vssaros.workbench.headerLayout, d.headerLayout);
}

console.log(`\n[scheduler] ${pass} passing / ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
