/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IDE 能力授权（反向通道 `ide.request` 的第一道闸，协议 v2）的单元测试。
 *
 * 这是**放行面**：Host 里的插件据此才能驱动 IDE，所以规则必须逐条钉死——尤其是
 * "**别的插件**声明过该能力 ≠ 这个插件能调"（逐插件授权，最容易写错的一条）。
 * 另外把"坏清单/缺清单 ⇒ 零能力"和"伴生插件没有 `vssaros` 字段 ⇒ 不报错"也钉住。
 */

import assert from 'assert';
import { authorizeIdeRequest, readCapabilityDeclarations } from '../../common/dshIdeAuthorization.js';

/** 造一份最小可解析的模块插件清单。 */
function manifestOf(capabilities: string[] | undefined) {
	return {
		vssaros: {
			manifestVersion: 1,
			module: 'ide',
			...(capabilities === undefined ? {} : { ideCapabilities: capabilities }),
		},
	};
}

const declarationsOf = (entries: Record<string, unknown>) => readCapabilityDeclarations(new Map(Object.entries(entries))).declarations;

suite('dshHarness / IDE capability authorization', () => {

	test('声明过的能力放行；判定结果带上该插件的声明', () => {
		const declarations = declarationsOf({ '@vssaros/dsh-ide': manifestOf(['getDiagnostics', 'openFile']) });
		const result = authorizeIdeRequest({ capability: 'getDiagnostics', pluginId: '@vssaros/dsh-ide' }, declarations);
		assert.strictEqual(result.allowed, true, JSON.stringify(result));
		assert.deepStrictEqual(result.allowed ? result.declaration.capabilities : [], ['getDiagnostics', 'openFile']);
	});

	test('逐插件授权：别的插件声明过 ≠ 这个插件能调（默认拒绝）', () => {
		const declarations = declarationsOf({
			'@vssaros/dsh-ide': manifestOf(['getDiagnostics']),
			'@vssaros/dsh-other': manifestOf(['openFile']),
		});
		const allowed = authorizeIdeRequest({ capability: 'getDiagnostics', pluginId: '@vssaros/dsh-ide' }, declarations);
		assert.strictEqual(allowed.allowed, true);
		// 同一个能力，换个没声明它的插件 → 必须拒
		const denied = authorizeIdeRequest({ capability: 'getDiagnostics', pluginId: '@vssaros/dsh-other' }, declarations);
		assert.strictEqual(denied.allowed, false, JSON.stringify(denied));
		assert.match(denied.allowed ? '' : denied.reason, /未声明能力 getDiagnostics/);
		assert.match(denied.allowed ? '' : denied.reason, /已声明：openFile/, '拒绝原因要列出该插件实际声明了什么（可诊断）');
	});

	test('未知能力名 / 缺 pluginId / 插件未安装：都拒，且原因可读', () => {
		const declarations = declarationsOf({ '@vssaros/dsh-ide': manifestOf(['getDiagnostics']) });
		// 注意：不能再拿 `mindmap` 当"未知能力"的例子——工具族的名字（browser/canvas/mindmap）
		// 自 v1.2.12 起已在白名单里，它们走的是"未声明能力"这条（见下一组用例）。
		// ⚠ `unreal` 已于 2026-10-13 退役（该族改由 dsh 侧 `vssaros-unreal` 直连 bridge）⇒
		//   它**又**回到"未知能力"这一侧了 ✓（下一组用例最后一条专门钉这件事 ✓）。
		const unknownCapability = authorizeIdeRequest({ capability: 'teleport', pluginId: '@vssaros/dsh-ide' }, declarations);
		assert.strictEqual(unknownCapability.allowed, false);
		assert.match(unknownCapability.allowed ? '' : unknownCapability.reason, /未知的 IDE 能力：teleport/);
		assert.strictEqual(unknownCapability.allowed ? 0 : unknownCapability.code, -32601, '未知能力用 MethodNotFound');

		const noPlugin = authorizeIdeRequest({ capability: 'getDiagnostics' }, declarations);
		assert.strictEqual(noPlugin.allowed, false);
		assert.match(noPlugin.allowed ? '' : noPlugin.reason, /必须带 pluginId/);

		const notInstalled = authorizeIdeRequest({ capability: 'getDiagnostics', pluginId: '@vssaros/dsh-nope' }, declarations);
		assert.strictEqual(notInstalled.allowed, false);
		assert.match(notInstalled.allowed ? '' : notInstalled.reason, /未安装或没有可读清单/);
	});

	test('工具族能力名（browser / canvas / mindmap）是**已知**的：走"未声明"而不是"未知"（13.3 那条缺口的落点）', () => {
		const declarations = declarationsOf({ '@vssaros/dsh-ide': manifestOf(['getDiagnostics']) });
		for (const capability of ['browser', 'canvas', 'mindmap']) {
			const verdict = authorizeIdeRequest({ capability, pluginId: '@vssaros/dsh-ide' }, declarations);
			assert.strictEqual(verdict.allowed, false, capability);
			assert.match(verdict.allowed ? '' : verdict.reason, new RegExp(`未声明能力 ${capability}`),
				`${capability} 必须是"已支持但未声明"，否则声明了它的插件会被当未知能力拒掉`);
		}
		// 反过来：声明了就能放行（粒度按名字来，不是整族放行）
		const declared = declarationsOf({ '@vssaros/dsh-mind': manifestOf(['mindmap']) });
		assert.strictEqual(authorizeIdeRequest({ capability: 'mindmap', pluginId: '@vssaros/dsh-mind' }, declared).allowed, true);
		assert.strictEqual(authorizeIdeRequest({ capability: 'canvas', pluginId: '@vssaros/dsh-mind' }, declared).allowed, false,
			'声明 mindmap 不该顺带拿到 canvas（粒度不折叠）');
		// ★ 2026-10-13：`unreal` 与上面三个**反过来**了 —— 该族（七个工具）已全由 dsh 侧
		//   `dsh-plugins/vssaros-unreal` 自己实现（Host 直连 `127.0.0.1:8765/bridge/*`），不再经 IDE 反向
		//   通道 ⇒ 名字从白名单里**删掉**（理由记在 `vssarosPluginManifest.ts` 的白名单注释里 ✓）。
		//   这条把"删掉之后的**行为**"钉住：它现在是**未知能力**（MethodNotFound），而**不是**"未声明能力"
		//   —— 免得哪天有人顺手把名字加回白名单，谁都看不出那原本是一次决策 ✗
		//   （本用例第一版正是按"已知但未声明"写的，这次是**跟着决策改**，不是放宽 ✓）。
		const retired = authorizeIdeRequest({ capability: 'unreal', pluginId: '@vssaros/dsh-ide' }, declarations);
		assert.strictEqual(retired.allowed, false);
		assert.match(retired.allowed ? '' : retired.reason, /未知的 IDE 能力：unreal/);
		assert.strictEqual(retired.allowed ? 0 : retired.code, -32601, '`unreal` 已退役 ⇒ 未知能力用 MethodNotFound');
	});

	test('清单里没声明 ideCapabilities ⇒ 零能力（不是"全放行"）', () => {
		const declarations = declarationsOf({ '@vssaros/dsh-ide': manifestOf(undefined) });
		assert.deepStrictEqual(declarations.get('@vssaros/dsh-ide')?.capabilities, []);
		const result = authorizeIdeRequest({ capability: 'getDiagnostics', pluginId: '@vssaros/dsh-ide' }, declarations);
		assert.strictEqual(result.allowed, false, JSON.stringify(result));
		assert.match(result.allowed ? '' : result.reason, /已声明：无/);
	});

	test('坏清单 ⇒ 零能力 + 一条 note（绝不因此放行）', () => {
		const broken = readCapabilityDeclarations(new Map([
			// 有 `vssaros` 字段但清单本身不合法（版本不对）⇒ 必须留 note + 零能力
			['@vssaros/dsh-broken', { vssaros: { manifestVersion: 99, module: 'ide', ideCapabilities: ['getDiagnostics'] } }],
		]));
		assert.strictEqual(broken.declarations.has('@vssaros/dsh-broken'), false);
		assert.strictEqual(broken.notes.length, 1, JSON.stringify(broken.notes));
		assert.match(broken.notes[0], /视为零 IDE 能力/);
		const result = authorizeIdeRequest({ capability: 'getDiagnostics', pluginId: '@vssaros/dsh-broken' }, broken.declarations);
		assert.strictEqual(result.allowed, false);
	});

	test('没有 vssaros 字段的包（伴生插件）静默跳过，不当成错误', () => {
		const read = readCapabilityDeclarations(new Map<string, unknown>([
			['@vssaros/dsh-bridge', { name: '@vssaros/dsh-bridge', version: '0.2.6' }],
			['@vssaros/dsh-ide', manifestOf(['openFile'])],
		]));
		assert.deepStrictEqual(read.notes, []);
		assert.strictEqual(read.declarations.has('@vssaros/dsh-bridge'), false);
		assert.deepStrictEqual(read.declarations.get('@vssaros/dsh-ide')?.capabilities, ['openFile']);
	});
});
