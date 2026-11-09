/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	DESKTOP_BACKGROUND_METHODS, DESKTOP_CONTROL_FILE, DESKTOP_CONTROL_PATH,
	DESKTOP_DEFAULT_MAX_LEVEL, DESKTOP_FOREGROUND_METHODS, DESKTOP_IDLE_STATUS,
	DESKTOP_LEVELS, DESKTOP_OBSERVE_METHODS, DESKTOP_REFUSED_METHODS,
	DESKTOP_USER_IDLE_THRESHOLD_SECONDS,
	classifyDesktopMethod, desktopControlRefusal, desktopTokenMatches,
	foregroundIdleRefusal, isForegroundMethod, isPresenceMethod, isProtectedApp,
	isReadOnlyLevel, levelAllows,
} from '../../common/desktopControlProtocol.js';

suite('电脑操控 P0 · 只读中继策略', () => {

	test('白名单互斥：observe / background / foreground 三类不重叠', () => {
		for (const method of DESKTOP_OBSERVE_METHODS) {
			assert.ok(!DESKTOP_BACKGROUND_METHODS.has(method), `${method} 同时是观察与后台动作`);
			assert.ok(!DESKTOP_FOREGROUND_METHODS.has(method), `${method} 同时是观察与前台动作`);
		}
		for (const method of DESKTOP_BACKGROUND_METHODS) {
			assert.ok(!DESKTOP_FOREGROUND_METHODS.has(method), `${method} 同时是后台与前台动作`);
		}
		assert.ok(DESKTOP_OBSERVE_METHODS.has('screenshot'));
		assert.ok(DESKTOP_OBSERVE_METHODS.has('listWindows'));
		assert.ok(!DESKTOP_OBSERVE_METHODS.has('click'));
	});

	test('未识别 / 空 method 一律按最高危 foreground 分类（fail-closed）', () => {
		assert.equal(classifyDesktopMethod('screenshot'), 'observe');
		assert.equal(classifyDesktopMethod('typeText'), 'background');
		assert.equal(classifyDesktopMethod('activateApp'), 'foreground');
		assert.equal(classifyDesktopMethod('unknownProbe'), 'foreground');
		assert.equal(classifyDesktopMethod(''), 'foreground');
		assert.equal(classifyDesktopMethod(undefined), 'foreground');
		assert.equal(classifyDesktopMethod(42), 'foreground');
	});

	test('四档矩阵：off 全拒、view 只观察、background 不含前台、foreground 全放', () => {
		assert.deepEqual(DESKTOP_LEVELS, ['off', 'view', 'background', 'foreground']);
		for (const kind of ['observe', 'background', 'foreground'] as const) {
			assert.equal(levelAllows('off', kind), false, `off 竟允许 ${kind}`);
			assert.equal(levelAllows('foreground', kind), true, `foreground 竟拒 ${kind}`);
		}
		assert.equal(levelAllows('view', 'observe'), true);
		assert.equal(levelAllows('view', 'background'), false);
		assert.equal(levelAllows('view', 'foreground'), false);
		assert.equal(levelAllows('background', 'observe'), true);
		assert.equal(levelAllows('background', 'background'), true);
		assert.equal(levelAllows('background', 'foreground'), false);
	});

	test('P0 硬闸：任何档位都不放行非 observe 方法', () => {
		for (const level of DESKTOP_LEVELS) {
			assert.match(desktopControlRefusal('click', level)?.message ?? '', /P0 read-only/);
			assert.match(desktopControlRefusal('activateApp', level)?.message ?? '', /P0 read-only/);
			assert.match(desktopControlRefusal('unknownProbe', level)?.message ?? '', /P0 read-only/);
		}
	});

	test('off 档连只读都拿不到；view/background/foreground 放行只读', () => {
		assert.match(desktopControlRefusal('screenshot', 'off')?.message ?? '', /level off/);
		for (const level of ['view', 'background', 'foreground'] as const) {
			assert.equal(desktopControlRefusal('screenshot', level), undefined);
			assert.equal(desktopControlRefusal('getAccessibilityTree', level), undefined);
		}
	});

	test('永久拒绝名单优先于档位与 P0 闸', () => {
		for (const method of DESKTOP_REFUSED_METHODS) {
			const refusal = desktopControlRefusal(method, 'foreground', false);
			assert.equal(refusal?.code, -32601);
			assert.match(refusal?.message ?? '', /permanently refused/);
		}
	});

	test('关掉 P0 闸后档位生效（为 P1 预留，行为可预测）', () => {
		assert.equal(desktopControlRefusal('click', 'view', false)?.code, -32601);
		assert.equal(desktopControlRefusal('click', 'background', false), undefined);
		assert.equal(desktopControlRefusal('activateApp', 'background', false)?.code, -32601);
		assert.equal(desktopControlRefusal('activateApp', 'foreground', false), undefined);
	});

	test('空 method 返回 -32602 参数错误', () => {
		assert.equal(desktopControlRefusal('', 'view')?.code, -32602);
		assert.equal(desktopControlRefusal(null, 'view')?.code, -32602);
	});

	test('token：路径前缀 + 等长逐位比较；错前缀/错一位/长度不符/带 query 都正确处理', () => {
		const token = 'abc123';
		assert.equal(desktopTokenMatches(`${DESKTOP_CONTROL_PATH}${token}`, token), true);
		assert.equal(desktopTokenMatches(`${DESKTOP_CONTROL_PATH}${token}?x=1`, token), true);
		assert.equal(desktopTokenMatches(`${DESKTOP_CONTROL_PATH}abc124`, token), false);
		assert.equal(desktopTokenMatches(`${DESKTOP_CONTROL_PATH}abc12`, token), false);
		assert.equal(desktopTokenMatches(`${DESKTOP_CONTROL_PATH}${token}x`, token), false);
		assert.equal(desktopTokenMatches('/other/abc123', token), false);
		assert.equal(desktopTokenMatches(undefined, token), false);
		assert.equal(desktopTokenMatches(`${DESKTOP_CONTROL_PATH}${token}`, ''), false);
	});

	test('P1 · 主进程最高档：默认 view，off/view 强制只读', () => {
		assert.equal(DESKTOP_DEFAULT_MAX_LEVEL, 'view');
		assert.equal(isReadOnlyLevel('view'), true);
		assert.equal(isReadOnlyLevel('off'), true);
		assert.equal(isReadOnlyLevel('background'), false);
		assert.equal(isReadOnlyLevel('foreground'), false);
	});

	test('P1 · view 仍拒所有输入；background 只放后台且仍拒前台与永久拒绝名单', () => {
		assert.match(desktopControlRefusal('click', 'view', true)?.message ?? '', /P0 read-only/);
		assert.match(desktopControlRefusal('typeText', 'off', true)?.message ?? '', /P0 read-only/);
		assert.equal(desktopControlRefusal('click', 'background', false), undefined);
		assert.equal(desktopControlRefusal('screenshot', 'background', false), undefined);
		assert.match(desktopControlRefusal('activateApp', 'background', false)?.message ?? '', /level background/);
		assert.equal(desktopControlRefusal('killApp', 'background', false)?.code, -32601);
		assert.match(desktopControlRefusal('unknownProbe', 'background', false)?.message ?? '', /level background/);
	});

	test('P2 · 前台方法识别：只有两个前台 method 会触发空闲门', () => {
		assert.equal(isForegroundMethod('movePointer'), true);
		assert.equal(isForegroundMethod('activateApp'), true);
		assert.equal(isForegroundMethod('click'), false);
		assert.equal(isForegroundMethod('screenshot'), false);
		assert.equal(isForegroundMethod(undefined), false);
		assert.equal(DESKTOP_USER_IDLE_THRESHOLD_SECONDS, 3);
	});

	test('P2 · 空闲门 fail-closed：活跃 / NaN / Infinity 拒绝，静止放行', () => {
		assert.equal(foregroundIdleRefusal(10), undefined);
		assert.equal(foregroundIdleRefusal(3), undefined);
		assert.equal(foregroundIdleRefusal(2.9)?.code, -32001);
		assert.equal(foregroundIdleRefusal(0)?.code, -32001);
		assert.equal(foregroundIdleRefusal(Number.NaN)?.code, -32001);
		assert.equal(foregroundIdleRefusal(Number.POSITIVE_INFINITY)?.code, -32001);
		assert.equal(foregroundIdleRefusal(1, 0), undefined);
	});

	test('P2 · foreground 档放行前台方法，但后台档仍拒（双重裁决）', () => {
		assert.equal(desktopControlRefusal('movePointer', 'foreground', false), undefined);
		assert.match(desktopControlRefusal('movePointer', 'background', false)?.message ?? '', /level background/);
		assert.equal(desktopControlRefusal('killApp', 'foreground', false)?.code, -32601);
	});

	test('P2 · presence：紧急停止/状态上报方法独立于档位，状态初值完全空闲', () => {
		assert.equal(isPresenceMethod('stop'), true);
		assert.equal(isPresenceMethod('reportStatus'), true);
		assert.equal(isPresenceMethod('click'), false);
		assert.equal(isPresenceMethod(undefined), false);
		assert.equal(DESKTOP_OBSERVE_METHODS.has('getStatus'), true);
		assert.deepEqual(DESKTOP_IDLE_STATUS,
			{ active: false, botId: '', appKey: '', handoffState: 'idle', stopped: false });
	});

	test('发现文件名与路径常量稳定（Host 侧要对账）', () => {
		assert.equal(DESKTOP_CONTROL_FILE, 'desktop-control.json');
		assert.equal(DESKTOP_CONTROL_PATH, '/desktop-control/vssaros/');
	});

	test('受保护应用：自身、Host、系统设置、凭据管理器都命中；普通应用不误伤', () => {
		for (const name of ['VsSaros', 'Code - OSS', 'DSH Computer Use.app', 'dsh host',
			'Windows Settings', '系统设置', 'Credential Manager', '凭据管理器', '钥匙串访问']) {
			assert.ok(isProtectedApp(name), `${name} 应被标记`);
		}
		for (const name of ['Notepad', '备忘录', 'Chrome', 'Figma', '', undefined]) {
			assert.equal(isProtectedApp(name), false, `${String(name)} 不该命中`);
		}
	});
});
