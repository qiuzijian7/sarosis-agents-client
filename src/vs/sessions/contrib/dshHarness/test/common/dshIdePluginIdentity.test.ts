/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IDE 能力消费方的**身份声明守卫**（插件源码 ⇄ 自己的清单）。
 *
 * 链路：消费方插件 `callIDE('ide.request', { capability, pluginId })` → VsSaros 侧
 * `authorizeIdeRequest` 拿 `pluginId` 去查"**这个插件装了没 + 它的清单里声明过这个能力没**"。
 *
 * ⚠️ 先说清这条守卫**管不到**什么：`pluginId` 是**调用方自报**的（协议如此，见 `IDshIdeRequest`），
 * 所以任何能拿到 `ctx.vssarosBridge` 的插件都能自称 `@vssaros/dsh-ide` —— 这是"声明式授权"而非
 * "证明式授权"，真正的防冒名要改协议（由桥按调用方签发身份），那是另一个决定，不在本用例射程内。
 *
 * 它守的是**最容易真出错、且一错就静默**的两件事：
 * ① 自报的名字必须**等于自己的包名**——抄错/改名漏改 ⇒ 授权永远查不到声明，表现为"某一次工具调用失败"；
 * ② 代码里用到的能力必须**在自己的清单 `vssaros.ideCapabilities` 里声明过**——漏声明 ⇒ 默认拒绝。
 * 两条都是纯字符串一致性，编译期看不出来，所以直接读源码与清单比对。
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

/** 会用反向通道请求 IDE 能力的插件（新增消费方时**加到这里**）。 */
const CONSUMERS = ['vssaros-ide', 'vssaros-codebase', 'vssaros-kanban', 'vssaros-workflow'] as const;

interface IConsumer {
	readonly dir: string;
	readonly name: string;
	readonly capabilities: readonly string[];
	readonly source: string;
}

/** 读一个消费方插件：包名 + 清单声明的能力 + 入口源码；不是仓库根时返回 `undefined`。 */
function consumerOf(dir: string): IConsumer | undefined {
	const root = path.join(process.cwd(), 'dsh-plugins', dir);
	const packagePath = path.join(root, 'package.json');
	if (!fs.existsSync(packagePath)) {
		return undefined;
	}
	const json = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as {
		name?: unknown;
		main?: unknown;
		vssaros?: { ideCapabilities?: unknown };
	};
	const entry = path.join(root, typeof json.main === 'string' ? json.main : 'lib/index.js');
	if (!fs.existsSync(entry)) {
		return undefined;
	}
	const declared = json.vssaros?.ideCapabilities;
	return {
		dir,
		name: String(json.name ?? ''),
		capabilities: Array.isArray(declared) ? declared.filter((c): c is string => typeof c === 'string') : [],
		source: fs.readFileSync(entry, 'utf8'),
	};
}

/**
 * 入口源码里**用到的**能力名。两种调用形状都要认（否则守卫会静默漏掉一类消费方）：
 * - 直接调桥的消费方：`callIDE('ide.request', { capability: 'workflow', … })`；
 * - 有本地 `requestIde()` 的消费方（`vssaros-ide`）：`requestIde(bridge, 'getDiagnostics', …)`。
 */
function capabilitiesUsedIn(source: string): Set<string> {
	const used = new Set<string>();
	for (const match of source.matchAll(/capability:\s*'([A-Za-z]+)'/g)) {
		used.add(match[1]);
	}
	for (const match of source.matchAll(/requestIde\(bridge,\s*'([A-Za-z]+)'/g)) {
		used.add(match[1]);
	}
	return used;
}

suite('dshHarness / IDE capability consumers（身份与声明一致性）', () => {

	test('★ 自报的 `pluginId` 必须等于自己的包名（抄错 = 授权永远查不到声明，且只表现为一次工具失败）', () => {
		let checked = 0;
		for (const dir of CONSUMERS) {
			const consumer = consumerOf(dir);
			if (!consumer) {
				continue;
			}
			const matched = /const PLUGIN_ID = '([^']+)'/.exec(consumer.source);
			assert.ok(matched, `${dir} 的入口里找不到 \`const PLUGIN_ID = '…'\` —— 反向请求的调用方标识改了形状？`);
			assert.strictEqual(matched[1], consumer.name,
				`${dir} 自报的 pluginId「${matched[1]}」与包名「${consumer.name}」不一致 ⇒ VsSaros 侧按包名查不到声明，一律拒`);
			checked++;
		}
		assert.ok(checked > 0, `（跳过：找不到 dsh-plugins/ —— 测试进程的 cwd 不是仓库根）已检查 ${checked} 个消费方`);
	});

	test('★★ 桥的出站原语必须**保留身份盖章**（改回箭头函数就静默退回"自报身份"）', () => {
		// 这是"逐插件授权"从**声明式**变成**证明式**的那一处接线，且它极其容易被无意改回：
		// 只要 `callIDE` 从"方法（用 this）"改成箭头函数/独立函数，cordis 就无法把调用方 ctx 绑到 `this`，
		// 盖章会静默失效（一切照旧能跑，只是又变成"谁都能自称别人"）。所以把关键三件套钉死。
		const source = path.join(process.cwd(), 'dsh-plugins', 'vssaros-bridge', 'lib', 'index.js');
		if (!fs.existsSync(source)) {
			assert.ok(true, '（跳过：找不到 vssaros-bridge —— 测试进程的 cwd 不是仓库根）');
			return;
		}
		const text = fs.readFileSync(source, 'utf8');
		for (const fragment of [
			"Symbol.for('cordis.tracker')",              // 挂 tracker：cordis 才会把服务按访问者 ctx 包装
			"property: 'ctx'",                           // tracker 约定：方法内 this.ctx = 调用方 ctx
			'callIDE(method, params, options) {',        // **方法**写法（不能用箭头函数）
			'stampCallerIdentity(this, method, params)', // 用 this（=调用方 ctx 的 shadow）盖章
			'fiber?.entry?.options?.name',               // 权威身份 = 加载器行里的包名
			'实际是',                                     // 自报与权威不符时要**拒绝**（不是忽略）
		]) {
			assert.ok(text.includes(fragment),
				`vssaros-bridge 里找不到 \`${fragment}\` ⇒ 身份盖章的接线被回退了（反向通道会退回"调用方自报身份"）`);
		}
	});

	test('★ 代码里用到的能力 ⊆ 自己清单声明的能力（漏一条 = 该请求被默认拒绝）', () => {
		let checked = 0;
		for (const dir of CONSUMERS) {
			const consumer = consumerOf(dir);
			if (!consumer) {
				continue;
			}
			const used = capabilitiesUsedIn(consumer.source);
			assert.ok(used.size > 0, `${dir} 里一个能力调用点都没找到：调用形状变了，这条守卫会静默失效`);
			for (const capability of used) {
				assert.ok(consumer.capabilities.includes(capability),
					`${dir} 用了能力 ${capability}，但清单 vssaros.ideCapabilities（${consumer.capabilities.join(' / ') || '空'}）里没声明 ⇒ 请求会在主进程被拒`);
			}
			checked++;
		}
		assert.ok(checked > 0, `（跳过：找不到 dsh-plugins/）已检查 ${checked} 个消费方`);
	});
});
