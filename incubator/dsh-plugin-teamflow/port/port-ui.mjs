// P3 · 上游客户端 UI 机械移植：client/*.tsx → workbench/lib/client.teamflow.ui.js（ModuleLoader 子块）。
//
// 做法与 port-core.mjs 同一条纪律：**不手工重写**。
//   1) Node 内置 module.stripTypeScriptTypes（strip 模式）剥类型 —— 上游 client 全是 React.createElement，0 处 JSX；
//   2) ES import/export → 子块内的迷你模块表（__defs/__req），所有顶层声明都导出（组件需单独渲染/自检）；
//   3) 三个**显式、锚点唯一**的补丁（见 PATCHES，锚点不存在或不唯一就失败）；
//   4) 宿主专属模块换成 shim：update-ui（无 registry 升级通道）/ locale-push（无 host 语言上报）/ descriptors（无 Remote）。
// 产物与源哈希写进 port/ui-manifest.json，run-check.mjs 第 6 组钉住漂移（禁止手改产物）。
//
// 用法：node port/port-ui.mjs

import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const OUT_REL = 'workbench/lib/client.teamflow.ui.js';
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** 依赖顺序无关（__req 惰性求值），按文件名列出即可。id = 上游 import 用的说明符。 */
const SOURCES = [
	{ rel: 'client/shared.tsx', id: './shared.js' },
	{ rel: 'client/viewport.ts', id: './viewport.js' },
	{ rel: 'client/bug-open-reason.ts', id: './bug-open-reason.js' },
	{ rel: 'client/locales.ts', id: './locales.js' },
	{ rel: 'client/panel.tsx', id: './panel.js' },
	{ rel: 'client/index.tsx', id: './index.js' },
];

const PATCHES = [
	{
		id: 'child-session-open',
		rel: 'client/index.tsx',
		why: '阶段会话是 vssarosRuns 起的独立会话（不是子代理）⇒ 按会话 id 直接打开，不用 parent/child 地址',
		find: "uiWorkspace.openSession({ parentSessionId: (ownerSession || sessionId), childSessionId: cur.childId, mode: 'unknown' })",
		replace: 'uiWorkspace.openSession(cur.childId) /* [vssaros-port] 独立会话按 id 打开 */',
	},
	{
		id: 'evidence-all-phases',
		rel: 'client/index.tsx',
		why: '验证证据不只 dev 有：验收阶段要并排显示独立验收者的证据（本移植的核心增强）',
		find: "(st && phaseKeyOf(st.phase) === 'dev') ? h('div'",
		replace: "(st && (phaseKeyOf(st.phase) === 'dev' || (cur && cur.verifyEvidence))) ? h('div'",
	},
	{
		id: 'inline-run-detail',
		rel: 'client/panel.tsx',
		why: '本插件不注册右侧栏 run tab（地址为空）⇒ 直接走面板内联详情，不弹「无地址」提示',
		find: "setHint(t('panel.hintNoAddress', { label }))",
		replace: "if (!fallback) setHint(t('panel.hintNoAddress', { label }))",
	},
	{
		id: 'team-selector-reload',
		rel: 'client/index.tsx',
		why: '团队可在工作台「团队配置」页增删改：选择器每次展开都重取列表（上游只在挂载时取一次，改完要切会话才看得到）',
		find: 'onClick: () => setOpen(!open),',
		replace: 'onClick: () => { if (!open) load(); setOpen(!open) }, /* [vssaros-port] 展开即重取 */',
	},
	{
		id: 'global-panel-embedded',
		rel: 'client/panel.tsx',
		why: '嵌入工作台外壳（props.embedded）时不渲染上游自带的标题栏：外壳已有唯一工具条（标题/回到对话/刷新），两条标题栏重复且「当前会话 session-」在工作台里没有意义',
		find: "h('div', { style: { ...flexRow, justifyContent: 'space-between', padding: '10px 14px', borderBottom: `1px solid ${T.border}` } },",
		replace: "props.embedded ? null : /* [vssaros-port] 嵌入外壳时隐藏 */ h('div', { style: { ...flexRow, justifyContent: 'space-between', padding: '10px 14px', borderBottom: `1px solid ${T.border}` } },",
	},
	{
		id: 'resume-needs-human',
		rel: 'client/index.tsx',
		why: '上游续跑按钮只认 interrupted/failed/cancelled，而服务掉线 / 独立验收未通过都会落到 needs-human ⇒ 真机上停线的 run 在界面上点不到「从断点重跑」。needs-human 只要还有未完成阶段就应可续跑',
		find: "const canResume = activeRun && activeRun.incompleteStages && (activeRun.status === 'interrupted' || activeRun.status === 'failed' || activeRun.status === 'cancelled')",
		replace: "const canResume = activeRun && activeRun.incompleteStages && (activeRun.status === 'interrupted' || activeRun.status === 'failed' || activeRun.status === 'cancelled' || activeRun.status === 'needs-human') /* [vssaros-port] 需人工同样可断点续跑 */",
	},
];

