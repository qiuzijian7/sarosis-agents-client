/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 测试所有 bundled 工具定义（BUNDLED_TOOL_DEFINITIONS）与 toolset 映射（BUNDLED_TOOLSETS）。
 *
 * 覆盖三类不变量，作为工具增删/清理的回归护栏：
 *   1. 每个工具定义的结构合法性（name / description / inputSchema / required / category）。
 *   2. catalog 与 toolset 的双向一致性（无孤儿、无重复、category 与 toolset 对齐）。
 *   3. registerBundledTools 运行时行为（stub 注册、原生工具优先、handler 返回合法结果）。
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BUNDLED_TOOL_DEFINITIONS, BUNDLED_TOOLSETS } from '../../common/bundled-tools/bundledTools.js';
import { registerBundledTools } from '../../browser/providers/tool/bundledTools.js';
import { getToolsetForTool, TOOLSET_DEFINITIONS } from '../../common/toolsetConfig.js';

/** 已知的安全等级取值（与 providers.ts 的 ToolSecurityLevel 保持一致）。 */
const KNOWN_SECURITY_LEVELS = new Set(['safe', 'cautious', 'dangerous']);

/** 工具名命名规范：小写字母开头，仅含小写字母/数字/下划线。 */
const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/;

suite('Agent Studio - Bundled Tools (all tools)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const catalogNames = BUNDLED_TOOL_DEFINITIONS.map(d => d.name);
	const nameSet = new Set(catalogNames);

	// ─── 1. 每个工具定义的结构合法性 ─────────────────────────────────

	test('catalog is non-empty and has no duplicate tool names', () => {
		assert.ok(BUNDLED_TOOL_DEFINITIONS.length > 0, 'catalog must not be empty');
		assert.strictEqual(
			catalogNames.length,
			nameSet.size,
			`duplicate tool names detected: ${catalogNames.filter((n, i) => catalogNames.indexOf(n) !== i).join(', ')}`,
		);
	});

	test('every tool has a valid name, description, and category', () => {
		for (const def of BUNDLED_TOOL_DEFINITIONS) {
			assert.ok(TOOL_NAME_RE.test(def.name), `tool name "${def.name}" violates naming convention`);
			assert.ok(typeof def.description === 'string' && def.description.trim().length > 0,
				`tool "${def.name}" must have a non-empty description`);
			assert.ok(typeof def.category === 'string' && def.category.length > 0,
				`tool "${def.name}" must have a non-empty category`);
		}
	});

	test('every tool has a valid object inputSchema', () => {
		for (const def of BUNDLED_TOOL_DEFINITIONS) {
			const schema = def.inputSchema;
			assert.ok(schema && typeof schema === 'object' && !Array.isArray(schema),
				`tool "${def.name}" inputSchema must be an object`);
			assert.strictEqual((schema as any).type, 'object',
				`tool "${def.name}" inputSchema.type must be "object"`);
			assert.ok((schema as any).properties && typeof (schema as any).properties === 'object',
				`tool "${def.name}" inputSchema must declare a properties object`);

			const props = (schema as any).properties as Record<string, unknown>;
			// required（若存在）必须是非空数组，且每个字段都存在于 properties 中、无重复。
			if ('required' in schema && (schema as any).required !== undefined) {
				const required = (schema as any).required as unknown[];
				assert.ok(Array.isArray(required) && required.length > 0,
					`tool "${def.name}" required must be a non-empty array`);
				const reqSet = new Set<string>();
				for (const r of required) {
					assert.ok(typeof r === 'string', `tool "${def.name}" required entries must be strings`);
					assert.ok(r in props, `tool "${def.name}" required field "${r}" missing from properties`);
					assert.ok(!reqSet.has(r), `tool "${def.name}" required field "${r}" is duplicated`);
					reqSet.add(r);
				}
			}
		}
	});

	test('every inputSchema property is well-formed', () => {
		for (const def of BUNDLED_TOOL_DEFINITIONS) {
			const props = ((def.inputSchema as any).properties ?? {}) as Record<string, any>;
			for (const [propName, prop] of Object.entries(props)) {
				assert.ok(prop && typeof prop === 'object',
					`tool "${def.name}" property "${propName}" must be an object`);
				const hasShape = 'type' in prop || 'enum' in prop || 'items' in prop
					|| '$ref' in prop || 'anyOf' in prop || 'oneOf' in prop;
				assert.ok(hasShape,
					`tool "${def.name}" property "${propName}" must declare a type/enum/items/$ref`);
				if ('enum' in prop) {
					assert.ok(Array.isArray(prop.enum) && prop.enum.length > 0,
						`tool "${def.name}" property "${propName}" enum must be a non-empty array`);
				}
			}
		}
	});

	test('securityLevel (when present) is a recognized value', () => {
		for (const def of BUNDLED_TOOL_DEFINITIONS) {
			if (def.securityLevel !== undefined) {
				assert.ok(KNOWN_SECURITY_LEVELS.has(def.securityLevel),
					`tool "${def.name}" has unknown securityLevel "${def.securityLevel}"`);
			}
		}
	});

	// ─── 2. catalog 与 toolset 的双向一致性 ───────────────────────────

	test('every toolset references only existing tools (no dangling references)', () => {
		for (const [toolsetId, ts] of Object.entries(BUNDLED_TOOLSETS)) {
			assert.ok(Array.isArray(ts.tools), `toolset "${toolsetId}" must have a tools array`);
			const seen = new Set<string>();
			for (const toolName of ts.tools) {
				assert.ok(nameSet.has(toolName),
					`toolset "${toolsetId}" references unknown tool "${toolName}"`);
				assert.ok(!seen.has(toolName), `toolset "${toolsetId}" lists "${toolName}" twice`);
				seen.add(toolName);
			}
		}
	});

	test('every catalog tool is referenced by exactly one toolset and its category matches', () => {
		// name -> toolset 映射（用于检测跨 toolset 重复）
		const toolToToolset = new Map<string, string>();
		let totalReferenced = 0;
		for (const [toolsetId, ts] of Object.entries(BUNDLED_TOOLSETS)) {
			for (const toolName of ts.tools) {
				totalReferenced++;
				const prev = toolToToolset.get(toolName);
				assert.ok(prev === undefined,
					`tool "${toolName}" is referenced by multiple toolsets: ${prev}, ${toolsetId}`);
				toolToToolset.set(toolName, toolsetId);
			}
		}

		// catalog 与 toolset 引用必须一一对应（无孤儿、无遗漏）
		assert.strictEqual(totalReferenced, BUNDLED_TOOL_DEFINITIONS.length,
			'toolset tools count must equal catalog size (no orphan / no missing)');

		for (const def of BUNDLED_TOOL_DEFINITIONS) {
			const owning = toolToToolset.get(def.name);
			assert.ok(owning !== undefined, `tool "${def.name}" is not referenced by any toolset`);
			assert.strictEqual(owning, def.category,
				`tool "${def.name}" category "${def.category}" does not match owning toolset "${owning}"`);
		}
	});

	// ─── 3. toolsetConfig 能对每一个 bundled 工具分类 ────────────────

	test('getToolsetForTool classifies every bundled tool into a known toolset', () => {
		const knownIds = new Set(TOOLSET_DEFINITIONS.map(t => t.id));
		for (const name of catalogNames) {
			const inferred = getToolsetForTool(name);
			assert.ok(knownIds.has(inferred),
				`tool "${name}" classified into unknown toolset "${inferred}"`);
		}
	});

	// ─── 4. registerBundledTools 运行时行为 ─────────────────────────

	function makeContext(hasTool: (name: string) => boolean) {
		const registrations: Array<{
			definition: any;
			handler: (args: any) => Promise<Array<{ type: string; text: string }>>;
			isStub: boolean;
		}> = [];
		const ctx = {
			register: (reg: any) => { registrations.push(reg); },
			logService: { info: () => { /* no-op */ }, warn: () => { /* no-op */ }, error: () => { /* no-op */ } },
			hasTool,
		};
		return { ctx, registrations };
	}

	test('registers a stub for every tool except delegate_task and handler-provided tools', () => {
		const { ctx, registrations } = makeContext(() => false);
		registerBundledTools(ctx as any);

		assert.ok(registrations.length > 0, 'should register stubs');
		const regNames = registrations.map(r => r.definition.name);
		const regSet = new Set(regNames);

		// 不重复注册
		assert.strictEqual(regNames.length, regSet.size, 'registered tool names must be unique');
		// delegate_task 有真实 handler，不应注册 stub
		assert.ok(!regSet.has('delegate_task'), 'delegate_task must not be registered as a stub');
		// 所有注册名都来自 catalog
		for (const n of regNames) {
			assert.ok(nameSet.has(n), `registered name "${n}" is not in the catalog`);
		}
		// 每个注册项结构合法
		for (const reg of registrations) {
			assert.strictEqual(reg.isStub, true, `tool "${reg.definition.name}" stub must be flagged isStub`);
			assert.strictEqual(reg.definition.source, 'saros.builtin-tools',
				`tool "${reg.definition.name}" must carry the builtin source`);
			assert.ok(typeof reg.handler === 'function', `tool "${reg.definition.name}" must have a handler`);
			// definition 是 catalog 条目的展开（含 source 覆盖）
			const src = BUNDLED_TOOL_DEFINITIONS.find(d => d.name === reg.definition.name)!;
			assert.strictEqual(reg.definition.name, src.name);
			assert.strictEqual(reg.definition.description, src.description);
		}
	});

	test('respects hasTool override (native tools take precedence)', () => {
		const { ctx, registrations } = makeContext((name) => name === 'terminal');
		registerBundledTools(ctx as any);

		const regNames = registrations.map(r => r.definition.name);
		assert.ok(!regNames.includes('terminal'), 'terminal should be skipped when hasTool returns true');
		assert.ok(regNames.includes('web_search'), 'web_search should still be registered');
	});

	test('every registered stub handler returns a well-formed text result', async () => {
		const { ctx, registrations } = makeContext(() => false);
		registerBundledTools(ctx as any);

		for (const reg of registrations) {
			const result = await reg.handler({});
			assert.ok(Array.isArray(result) && result.length > 0,
				`tool "${reg.definition.name}" handler must return a non-empty result array`);
			const first = result[0] as any;
			assert.strictEqual(first.type, 'text', `tool "${reg.definition.name}" result[0] must be text`);
			assert.ok(typeof first.text === 'string' && first.text.length > 0,
				`tool "${reg.definition.name}" result text must be a non-empty string`);
		}
	});
});
