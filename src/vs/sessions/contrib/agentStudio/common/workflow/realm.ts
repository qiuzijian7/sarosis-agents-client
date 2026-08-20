/*---------------------------------------------------------------------------------------------
 *  Dynamic Workflow — realm materialization (pure function)
 *
 *  移植 dsh `workflow-worker-thread/realm.ts` 的 materializeFromRealm 算法：
 *  脚本 return 值 / agent() opts / nodeOutput() 结果离开脚本环境时，只放行
 *  plain JSON。拒绝函数/symbol/循环引用/稀疏数组/非有限数/Map/Set/Date 等 ——
 *  违规抛 MaterializeError（worker 侧包装为 RESULT_UNSERIALIZABLE fatal）。
 *
 *  本文件是 host/worker 共享语义的普通 TS 实现（host 单测 + 语义基准）；
 *  worker 源码内嵌同构实现（workflowWorkerMain.source.ts），一致性由集成测试锁定。
 *  设计文档：doc/Dynamic-Workflow-Integration-Design.md §3.2.3。
 *--------------------------------------------------------------------------------------------*/

/** 物化失败（携带 JSON 路径）。 */
export class MaterializeError extends Error {
	constructor(message: string, readonly path: string) {
		super(`${path}: ${message}`);
		this.name = 'MaterializeError';
	}
}

const MAX_MATERIALIZE_DEPTH = 64;

/**
 * 物化脚本环境中的值为 plain JSON（深拷贝语义：返回值与输入无引用共享）。
 * @param value 脚本 return 的原始值
 * @param what  错误消息中的名词（"workflow result" / "agent() options"）
 */
export function materializeFromRealm(value: unknown, what: string): unknown {
	try {
		return _materialize(value, '$', new WeakSet<object>(), 0);
	} catch (e) {
		if (e instanceof MaterializeError) {
			// 顶层包装带语境（dsh 同款消息形态）
			throw new MaterializeError(`${what}: ${e.message}`, e.path);
		}
		throw e;
	}
}

function _materialize(v: unknown, path: string, seen: WeakSet<object>, depth: number): unknown {
	if (v === null || v === undefined) { return null; }                    // undefined → null（JSON 语义）
	switch (typeof v) {
		case 'boolean': return v;
		case 'string': return v;
		case 'number':
			if (!Number.isFinite(v)) {
				throw new MaterializeError(`non-finite number (${String(v)}) is not JSON`, path);
			}
			// 整数化 -0 → 0（JSON.stringify(-0)==="0"，保持一致）
			return v === 0 ? 0 : v;
		case 'bigint':
			throw new MaterializeError('bigint is not JSON', path);
		case 'symbol':
			throw new MaterializeError('symbol is not JSON', path);
		case 'function':
			throw new MaterializeError('function is not JSON', path);
		case 'object': break;
		default:
			throw new MaterializeError(`unsupported typeof "${typeof v}"`, path);
	}
	const obj = v as object;
	if (seen.has(obj)) {
		throw new MaterializeError('circular reference', path);
	}
	if (depth > MAX_MATERIALIZE_DEPTH) {
		throw new MaterializeError(`nesting exceeds depth ${MAX_MATERIALIZE_DEPTH}`, path);
	}
	if (Array.isArray(obj)) {
		seen.add(obj);
		const n = obj.length;
		const out = new Array<unknown>(n);
		for (let i = 0; i < n; i++) {
			if (!(i in obj)) {
				throw new MaterializeError(`sparse array (hole at index ${i})`, `${path}[${i}]`);
			}
			out[i] = _materialize(obj[i], `${path}[${i}]`, seen, depth + 1);
		}
		seen.delete(obj);
		return out;
	}
	// 只接受 plain object（原型为 null / 本 realm Object.prototype / 跨 realm plain object
	// —— 后者 proto.constructor.name === 'Object'，见 worker 侧同构实现的注释）
	const proto = Object.getPrototypeOf(obj);
	const isPlain = proto === null || proto === Object.prototype
		|| (proto as { constructor?: { name?: string } }).constructor?.name === 'Object';
	if (!isPlain) {
		const name = (proto as { constructor?: { name?: string } }).constructor?.name ?? 'custom';
		throw new MaterializeError(`${name} instance is not plain JSON (only plain objects/arrays)`, path);
	}
	seen.add(obj);
	const out: Record<string, unknown> = {};
	for (const [k, val] of Object.entries(obj)) {
		out[k] = _materialize(val, `${path}.${k}`, seen, depth + 1);
	}
	seen.delete(obj);
	return out;
}
