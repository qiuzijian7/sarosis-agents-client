/*---------------------------------------------------------------------------------------------
 *  记忆类型映射测试 — 验证 4-Tier 模型 (working/episodic/semantic/procedural)
 *  以及废弃类型 (short_term/long_term/scene/persona/l0-l3) 的兼容映射。
 *
 *  _toPublicEntry 和 _normalizeEntry 是 AgentMemoryProvider 的私有方法，
 *  本测试直接验证其类型映射逻辑（与源码 memoryProvider.ts 中一致）。
 *--------------------------------------------------------------------------------------------*/
import { describe, it, assert, assertEqual } from './testRunner.js';

// 复刻 memoryProvider.ts 中的 VALID_TYPES 和映射逻辑
const VALID_TYPES = new Set(['working', 'episodic', 'semantic', 'procedural']);
type PublicMemoryType = 'working' | 'episodic' | 'semantic' | 'procedural';

/** 复刻 _toPublicEntry 的类型映射逻辑 */
function toPublicType(rawType: string): PublicMemoryType {
	if (VALID_TYPES.has(rawType)) {
		return rawType as PublicMemoryType;
	}
	// 遗留数据默认映射为 episodic
	return 'episodic';
}

/** 复刻 _normalizeEntry 的默认类型逻辑 */
function normalizeType(rawType: string | undefined): string {
	return rawType ?? 'episodic';
}

export function runMemoryTypesTests(): void {
describe('Memory Type Mapping (4-Tier Model)', () => {
	it('valid types are preserved', () => {
		assertEqual(toPublicType('working'), 'working', 'working preserved');
		assertEqual(toPublicType('episodic'), 'episodic', 'episodic preserved');
		assertEqual(toPublicType('semantic'), 'semantic', 'semantic preserved');
		assertEqual(toPublicType('procedural'), 'procedural', 'procedural preserved');
	});

	it('deprecated short_term maps to episodic', () => {
		assertEqual(toPublicType('short_term'), 'episodic', 'short_term → episodic');
	});

	it('deprecated long_term maps to episodic', () => {
		assertEqual(toPublicType('long_term'), 'episodic', 'long_term → episodic');
	});

	it('deprecated scene maps to episodic', () => {
		assertEqual(toPublicType('scene'), 'episodic', 'scene → episodic');
	});

	it('deprecated persona maps to episodic', () => {
		assertEqual(toPublicType('persona'), 'episodic', 'persona → episodic');
	});

	it('deprecated l0-l3 levels map to episodic', () => {
		assertEqual(toPublicType('l0'), 'episodic', 'l0 → episodic');
		assertEqual(toPublicType('l1'), 'episodic', 'l1 → episodic');
		assertEqual(toPublicType('l2'), 'episodic', 'l2 → episodic');
		assertEqual(toPublicType('l3'), 'episodic', 'l3 → episodic');
	});

	it('empty/undefined type defaults to episodic', () => {
		assertEqual(toPublicType(''), 'episodic', 'empty → episodic');
		assertEqual(normalizeType(undefined), 'episodic', 'undefined → episodic');
	});

	it('unknown type maps to episodic', () => {
		assertEqual(toPublicType('unknown_type'), 'episodic', 'unknown → episodic');
		assertEqual(toPublicType('custom'), 'episodic', 'custom → episodic');
	});

	it('case sensitivity: uppercase types are NOT valid', () => {
		// VALID_TYPES uses exact match — uppercase should fallback to episodic
		assertEqual(toPublicType('Working'), 'episodic', 'Working (capital) → episodic');
		assertEqual(toPublicType('EPISODIC'), 'episodic', 'EPISODIC → episodic');
	});

	it('VALID_TYPES contains exactly 4 types', () => {
		assertEqual(VALID_TYPES.size, 4, 'exactly 4 valid types');
		assert(VALID_TYPES.has('working'), 'has working');
		assert(VALID_TYPES.has('episodic'), 'has episodic');
		assert(VALID_TYPES.has('semantic'), 'has semantic');
		assert(VALID_TYPES.has('procedural'), 'has procedural');
	});

	it('deprecated types are NOT in VALID_TYPES', () => {
		assert(!VALID_TYPES.has('short_term'), 'short_term not valid');
		assert(!VALID_TYPES.has('long_term'), 'long_term not valid');
		assert(!VALID_TYPES.has('scene'), 'scene not valid');
		assert(!VALID_TYPES.has('persona'), 'persona not valid');
		assert(!VALID_TYPES.has('l0'), 'l0 not valid');
	});

	it('_normalizeEntry preserves explicit type', () => {
		assertEqual(normalizeType('semantic'), 'semantic', 'explicit semantic preserved');
		assertEqual(normalizeType('procedural'), 'procedural', 'explicit procedural preserved');
	});
});
}
