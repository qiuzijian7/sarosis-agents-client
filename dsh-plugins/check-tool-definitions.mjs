#!/usr/bin/env node
// 守卫：dsh 插件的工具定义必须完整（2026-10-21 事故后加）。
// 事故：vssaros-media 迁移 image_generate 时留下空对象壳 => register({}) 抛
//   tool 'undefined' must declare output { schema, render, presentationMeta? }
//   => preset 判 agent-preset/invalid => 用户连新建会话都做不了。
// 做法：伪 ctx 真跑每个插件的 apply，收集 register(def) 实参并按 dsh 同款规则校验。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NL = String.fromCharCode(10);
const DIR = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'dsh-plugins');

/**
 * ★ 2026-11-08：能找到 dsh 运行时就**真跑官方的 assertSupportedJsonSchema**。
 *   静态白名单是我们照抄的口径，官方函数才是真源（它还会查 required 是否指向真实属性、
 *   oneOf 兄弟关键字、注解是否无损 JSON 等）。干净检出没有运行时 ⇒ 退回静态判据，守卫仍可用。
 */
let officialSchemaCheck = null;
try {
	const rtRoot = path.join(os.homedir(), '.vssaros-dev/dsh-runtime');
	for (const v of fs.readdirSync(rtRoot).sort().reverse()) {
		const entry = path.join(rtRoot, v, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
		if (!fs.existsSync(entry)) { continue; }
		const mod = await import(pathToFileURL(entry).href);
		if (typeof mod.assertSupportedJsonSchema === 'function') { officialSchemaCheck = mod.assertSupportedJsonSchema; break; }
	}
} catch { /* 没有运行时：静态判据兜底 */ }
function officialBadness(schema, where, out) {
	if (!officialSchemaCheck || !schema || typeof schema !== 'object') { return; }
	try { officialSchemaCheck(schema); }
	catch (e) { out.push(where + ' 未通过运行时官方校验：' + String(e?.message ?? e).slice(0, 300)); }
}

function badness(def) {
	if (!def || typeof def !== 'object') { return ['定义不是对象']; }
	const p = [];
	if (typeof def.name !== 'string' || !def.name.trim()) { p.push('name 缺失'); }
	const o = def.output;
	if (!o || typeof o !== 'object') { return p.concat('output 缺失'); }
	if (typeof o.render !== 'function') { p.push('output.render 必须是函数'); }
	if (!o.schema || typeof o.schema !== 'object') { p.push('output.schema 必须是对象'); }
	// ★ 2026-10-27（白屏事故后加）：dsh 的 JSON Schema 是**受限子集**，
	//   `additionalProperties` 只能是**布尔**；写成对象 schema 会抛
	//   `unsupported JSON schema: … additionalProperties must be a boolean`
	//   ⇒ **整个插件不挂载**（工具没有、页面路由也没有 ⇒ 媒体库白屏，且没有任何报错）。
	//   先例：`vssaros-workflow/lib/index.js` 里的注释。
	const sp = [];
	schemaBadness(def.parameters, 'parameters', sp);
	schemaBadness(o.schema, 'output.schema', sp);
	officialBadness(def.parameters, 'parameters', sp);
	officialBadness(o.schema, 'output.schema', sp);
	p.push(...new Set(sp));
	return p;
}

/**
 * 与运行时 `dsh-tools/lib/index.js` 的 `assertSupportedJsonSchema` **同一口径**（2026-11-08）：
 * 每个 schema 节点的键只能是 8 个约束关键字 + 4 个注解关键字，多一个就抛
 * `unsupported JSON schema: schema.<key> is not a supported keyword` ⇒ 工具注册整个失败、
 * 插件 apply 抛错（真机事故：P1 把 truncated/attachmentPath 写到了 output.schema 顶层）。
 * ⚠ 这个白名单在 0.2.1-alpha.3 与 0.2.1-rc.2 里逐字相同；运行时升级时要同步核对。
 */
const SCHEMA_CONSTRAINT_KEYS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']);
const SCHEMA_ANNOTATION_KEYS = new Set(['description', 'title', 'default', 'examples']);

/** 递归找 schema 里的"受限子集违规"。 */
function schemaBadness(schema, where, out) {
	if (!schema || typeof schema !== 'object' || Array.isArray(schema)) { return; }
	// ① 未知关键字（含把属性名误写到 schema 顶层）：运行时会直接拒绝整个工具
	for (const key of Object.keys(schema)) {
		if (!SCHEMA_CONSTRAINT_KEYS.has(key) && !SCHEMA_ANNOTATION_KEYS.has(key)) {
			out.push(where + '.' + key + ' 不是受支持的 schema 关键字（受限子集：type/oneOf/properties/required/additionalProperties/items/enum/const + 注解；属性定义必须放在 properties 里 ⇒ 否则整个插件不挂载）');
		}
	}
	if (Object.prototype.hasOwnProperty.call(schema, 'additionalProperties')
		&& typeof schema.additionalProperties !== 'boolean') {
		out.push(where + '.additionalProperties 必须是布尔（写成对象 schema ⇒ 整个插件不挂载）');
	}
	for (const [key, v] of Object.entries(schema)) {
		if (!v || typeof v !== 'object') { continue; }
		if (key === 'properties') {
			for (const [k, sub] of Object.entries(v)) { schemaBadness(sub, where + '.properties.' + k, out); }
		} else if (key === 'items') {
			schemaBadness(v, where + '.items', out);
		} else if (key === 'oneOf' && Array.isArray(v)) {
			v.forEach((s, i) => schemaBadness(s, where + '.oneOf[' + i + ']', out));
		}
	}
}

let total = 0, bad = 0;
// 2026-11-03：vssaros-memory 的 apply() 硬注入 Host 的 7 个 cordis 服务，离线伪 ctx 装不起来
// ⇒ 与 tools-snapshot.mjs 同口径显式跳过（真机激活由 /memory-evolve/api/config + host 日志验证），
// 避免每次体检刷一条 ERR 噪音；其它插件仍照常体检。
// vssaros-superagent（2026-11-05）同理：async apply + 状态目录锁 + 会话级工具 ⇒ 离线不可跑。
const OFFLINE_UNSUPPORTED = new Set(['vssaros-memory', 'vssaros-superagent']);
for (const plugin of fs.readdirSync(DIR, { withFileTypes: true }).filter(d => d.isDirectory() && !OFFLINE_UNSUPPORTED.has(d.name)).map(d => d.name).sort()) {
	const entry = path.join(DIR, plugin, 'lib', 'index.js');
	if (!fs.existsSync(entry)) { continue; }
	let mod;
	try { mod = await import(pathToFileURL(entry).href); }
	catch (e) { console.log('SKIP ' + plugin + '：' + String(e?.message ?? e).split(NL)[0]); continue; }
	const apply = typeof mod.apply === 'function' ? mod.apply : (typeof mod.default === 'function' ? mod.default : undefined);
	if (!apply) { console.log('SKIP ' + plugin + '：没有 apply 导出'); continue; }
	const defs = [];
	const register = (d) => { defs.push(d); return () => undefined; };
	// ★ 2026-11-08（真机事故）：`inject` 以前是空函数 ⇒ 插件把工具注册在
	//   `ctx.inject(['tools'], …)` 回调里时（vssaros-skills 就是），守卫**一个定义都抽不到**，
	//   128 个工具 0 问题是假绿：P1 把非法字段写进 output.schema 顶层，真机 apply 直接抛
	//   JsonSchemaError，守卫却全绿。现在让 inject 真执行回调，并给一份最小服务集。
	const injectScope = {
		tools: { register, schemas: () => [], get: () => undefined, restrict: () => () => undefined, on: () => () => undefined },
		skills: { snapshot: async () => ({ complete: false, skills: [] }), registerProvider: () => () => undefined },
		agents: { effect: (fn) => { try { return fn(); } catch { return () => undefined; } } },
		effect: (fn) => { try { return fn(); } catch { return undefined; } },
		on: () => () => undefined,
		logger: { info() {}, warn() {}, error() {} },
	};
	const ctx = {
		inject: (_deps, fn) => { try { return fn(injectScope); } catch { return undefined; } },
		effect: (fn) => { try { return fn(); } catch (e) { return undefined; } },
		provide: () => undefined, get: () => undefined,
		// ⚠ `on` 必须有（2026-10-21 补）：dsh 插件普遍用 `ctx.on('llm/stream', …)` 这类事件订阅，
		//   假 ctx 缺它 ⇒ apply 在那一步就抛 ⇒ 该插件的**工具一条都抽不到** ⇒ 体检对它**完全失明** ✗
		//   （vssaros-bridge 就是这样被漏掉的：它注册的工具从没被这条守卫看过 ✗）。
		on: () => () => undefined,
		tools: injectScope.tools,
		logger: injectScope.logger,
	};
	try { apply(ctx, {}); } catch (e) { console.log('ERR ' + plugin + '：' + String(e?.message ?? e).split(NL)[0]); }
	for (const d of defs) {
		total++;
		const p = badness(d);
		if (p.length) { bad++; console.log('BAD ' + plugin + '：工具 ' + JSON.stringify(d && d.name) + ' — ' + p.join('；')); }
	}
	console.log('ok  ' + plugin + '：' + defs.length + ' 个工具定义');
}
console.log('共 ' + total + ' 个工具定义，问题 ' + bad + ' 个');
process.exit(bad > 0 ? 1 : 0);
