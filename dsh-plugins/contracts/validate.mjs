// 群执行契约的最小校验器（dsh-plugins/contracts/group-activity.schema.json 用）。
// 只支持契约里用到的：type / required / properties / items / enum / const / nullable，以及 `$ref` 指向同文件 definitions 里的名字。
// 返回问题列表（空 = 通过），不抛错，方便守卫一次报全。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const contract = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'group-activity.schema.json'), 'utf8'));

const typeOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);

/** @returns 问题列表，例如 `["active[0].status：不在 enum 里（got=finished）"]` */
export function validate(schema, value, path = '$', defs = contract.definitions) {
	if (schema && schema.$ref) {
		const target = defs[schema.$ref];
		if (!target) { return [`${path}：未知的 $ref ${schema.$ref}`]; }
		if (schema.nullable && value === null) { return []; }
		return validate(target, value, path, defs);
	}
	const problems = [];
	if (!schema) { return problems; }
	if (schema.nullable && value === null) { return problems; }
	if (schema.type && typeOf(value) !== schema.type) { return [`${path}：应为 ${schema.type}（got=${typeOf(value)}）`]; }
	if ('const' in schema && value !== schema.const) { problems.push(`${path}：应为 ${JSON.stringify(schema.const)}（got=${JSON.stringify(value)}）`); }
	if (schema.enum && !schema.enum.includes(value)) { problems.push(`${path}：不在 enum 里（got=${JSON.stringify(value)}）`); }
	if (schema.type === 'object') {
		for (const key of schema.required ?? []) { if (!(key in value)) { problems.push(`${path}.${key}：缺少必填字段`); } }
		for (const [key, sub] of Object.entries(schema.properties ?? {})) {
			if (key in value && value[key] !== undefined) { problems.push(...validate(sub, value[key], `${path}.${key}`, defs)); }
		}
	}
	if (schema.type === 'array' && schema.items) {
		value.forEach((item, index) => { problems.push(...validate(schema.items, item, `${path}[${index}]`, defs)); });
	}
	return problems;
}

/** 按 definitions 里的名字校验。 */
export const check = (name, value) => validate({ $ref: name }, value, name);
