/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── 渠道品牌图标数据单测 ──
//
// 只测**纯数据 + 纯函数**（不构造 DOM）：聚合 runner 的分片 worker 不装 DOM stub，
// 任何调用 createChannelIcon() 的用例都会让整个文件崩在加载期。
// DOM 形态由 settingsEditorPane / channelView / channelEditorPane 三处调用点保证。
//
// 目标：
//   1) 图标表的 key 必须与 CHANNEL_DEFINITIONS 对齐（防 typo / 渠道改名漏改）；
//   2) 每条数据必须是可渲染的 SVG（viewBox 合法、path 非空、品牌色格式正确）；
//   3) **锁定「未收录即 emoji 兜底」的渠道白名单** —— 防止将来有人拿近似品牌凑数
//      （例如用 WeChat 顶替 WeCom、用某解析库的 "lark" 图标顶替飞书）。

import assert from 'assert';
import { CHANNEL_DEFINITIONS } from '../../common/constants.js';
import { CHANNEL_LOGOS, channelSectionLabel, readableBrandColor } from '../../browser/channelIcons.js';

/**
 * 仍无品牌 SVG、只能 emoji 兜底的渠道。
 *
 * 2026-09-22 网络检索后从 5 个收敛到 2 个：feishu / tlon / nostr 已补齐官方或 CC0 矢量
 * （见 channelIcons.ts 的 `official:` / `community-cc0:` 条目）。剩下的两个原因明确：
 *   · irc    —— 协议而非品牌；候选是第三方客户端图标且为 CC BY-SA 4.0，许可档位不同。
 *   · yuanbao—— Iconify 里的 yuanbao 图形（thesvg=站点 AI 创作 UI 图标 / mingcute=金元宝）
 *              都不是品牌标记，官网仅 PNG ⇒ 不用近似品牌凑数。
 */
const EXPECTED_FALLBACK_KEYS = ['irc', 'yuanbao'];