/** 宿主专属模块的替身（在子块里用 require('react') 取同一份 React）。 */
const SHIMS = `
__shims['react'] = () => require('react');
__shims['../descriptors.js'] = () => ({ TEAMFLOW_REMOTE_CONTRIBUTION: null });
__shims['./locale-push.js'] = () => ({ createLocalePusher: () => ({ send() {}, dispose() {} }) });
__shims['./update-ui.js'] = () => {
	const React = require('react');
	// 外部包没有 registry 升级通道：自动探测不报；手动「检查更新」如实显示「暂时查不到最新版本」。
	function useUpdateStatus(remote) {
		const [st, setSt] = React.useState(null);
		const recheck = () => {
			setSt({ outdated: false, current: null, latest: null, command: null, error: 'registry-unreachable' });
			return Promise.resolve();
		};
		return [st, setSt, recheck];
	}
	return {
		useUpdateStatus,
		UpgradeButton: () => null,
		UpdateHint: () => null,
		canOneClick: () => false,
		NO_WRAP: { whiteSpace: 'nowrap', flex: '0 0 auto' },
	};
};`;

function convertImports(code, rel) {
	return code.replace(/^import\s+(.+?)\s+from\s+['"]([^'"]+)['"]\s*;?[ \t]*$/gm, (_m, spec, from) => {
		const req = `__req(${JSON.stringify(from)})`;
		spec = spec.trim();
		if (spec.startsWith('* as ')) return `const ${spec.slice(5).trim()} = ${req};`;
		if (spec.startsWith('{')) {
			const inner = spec.slice(1, spec.lastIndexOf('}')).split(',').map((s) => s.trim()).filter(Boolean)
				.map((s) => s.replace(/^(\w+)\s+as\s+(\w+)$/, '$1: $2'));
			return `const { ${inner.join(', ')} } = ${req};`;
		}
		if (/^\w+$/.test(spec)) return `const ${spec} = ${req};`;
		throw new Error(`${rel}: 不认识的 import 形式：${spec}`);
	});
}

