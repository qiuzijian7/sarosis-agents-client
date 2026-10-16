/*---------------------------------------------------------------------------------------------
 *  sessionGrouping 单测 —— 钉住「按工作区分组 + 组内配额」的行为。
 *
 *  为什么必须有：这套判据决定「哪些会话在侧栏可见」，而它挂在 2100+ 行的 DOM 面板上，
 *  没有测试就只能靠肉眼看列表回归 ✗。这里只喂纯数据、断言可见集合。
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	buildSessionGroups,
	computeGroupWindow,
	lastPathSegment,
	nextExtraShown,
	parseStringArray,
	SESSION_GROUP_IDLE_LIMIT,
	UNGROUPED_GROUP_KEY,
	workspaceTitleOf,
} from './sessionGrouping.js';

interface ISession {
	readonly id: string;
	readonly workspaceId?: string;
	readonly running?: boolean;
}

const session = (id: string, workspaceId?: string, running?: boolean): ISession => ({ id, workspaceId, running });

const workspaceIdOf = (s: ISession): string | undefined => s.workspaceId;
const isActive = (s: ISession): boolean => s.running === true;

suite('sessionGrouping / buildSessionGroups', () => {

	test('按 workspaces 顺序分组，组内保持入参顺序', () => {
		const groups = buildSessionGroups(
			[session('a', 'ws-2'), session('b', 'ws-1'), session('c', 'ws-2'), session('d', 'ws-1')],
			[{ id: 'ws-1', name: '一' }, { id: 'ws-2', name: '二' }],
			workspaceIdOf,
		);
		assert.deepStrictEqual(groups.map(g => g.key), ['ws-1', 'ws-2']);
		assert.deepStrictEqual(groups[0].sessions.map(s => s.id), ['b', 'd']);
		assert.deepStrictEqual(groups[1].sessions.map(s => s.id), ['a', 'c']);
	});

	test('没有会话的工作区不输出（有意与 dsh desktop 不同）', () => {
		const groups = buildSessionGroups(
			[session('a', 'ws-1')],
			[{ id: 'ws-1', name: '一' }, { id: 'ws-2', name: '二' }, { id: 'ws-3', name: '三' }],
			workspaceIdOf,
		);
		assert.deepStrictEqual(groups.map(g => g.key), ['ws-1']);
	});

	test('workspaceId 为空串或 undefined 都算未分组，且恒在最后', () => {
		const groups = buildSessionGroups(
			[session('a', undefined), session('b', 'ws-1'), session('c', ''), session('d', 'ws-1')],
			[{ id: 'ws-1', name: '一' }],
			workspaceIdOf,
			{ ungroupedTitle: '未分组' },
		);
		assert.deepStrictEqual(groups.map(g => g.key), ['ws-1', UNGROUPED_GROUP_KEY]);
		assert.deepStrictEqual(groups[1].sessions.map(s => s.id), ['a', 'c']);
		assert.strictEqual(groups[1].title, '未分组');
		assert.strictEqual(groups[1].ungrouped, true);
		assert.strictEqual(groups[1].missing, false);
	});

	test('查不到的工作区 ⇒ missing 组（照常保留会话），排真实工作区之后、未分组之前', () => {
		const groups = buildSessionGroups(
			[session('a', 'gone-x'), session('b', 'ws-1'), session('c', undefined), session('d', 'gone-y')],
			[{ id: 'ws-1', name: '一' }],
			workspaceIdOf,
		);
		assert.deepStrictEqual(groups.map(g => g.key), ['ws-1', 'gone-x', 'gone-y', UNGROUPED_GROUP_KEY]);
		assert.strictEqual(groups[1].missing, true);
		assert.strictEqual(groups[1].title, 'gone-x');
		assert.strictEqual(groups[1].path, '');
	});

	test('组头标题三级回退：name → 路径末段 → id', () => {
		assert.strictEqual(workspaceTitleOf({ id: 'ws', name: '  有名字  ' }), '有名字');
		assert.strictEqual(workspaceTitleOf({ id: 'ws', name: '   ', path: 'g:\\SarosWorkspace\\x' }), 'x');
		assert.strictEqual(workspaceTitleOf({ id: 'ws', name: '', path: '/a/b/' }), 'b');
		assert.strictEqual(workspaceTitleOf({ id: 'ws-fallback' }), 'ws-fallback');
	});

	test('路径末段同时认 Windows 反斜杠与 POSIX 斜杠', () => {
		assert.strictEqual(lastPathSegment('g:\\SarosWorkspace\\sarosis-agents-client'), 'sarosis-agents-client');
		assert.strictEqual(lastPathSegment('/home/u/repo/'), 'repo');
		assert.strictEqual(lastPathSegment('   '), '');
		assert.strictEqual(lastPathSegment(undefined), '');
	});

	test('空输入 / 空工作区列表不抛，返回空数组', () => {
		assert.deepStrictEqual(buildSessionGroups([], [], workspaceIdOf), []);
		assert.deepStrictEqual(buildSessionGroups([session('a', 'ws')], [], workspaceIdOf).map(g => g.key), ['ws']);
	});

	test('畸形工作区条目（无 id）不产生分组、也不吞掉会话', () => {
		const groups = buildSessionGroups(
			[session('a', 'ws-1')],
			[{ id: '' as string, name: '坏' }, { id: 'ws-1', name: '好' }],
			workspaceIdOf,
		);
		assert.deepStrictEqual(groups.map(g => g.key), ['ws-1']);
	});
});

suite('sessionGrouping / computeGroupWindow', () => {

	const manyIdle = (count: number, active = 0): ISession[] => {
		const out: ISession[] = [];
		for (let i = 0; i < count; i++) { out.push(session(`i${i}`)); }
		for (let i = 0; i < active; i++) { out.push(session(`a${i}`, undefined, true)); }
		return out;
	};

	test('默认只显示 5 条空闲，其余折叠并计入 hiddenIdle', () => {
		const window = computeGroupWindow(manyIdle(12), 0, isActive);
		assert.strictEqual(window.visible.length, SESSION_GROUP_IDLE_LIMIT);
		assert.deepStrictEqual(window.visible.map(s => s.id), ['i0', 'i1', 'i2', 'i3', 'i4']);
		assert.strictEqual(window.hiddenIdle, 7);
		assert.strictEqual(window.canExpand, true);
		assert.strictEqual(window.canCollapse, false);
	});

	test('运行中的会话始终可见，且不占那 5 条配额（含排在最末尾的）', () => {
		const sessions = [session('a', undefined, true), ...manyIdle(12), session('z', undefined, true)];
		const window = computeGroupWindow(sessions, 0, isActive);
		assert.deepStrictEqual(window.visible.map(s => s.id), ['a', 'i0', 'i1', 'i2', 'i3', 'i4', 'z']);
		assert.strictEqual(window.hiddenIdle, 7, '运行中的两条不应减少空闲配额');
	});

	test('展开 5 条 → 再展开 5 条 → 全部显示后给「收起」', () => {
		const sessions = manyIdle(14);
		const first = computeGroupWindow(sessions, 0, isActive);
		assert.strictEqual(first.hiddenIdle, 9);

		const second = computeGroupWindow(sessions, nextExtraShown(0), isActive);
		assert.strictEqual(second.visible.length, 10);
		assert.strictEqual(second.hiddenIdle, 4);
		assert.strictEqual(second.canExpand, true);
		assert.strictEqual(second.canCollapse, false, '还有折叠项时只给「展开其余」，不同时给「收起」');

		const third = computeGroupWindow(sessions, nextExtraShown(10), isActive);
		assert.strictEqual(third.visible.length, 14);
		assert.strictEqual(third.hiddenIdle, 0);
		assert.strictEqual(third.canExpand, false);
		assert.strictEqual(third.canCollapse, true);
	});

	test('会话不足 5 条时既不给展开也不给收起', () => {
		const window = computeGroupWindow(manyIdle(3), 0, isActive);
		assert.strictEqual(window.visible.length, 3);
		assert.strictEqual(window.canExpand, false);
		assert.strictEqual(window.canCollapse, false);
	});

	test('unlimited（搜索命中）⇒ 全可见、不截断', () => {
		const window = computeGroupWindow(manyIdle(30), 0, isActive, { unlimited: true });
		assert.strictEqual(window.visible.length, 30);
		assert.strictEqual(window.hiddenIdle, 0);
		assert.strictEqual(window.canExpand, false);
	});

	test('limit 可覆写，且非法 limit 回落为 1（不能 0 ⇒ 否则整组空白）', () => {
		assert.strictEqual(computeGroupWindow(manyIdle(10), 0, isActive, { limit: 2 }).visible.length, 2);
		assert.strictEqual(computeGroupWindow(manyIdle(10), 0, isActive, { limit: 0 }).visible.length, 1);
	});

	test('extraShown 容错：NaN / 负数 / 小数 都不会让整组消失', () => {
		assert.strictEqual(computeGroupWindow(manyIdle(10), Number.NaN, isActive).visible.length, 5);
		assert.strictEqual(computeGroupWindow(manyIdle(10), -3, isActive).visible.length, 5);
		assert.strictEqual(computeGroupWindow(manyIdle(10), 2.7, isActive).visible.length, 7);
	});

	test('nextExtraShown 每次 +5，非法 step 回落默认值', () => {
		assert.strictEqual(nextExtraShown(0), 5);
		assert.strictEqual(nextExtraShown(5), 10);
		assert.strictEqual(nextExtraShown(Number.NaN), 5);
		assert.strictEqual(nextExtraShown(5, 0), 10);
		assert.strictEqual(nextExtraShown(-5), 5);
	});

	test('空组 ⇒ 空可见集且两个按钮都不给', () => {
		const window = computeGroupWindow([], 0, isActive);
		assert.deepStrictEqual(window.visible, []);
		assert.strictEqual(window.canExpand, false);
		assert.strictEqual(window.canCollapse, false);
	});
});

suite('sessionGrouping / parseStringArray', () => {

	test('正常数组只保留非空字符串', () => {
		assert.deepStrictEqual(parseStringArray('["a","","b",3,null]'), ['a', 'b']);
	});

	test('坏 JSON / 非数组 / 空值一律降级为空数组（侧栏不能整体空白）', () => {
		assert.deepStrictEqual(parseStringArray('{"a":1}'), []);
		assert.deepStrictEqual(parseStringArray('not json'), []);
		assert.deepStrictEqual(parseStringArray(''), []);
		assert.deepStrictEqual(parseStringArray(undefined), []);
	});
});
