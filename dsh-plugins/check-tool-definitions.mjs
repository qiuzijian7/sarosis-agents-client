#!/usr/bin/env node
// 守卫：dsh 插件的工具定义必须完整（2026-10-21 事故后加）。
// 事故：vssaros-media 迁移 image_generate 时留下空对象壳 => register({}) 抛
//   tool 'undefined' must declare output { schema, render, presentationMeta? }
//   => preset 判 agent-preset/invalid => 用户连新建会话都做不了。
// 做法：伪 ctx 真跑每个插件的 apply，收集 register(def) 实参并按 dsh 同款规则校验。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NL = String.fromCharCode(10);
const DIR = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'dsh-plugins');

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
	p.push(...sp);
	return p;
}

/** 递归找 schema 里的"受限子集违规"。 */
function schemaBadness(schema, where, out) {
	if (!schema || typeof schema !== 'object' || Array.isArray(schema)) { return; }
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
for (const plugin of fs.readdirSync(DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()) {
	const entry = path.join(DIR, plugin, 'lib', 'index.js');
	if (!fs.existsSync(entry)) { continue; }
	let mod;
	try { mod = await import(pathToFileURL(entry).href); }
	catch (e) { console.log('SKIP ' + plugin + '：' + String(e?.message ?? e).split(NL)[0]); continue; }
	const apply = typeof mod.apply === 'function' ? mod.apply : (typeof mod.default === 'function' ? mod.default : undefined);
	if (!apply) { console.log('SKIP ' + plugin + '：没有 apply 导出'); continue; }
	const defs = [];
	const ctx = {
		inject: () => undefined,
		effect: (fn) => { try { return fn(); } catch (e) { return undefined; } },
		provide: () => undefined, get: () => undefined,
		// ⚠ `on` 必须有（2026-10-21 补）：dsh 插件普遍用 `ctx.on('llm/stream', …)` 这类事件订阅，
		//   假 ctx 缺它 ⇒ apply 在那一步就抛 ⇒ 该插件的**工具一条都抽不到** ⇒ 体检对它**完全失明** ✗
		//   （vssaros-bridge 就是这样被漏掉的：它注册的工具从没被这条守卫看过 ✗）。
		on: () => () => undefined,
		tools: { register: (d) => { defs.push(d); return () => undefined; } },
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