suite('渠道品牌图标 · CHANNEL_LOGOS 数据完整性', () => {
	const definitionKeys = CHANNEL_DEFINITIONS.map(d => d.key as string).sort();
	const logoKeys = Object.keys(CHANNEL_LOGOS).sort();

	test('每个图标 key 都是真实存在的渠道（防 typo / 改名漏改）', () => {
		for (const key of logoKeys) {
			assert.ok(definitionKeys.includes(key), `CHANNEL_LOGOS 中的 '${key}' 不在 CHANNEL_DEFINITIONS 里`);
		}
	});

	test('覆盖绝大部分渠道，且未收录的恰好只剩白名单那两个', () => {
		assert.ok(logoKeys.length >= 20, `品牌图标太少：${logoKeys.length}`);
		const missing = definitionKeys.filter(k => !logoKeys.includes(k));
		assert.deepStrictEqual(missing, EXPECTED_FALLBACK_KEYS, '未收录渠道发生变化 → 请同步核对是否「张冠李戴」地用了近似品牌');
	});

	test('每条数据都能渲染成合法 SVG（viewBox / path / 品牌色）', () => {
		// slug 前缀 = 来源可信级别；未知前缀说明有人塞了来源不明的图形（务必人工复核）
		const PROVENANCE = ['simple-icons:', 'iconify:', 'official:', 'community-cc0:'];
		for (const key of logoKeys) {
			const logo = CHANNEL_LOGOS[key as keyof typeof CHANNEL_LOGOS]!;
			assert.ok(PROVENANCE.some(p => logo.slug.startsWith(p)), `${key}: slug 来源不明（${logo.slug}）`);
			if (logo.slug.startsWith('official:')) {
				// official: 必须能指认到具体站点资源（domain/path），否则「官方」二字无意义
				assert.match(logo.slug.slice('official:'.length), /^[\w.-]+\.[a-z]{2,}\/.+/, `${key}: official slug 未指向站点资源（${logo.slug}）`);
			}
			assert.ok(logo.brand.length > 0, `${key}: 缺 brand`);
			assert.match(logo.viewBox, /^-?\d+(\.\d+)? -?\d+(\.\d+)? \d+(\.\d+)? \d+(\.\d+)?$/, `${key}: viewBox 非法（${logo.viewBox}）`);
			assert.ok(logo.paths.length > 0, `${key}: 无 path`);
			if (logo.color !== undefined) {
				assert.match(logo.color, /^#[0-9a-fA-F]{6}$/, `${key}: 品牌色格式非法（${logo.color}）`);
			}
			for (const p of logo.paths) {
				assert.ok(p.d.length > 20, `${key}: path 过短（${p.d.length}）`);
				assert.match(p.d.trim(), /^[Mm]/, `${key}: path 未以 moveto 起始`);
			}
		}
	});

	test('同一品牌的子渠道复用同一份字形（zalo / zalouser）', () => {
		const zalo = CHANNEL_LOGOS['zalo']!;
		const zalouser = CHANNEL_LOGOS['zalouser']!;
		assert.strictEqual(zalouser.slug, zalo.slug);
		assert.strictEqual(zalouser.paths[0].d, zalo.paths[0].d);
	});

	test('抽样核对真实性：whatsapp 路径与 Simple Icons 源一致（防数据被误替换）', () => {
		assert.strictEqual(CHANNEL_LOGOS['whatsapp']!.slug, 'simple-icons:whatsapp@14');
		assert.strictEqual(CHANNEL_LOGOS['whatsapp']!.color, '#25D366');
		assert.ok(
			CHANNEL_LOGOS['whatsapp']!.paths[0].d.startsWith('M17.472 14.382c-.297-.149'),
			'whatsapp 路径首段与官方 SVG 不符',
		);
	});

	test('微信系渠道各自指向正确的品牌（wecom=企业微信 / openclaw-weixin=WeChat）', () => {
		assert.strictEqual(CHANNEL_LOGOS['wecom']!.slug, 'iconify:tdesign:logo-wecom');
		assert.strictEqual(CHANNEL_LOGOS['openclaw-weixin']!.slug, 'simple-icons:wechat@14');
		// 企业微信自带官方配色（多色 logo）→ 不得再被单色覆盖
		assert.strictEqual(CHANNEL_LOGOS['wecom']!.color, undefined);
	});
});

suite('渠道品牌图标 · 条目标题不重复 logo（2026-09-22 回归）', () => {
	// 缺陷现象：设置页「Channel 配置」下每个渠道条目的 logo 显示两遍 ——
	//   icon 槽渲染了一枚 emoji，标题里又拼了同一个 `def.icon`。
	// 修复约定：标题是纯文本，图标只由 icon 槽渲染（品牌 SVG，未收录则 emoji 兜底）。
	test('渠道条目标题是纯文本：不得再拼 icon emoji', () => {
		for (const def of CHANNEL_DEFINITIONS) {
			const title = channelSectionLabel(def);
			assert.strictEqual(title, def.label, `${def.key}: 标题应就是 def.label`);
			assert.ok(
				!title.includes(def.icon),
				`${def.key}: 标题里出现了 icon（${def.icon}）⇒ icon 槽 + 标题会各显示一次，即同一个 logo 两遍`,
			);
		}
	});

	test('每个渠道条目都有可渲染的 logo（品牌 SVG 或 emoji 兜底，不会留空白）', () => {
		const missing: string[] = [];
		for (const def of CHANNEL_DEFINITIONS) {
			const hasBrandSvg = !!CHANNEL_LOGOS[def.key];
			const hasEmojiFallback = typeof def.icon === 'string' && def.icon.length > 0;
			if (!hasBrandSvg && !hasEmojiFallback) {
				missing.push(def.key);
			}
		}
		assert.deepStrictEqual(missing, [], '这些渠道既无品牌 SVG 也无 emoji 兜底');
	});
});

suite('渠道品牌图标 · readableBrandColor', () => {
	test('无品牌色 → currentColor', () => {
		assert.strictEqual(readableBrandColor(undefined), 'currentColor');
		assert.strictEqual(readableBrandColor(''), 'currentColor');
	});

	test('过暗品牌色回退 currentColor（深色主题下不可辨）', () => {
		// Matrix 官方色就是纯黑；Slack 的 #4A154B 在 #1e1e1e 上几乎看不见
		assert.strictEqual(readableBrandColor('#000000'), 'currentColor');
		assert.strictEqual(readableBrandColor('#4A154B'), 'currentColor');
	});

	test('常规品牌色原样保留', () => {
		for (const c of ['#25D366', '#26A5E4', '#5865F2', '#9146FF', '#B5B5B6']) {
			assert.strictEqual(readableBrandColor(c), c, `${c} 不应被改写`);
		}
	});

	test('非 #rrggbb 形式原样返回（交给 CSS 处理）', () => {
		assert.strictEqual(readableBrandColor('red'), 'red');
		assert.strictEqual(readableBrandColor('rgb(1,2,3)'), 'rgb(1,2,3)');
		assert.strictEqual(readableBrandColor('#000'), '#000', '三位简写不解析 → 原样返回');
	});

	test('缺省 # 的 6 位十六进制可解析，但返回值保持原样（不做格式化）', () => {
		assert.strictEqual(readableBrandColor('25d366'), '25d366');
		assert.strictEqual(readableBrandColor('000000'), 'currentColor', '同样能识别出过暗 → currentColor');
	});
});
