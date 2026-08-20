/*---------------------------------------------------------------------------------------------
 *  Dynamic Workflow — schema subset validator (pure function)
 *
 *  agent(prompt, {schema}) 的 schema 受限子集（对齐 dsh assertObjectJsonSchema）：
 *  仅 type / properties / required / additionalProperties / items / enum / const / oneOf。
 *  不支持 pattern / format / 数值边界 / minItems / $ref —— 超集 fatal
 *  (UNSUPPORTED_SCHEMA)，模型可读原因后收敛 schema 重调。
 *
 *  host 侧在 worker 收到 child-start 时再次校验（脚本运行时传的 opts 无法预校验）。
 *  worker 源码内嵌同构实现（见 workflowWorkerMain.source.ts），语义由集成测试锁定一致。
 *--------------------------------------------------------------------------------------------*/

import { WorkflowError } from './types.js';

const ALLOWED_KEYS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'oneOf']);
const ALLOWED_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/**
 * 校验 schema 属于受限子集。违规抛 WorkflowError('UNSUPPORTED_SCHEMA')。
 * 注意：本函数校验的是「schema 词汇」而非「实例数据」——数据校验由子代理侧
 * StructuredOutputParser 执行（M1 桥内建）。
 */
export function assertObjectJsonSchema(schema: unknown, what = 'schema'): Record<string, unknown> {
	if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
		throw new WorkflowError(`${what} must be a JSON object`, 'UNSUPPORTED_SCHEMA');
	}
	_validateNode(schema as Record<string, unknown>, what, 0);
	return schema as Record<string, unknown>;
}

const MAX_DEPTH = 16;

function _validateNode(node: Record<string, unknown>, path: string, depth: number): void {
	if (depth > MAX_DEPTH) {
		throw new WorkflowError(`${path}: schema nesting exceeds depth ${MAX_DEPTH}`, 'UNSUPPORTED_SCHEMA');
	}
	for (const key of Object.keys(node)) {
		if (!ALLOWED_KEYS.has(key)) {
			throw new WorkflowError(`${path}: unsupported keyword "${key}" (allowed: ${[...ALLOWED_KEYS].join(', ')})`, 'UNSUPPORTED_SCHEMA');
		}
	}
	const t = node['type'];
	if (t !== undefined) {
		if (typeof t !== 'string' || !ALLOWED_TYPES.has(t)) {
			throw new WorkflowError(`${path}.type must be one of ${[...ALLOWED_TYPES].join(' | ')}`, 'UNSUPPORTED_SCHEMA');
		}
	}
	if (node['properties'] !== undefined) {
		if (typeof node['properties'] !== 'object' || node['properties'] === null || Array.isArray(node['properties'])) {
			throw new WorkflowError(`${path}.properties must be an object`, 'UNSUPPORTED_SCHEMA');
		}
		for (const [k, v] of Object.entries(node['properties'] as Record<string, unknown>)) {
			if (typeof v !== 'object' || v === null || Array.isArray(v)) {
				throw new WorkflowError(`${path}.properties.${k} must be a schema object`, 'UNSUPPORTED_SCHEMA');
			}
			_validateNode(v as Record<string, unknown>, `${path}.properties.${k}`, depth + 1);
		}
	}
	if (node['required'] !== undefined) {
		if (!Array.isArray(node['required']) || !(node['required'] as unknown[]).every(s => typeof s === 'string')) {
			throw new WorkflowError(`${path}.required must be a string array`, 'UNSUPPORTED_SCHEMA');
		}
	}
	if (node['additionalProperties'] !== undefined && typeof node['additionalProperties'] !== 'boolean' && typeof node['additionalProperties'] !== 'object') {
		throw new WorkflowError(`${path}.additionalProperties must be a boolean or schema object`, 'UNSUPPORTED_SCHEMA');
	}
	if (node['items'] !== undefined) {
		if (typeof node['items'] !== 'object' || node['items'] === null || Array.isArray(node['items'])) {
			throw new WorkflowError(`${path}.items must be a schema object`, 'UNSUPPORTED_SCHEMA');
		}
		_validateNode(node['items'] as Record<string, unknown>, `${path}.items`, depth + 1);
	}
	if (node['enum'] !== undefined) {
		if (!Array.isArray(node['enum'])) {
			throw new WorkflowError(`${path}.enum must be an array`, 'UNSUPPORTED_SCHEMA');
		}
	}
	if (node['const'] !== undefined && typeof node['const'] !== 'string' && typeof node['const'] !== 'number' && typeof node['const'] !== 'boolean' && node['const'] !== null) {
		throw new WorkflowError(`${path}.const must be a JSON scalar`, 'UNSUPPORTED_SCHEMA');
	}
	if (node['oneOf'] !== undefined) {
		if (!Array.isArray(node['oneOf']) || (node['oneOf'] as unknown[]).length === 0) {
			throw new WorkflowError(`${path}.oneOf must be a non-empty array`, 'UNSUPPORTED_SCHEMA');
		}
		(node['oneOf'] as unknown[]).forEach((v, i) => {
			if (typeof v !== 'object' || v === null || Array.isArray(v)) {
				throw new WorkflowError(`${path}.oneOf[${i}] must be a schema object`, 'UNSUPPORTED_SCHEMA');
			}
			_validateNode(v as Record<string, unknown>, `${path}.oneOf[${i}]`, depth + 1);
		});
	}
}