function convertExports(code, rel) {
	if (/^export\s+(default|\{|\*)/m.test(code)) throw new Error(`${rel}: 不支持的 export 形式（default / 列表 / 转发）`);
	return code.replace(/^export\s+(?=(async\s+)?function\s|const\s|let\s|var\s)/gm, '');
}

function topLevelNames(code) {
	const names = [];
	const add = (n) => { if (n && !names.includes(n)) names.push(n); };
	for (const m of code.matchAll(/^(?:async\s+)?function\s+(\w+)/gm)) add(m[1]);
	for (const m of code.matchAll(/^(?:const|let|var)\s+(\w+)\s*=/gm)) add(m[1]);
	return names;
}

const sources = {};
const blocks = [];
const applied = [];
for (const src of SOURCES) {
	const raw = readFileSync(join(ROOT, src.rel));
	sources[src.rel] = sha(raw);
	let code = stripTypeScriptTypes(raw.toString('utf8'), { mode: 'strip' });
	for (const p of PATCHES.filter((x) => x.rel === src.rel)) {
		const n = code.split(p.find).length - 1;
		if (n !== 1) throw new Error(`补丁 ${p.id}：锚点在 ${p.rel} 里出现 ${n} 次（必须恰好 1 次）——上游已变，需重新评估补丁`);
		code = code.replace(p.find, p.replace);
		applied.push(p.id);
	}
	code = convertExports(convertImports(code, src.rel), src.rel);
	if (/^(import|export)\s/m.test(code)) throw new Error(`${src.rel}: 仍残留 import/export 语句`);
	for (const reserved of ['module', 'exports', '__req']) {
		if (new RegExp(`^(?:const|let|var|function)\\s+${reserved}\\b`, 'm').test(code)) throw new Error(`${src.rel}: 顶层声明与包装器保留名冲突：${reserved}`);
	}
	const names = topLevelNames(code);
	blocks.push(`// ── ${src.rel}（sha256 ${sources[src.rel].slice(0, 12)}）──\n__defs[${JSON.stringify(src.id)}] = function (module, exports, __req) {\n'use strict';\n${code}\nmodule.exports = { ${names.join(', ')} };\n};`);
}
if (applied.length !== PATCHES.length) throw new Error(`补丁未全部应用：${applied.join(',')}`);

const manifest = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8'));
const header = `// GENERATED by incubator/dsh-plugin-teamflow/port/port-ui.mjs —— 请勿手改（run-check.mjs 第 6 组按哈希拦截）。
// 上游 dsh-plugin-teamflow@${manifest.upstreamHead.slice(0, 12)} 的 client/*.tsx：剥类型 + 模块表包装 + ${PATCHES.length} 个显式补丁（${PATCHES.map((p) => p.id).join(' / ')}）。
// 宿主专属模块已换 shim：update-ui / locale-push / descriptors。
`;
const out = `${header}window.__ModuleLoader__.load({
	id: 'dsh-teamflow-workbench',
	chunk: 'client.teamflow.ui.js',
	factory: (require) => {
		const __defs = {};
		const __shims = {};
		const __cache = {};
		function __req(id) {
			if (Object.prototype.hasOwnProperty.call(__cache, id)) return __cache[id].exports;
			if (__shims[id]) { __cache[id] = { exports: __shims[id]() }; return __cache[id].exports; }
			const def = __defs[id];
			if (!def) throw new Error('[teamflow-ui] 未知模块：' + id);
			const module = { exports: {} };
			__cache[id] = module;
			def(module, module.exports, __req);
			return module.exports;
		}
${SHIMS}

${blocks.join('\n\n')}

		const index = __req('./index.js');
		const panel = __req('./panel.js');
		const shared = __req('./shared.js');
		const locales = __req('./locales.js');
		return {
			TeamFlowView: index.TeamFlowView,
			TeamSelector: index.TeamSelector,
			PipelinePanel: index.PipelinePanel,
			BoardPanel: index.BoardPanel,
			GlobalPanel: panel.GlobalPanel,
			RunDetailPane: panel.RunDetailPane,
			ItemDetailPane: panel.ItemDetailPane,
			index, panel, shared, locales,
		};
	},
});
`;
writeFileSync(join(ROOT, OUT_REL), out);
const uiManifest = {
	schema: 1,
	upstreamHead: manifest.upstreamHead,
	generator: 'port/port-ui.mjs',
	output: OUT_REL,
	outputSha256: sha(Buffer.from(out)),
	sources,
	patches: PATCHES.map(({ id, rel, why }) => ({ id, rel, why })),
	shims: ['react', '../descriptors.js', './locale-push.js', './update-ui.js'],
};
writeFileSync(join(HERE, 'ui-manifest.json'), `${JSON.stringify(uiManifest, null, 2)}\n`);
console.log(`[port-ui] upstream=${manifest.upstreamHead.slice(0, 12)} modules=${SOURCES.length} patches=${applied.length} out=${OUT_REL} (${(out.length / 1024).toFixed(1)} KB)`);
