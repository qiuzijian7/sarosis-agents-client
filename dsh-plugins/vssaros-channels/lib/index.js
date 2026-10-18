// @vssaros/dsh-channels — IM 渠道（重构 2.3）。
//
// ── 这个插件是什么 ──────────────────────────────────────────────────────────
// 入站消息（IM 平台）→ 专属会话（`chat:<platform>:<chatId>`）→ vssarosRuns 驱动 → 回传。
// 本轮落地**核心环**（路由 + loopback 适配器，进程内可验证）；飞书/Telegram 真机适配器
// 待真凭据对接（真机回归需要真实机器人，不在本轮）。
//
// ── 不做什么 ────────────────────────────────────────────────────────────────
// · 不注册工具（渠道是**入站口**，不是模型能力）；
// · 没有 ActivityBar 图标（manifest view.kind=none——渠道状态在设置页）；
// · 审批 IM 卡片待真机适配器（要平台卡片回调 ⇒ 本轮审批走 runs 的 deny-by-default）。
//
// ── 依赖 ────────────────────────────────────────────────────────────────────
// `vssarosRuns` 可选注入：bridge 0.2.26+ 提供；不在 ⇒ 渠道环不启动（插件本身照常激活）。

import { createChannelRouter } from './core/router.js';
import { createLoopbackAdapter } from './adapters/loopback.js';

export const name = 'vssaros-channels';
/** 没有硬依赖：vssarosRuns 走可选注入（缺了渠道环不启动，不阻塞激活）。 */
export const inject = [];

export function apply(ctx, config = {}) {
	// 适配器清单：loopback 只在显式开启时挂上（`channels.loopback.enabled`，默认关 ✓——
	// 它是测试口，不该出现在生产形态里）。
	const adapters = [];
	if (config.loopback?.enabled === true) {
		adapters.push(createLoopbackAdapter());
	}
	if (adapters.length === 0) {
		(typeof ctx.logger === 'function' ? ctx.logger('vssaros-channels') : console).info('没有启用的渠道适配器（loopback 默认关；feishu/telegram 待真机对接）');
	}

	ctx.inject(['vssarosRuns'], scope => {
		const router = createChannelRouter({
			runs: scope.vssarosRuns,
			log: (level, msg) => ctx.logger('vssaros-channels')[level === 'warn' ? 'warn' : 'info'](msg),
			cwdOf: platform => String(config[platform]?.cwd ?? config.cwd ?? ''),
			approvalAllow: platform => Array.isArray(config[platform]?.approvalAllow) ? config[platform].approvalAllow : [],
		});
		for (const adapter of adapters) {
			adapter.start(msg => router.handle(adapter, msg));
		}
		return () => { for (const a of adapters) { a.stop(); } };
	});
}
