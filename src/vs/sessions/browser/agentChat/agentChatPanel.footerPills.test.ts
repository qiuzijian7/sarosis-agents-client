/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 用量药丸统一入口的**契约测试**（2026-09-18）。
 *
 * 为什么需要：用户报「聊天框中 token / 耗时 / 积分 样式不统一」——根因是三处各自拼 DOM
 * （主气泡 pill ✓ / 子代理卡 pill ✓ / delegate 卡 emoji 纯文本 ✗）。
 * 收敛到 `appendFooterPill()` 后，**只要这个入口的 DOM 结构与数字格式不漂移**，
 * 三处就永远一致 ✓；反之若有人绕过它自拼 DOM，就又会分叉 ✗。
 * 故本测试锁住：① 结构与类名 ② 数字格式口径 ③ 可选件（ⓘ / valueClass）的边界。
 *
 * 运行：
 *   node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *        src/vs/sessions/browser/agentChat/agentChatPanel.footerPills.test.ts
 */
import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
	appendFooterPill,
	formatCreditAmount,
	formatDurationMs,
	formatTokenCount,
} from './agentChatPanel.footerPills.js';

/** 建一个挂载点（等价于 footer / dlg-meta-row / chat-footer-processing）。 */
function host(): HTMLElement {
	return document.createElement('div');
}

suite('用量药丸统一入口 appendFooterPill（2026-09-18）', () => {

	test('★★★ 三种 kind 的 DOM 结构与类名一致（只有图标与种类类名不同）', () => {
		const h = host();
		const d = appendFooterPill(h, 'duration', '4.5s');
		const t = appendFooterPill(h, 'tokens', '12,345');
		const c = appendFooterPill(h, 'credit', '0.42');

		// 共同父类名：三处展示位据此共享同一套 CSS（图标/圆角/间距/深色主题）✓
		for (const pill of [d, t, c]) {
			assert.ok(pill.classList.contains('chat-bubble-footer-item'), '必须有 chat-bubble-footer-item');
			assert.ok(pill.classList.contains('chat-footer-pill'), '必须有 chat-footer-pill');
			// 结构固定：图标 + 数值（顺序不可变，CSS 依赖首个子节点做图标定位）
			assert.strictEqual(pill.children.length, 2, '基础形态应恰好为「图标 + 数值」两个子节点');
			assert.ok(pill.children[0].classList.contains('chat-footer-pill-icon'), '首个子节点必须是图标');
			assert.ok(pill.children[1].classList.contains('chat-footer-pill-value'), '次个子节点必须是数值');
		}

		// 种类类名（既有 DOM 查询与 CSS 都依赖，改名即破坏 ✗）
		assert.ok(d.classList.contains('duration-item'));
		assert.ok(t.classList.contains('tokens-item'));
		assert.ok(c.classList.contains('credit-item'));

		// 图标按 kind 区分，且必须是 codicon（不许 emoji —— 那正是被统一掉的旧样式 ✗）
		const iconOf = (el: HTMLElement) => el.children[0].className;
		assert.ok(iconOf(d).includes('codicon-watch'), `耗时图标应为 codicon-watch，实际 ${iconOf(d)}`);
		assert.ok(iconOf(t).includes('codicon-clippy'), `token 图标应为 codicon-clippy，实际 ${iconOf(t)}`);
		assert.ok(iconOf(c).includes('codicon-credit-card'), `积分图标应为 codicon-credit-card，实际 ${iconOf(c)}`);
		for (const pill of [d, t, c]) {
			assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(pill.textContent ?? ''), '文本里不得再出现 emoji');
		}
	});

	test('★★★ 数字格式只有一份口径（token 千分位 / 积分两位小数 / 耗时三段）', () => {
		// token：千分位全量（此前 delegate 卡用 12.3k 缩写，导致同一数字两种读法 ✗）
		assert.strictEqual(formatTokenCount(0), '0');
		assert.strictEqual(formatTokenCount(12345), (12345).toLocaleString());
		assert.strictEqual(formatTokenCount(1234567), (1234567).toLocaleString());
		// 积分：固定两位小数
		assert.strictEqual(formatCreditAmount(0.4), '0.40');
		assert.strictEqual(formatCreditAmount(3.055), '3.06');
		// 耗时：<1s → ms；<60s → s（一位小数）；≥60s → m + s
		assert.strictEqual(formatDurationMs(250), '250ms');
		assert.strictEqual(formatDurationMs(4500), '4.5s');
		assert.strictEqual(formatDurationMs(72000), '1m 12s');
	});

	test('★★ ⓘ 只在显式要求时出现（否则会污染不需要明细浮层的位置）', () => {
		const h = host();
		const plain = appendFooterPill(h, 'tokens', '12,345');
		const withInfo = appendFooterPill(h, 'tokens', '12,345', { withInfoIcon: true });
		assert.strictEqual(plain.querySelector('.chat-footer-pill-info'), null, '默认不得有 ⓘ');
		assert.ok(withInfo.querySelector('.chat-footer-pill-info'), 'withInfoIcon 时必须追加 ⓘ');
		assert.strictEqual(withInfo.children.length, 3, 'ⓘ 追加在数值之后');
	});

	test('★★ valueClass 只落到数值节点（抗抖动约定：不得改字体/颜色）', () => {
		const h = host();
		const pill = appendFooterPill(h, 'duration', '9s', { valueClass: 'chat-footer-processing-elapsed' });
		const value = pill.children[1] as HTMLElement;
		assert.ok(value.classList.contains('chat-footer-pill-value'), '数值节点基础类名不可少');
		assert.ok(value.classList.contains('chat-footer-processing-elapsed'), 'valueClass 必须生效');
		// 关键：秒级刷新靠类名取节点（_tickProcessingElapsed）⇒ 它必须能在药丸内被查到 ✓
		assert.ok(pill.querySelector('.chat-footer-processing-elapsed'), '按类名查询必须命中（秒级刷新依赖）');
		assert.strictEqual(pill.children[0].className.includes('chat-footer-processing-elapsed'), false, 'valueClass 不得落到图标上');
	});

	test('★★ title 默认按 kind 给，可被覆盖（tooltip 是用户理解图标的唯一线索）', () => {
		const h = host();
		assert.strictEqual(appendFooterPill(h, 'duration', '1s').title, '耗时');
		assert.strictEqual(appendFooterPill(h, 'tokens', '1').title, 'Tokens');
		assert.strictEqual(appendFooterPill(h, 'credit', '1.00').title, '积分');
		const custom = appendFooterPill(h, 'tokens', '1', { title: 'token 消耗：输入 1 / 输出 0' });
		assert.strictEqual(custom.title, 'token 消耗：输入 1 / 输出 0');
	});

	test('★ 返回药丸元素本身（供调用方挂 tokens-popup 明细浮层）', () => {
		const h = host();
		const pill = appendFooterPill(h, 'tokens', '12,345');
		let popup: HTMLElement | null = null;
		// 模拟 messages.ts 的用法：明细浮层必须能挂进药丸内（CSS 用 :hover 显示）
		popup = pill;
		// 返回值即药丸；此处直接断言父子关系可用（避免误返回数值节点导致浮层挂错位置）
		assert.strictEqual(popup.children[1].textContent, '12,345', '返回值必须是药丸，而非数值节点');
	});
});

// ─── 处理中态 + 标签（2026-09-19）──────────────────────────────────────────

/**
 * 背景（用户 2026-09-19 报）：「处理中 UI 要增加 积分 / tokens / 耗时，并且聊天框各个位置的
 * 积分、tokens、耗时**图标要保持一致**」。
 *
 * 当时的事实是：
 *   · 主气泡**完成态**手搓 DOM（`图标 + 标签 + ：值`，且冒号一处全角一处半角 ✗）；
 *   · 委派卡**完成态**走 `appendFooterPill`（`图标 + 值`，无标签 ✗）；
 *   · 主气泡**处理中**只有 `spinner + 处理中 + 耗时`（**没有图标** ✗✗）；
 *   · 子代理**处理中**只有 `spinner + tokens + 积分`（**没有耗时** ✗）。
 * ⇒ 四处形态互不相同 ✓。收敛后：**图标/类名/数字格式只有一份** ✓，
 *   处理中共三项且都带 `live`（"进行中"视觉）✓。
 *
 * 本 suite 钉住新增的两个可选项，防止后人再"就地拼 DOM"✗。
 */
suite('处理中态与标签（2026-09-19）', () => {

	test('★★★ live 选项：处理中药丸必须带 live 类（蓝色描边 + 图标呼吸，与完成态区分）', () => {
		const h = host();
		const d = appendFooterPill(h, 'duration', '1m 27s', { valueClass: 'chat-footer-processing-elapsed', live: true });
		const t = appendFooterPill(h, 'tokens', '12,345', { valueClass: 'chat-footer-processing-tokens', live: true });
		const c = appendFooterPill(h, 'credit', '0.42', { valueClass: 'chat-footer-processing-credit', live: true });
		for (const pill of [d, t, c]) {
			assert.ok(pill.classList.contains('live'), '处理中药丸必须带 live 类（否则与完成态无法区分）');
			assert.ok(pill.classList.contains('chat-footer-pill'), 'live 不改变基础形态');
		}
		// 图标仍必须是统一口径（用户明确要求"各个位置图标一致"）
		const iconOf = (el: HTMLElement): string => (el.querySelector('.chat-footer-pill-icon') as HTMLElement | null)?.className ?? '';
		assert.ok(iconOf(d).includes('codicon-watch'), '耗时图标必须仍是 codicon-watch');
		assert.ok(iconOf(t).includes('codicon-clippy'), 'token 图标必须仍是 codicon-clippy');
		assert.ok(iconOf(c).includes('codicon-credit-card'), '积分图标必须仍是 codicon-credit-card');
	});

	test('★★★ 不带 live 时不得出现 live 类（完成态不能被画成"进行中"）', () => {
		const h = host();
		assert.ok(!appendFooterPill(h, 'duration', '4.5s').classList.contains('live'));
		assert.ok(!appendFooterPill(h, 'tokens', '1').classList.contains('live'));
		assert.ok(!appendFooterPill(h, 'credit', '0.00').classList.contains('live'));
	});

	test('★★★ withLabel：标签为「耗时：/Tokens：/积分：」，且数值节点里**不得再带冒号**', () => {
		const h = host();
		const d = appendFooterPill(h, 'duration', '4.5s', { withLabel: true });
		const t = appendFooterPill(h, 'tokens', '12,345', { withLabel: true });
		const c = appendFooterPill(h, 'credit', '0.42', { withLabel: true });
		// 结构：图标 + 标签 + 数值（三个子节点）
		assert.strictEqual(d.children.length, 3, 'withLabel 时结构应为「图标 + 标签 + 数值」');
		const labelOf = (el: HTMLElement): string => (el.querySelector('.chat-footer-pill-label') as HTMLElement | null)?.textContent ?? '';
		assert.strictEqual(labelOf(d), '耗时：');
		assert.strictEqual(labelOf(t), 'Tokens：');
		assert.strictEqual(labelOf(c), '积分：');
		// ⚠ 关键：冒号只在标签里，数值节点保持纯数字（此前一处 `：0.42` 一处 `: 12,345` ✗ ⇒ 无法核对）
		const valueOf = (el: HTMLElement): string => (el.querySelector('.chat-footer-pill-value') as HTMLElement | null)?.textContent ?? '';
		assert.strictEqual(valueOf(d), '4.5s');
		assert.strictEqual(valueOf(t), '12,345');
		assert.strictEqual(valueOf(c), '0.42');
	});

	test('★★ 处理中组合用法（valueClass + live）在 DOM 上同时成立', () => {
		const h = host();
		const pill = appendFooterPill(h, 'duration', '9s', { valueClass: 'chat-footer-processing-elapsed', live: true });
		const value = pill.querySelector('.chat-footer-pill-value') as HTMLElement | null;
		assert.ok(value, '必须有数值节点');
		assert.ok(value!.classList.contains('chat-footer-processing-elapsed'), '抗抖动类必须挂在数值节点上');
		assert.ok(pill.classList.contains('live'), 'live 必须挂在药丸本体上');
	});
});

// ─── 三类药丸的顺序不变量（2026-09-19）──────────────────────────────────────

/**
 * 用户要求：「保证 积分、tokens、耗时 三个 UI 的**顺序在各个位置保持不变**」✓。
 *
 * 为什么必须由**构建入口**排序，而不是各调用点按顺序写 ✗：
 *   `tokens` / `积分` 是**流式陆续到达**的 ⇒ 谁先创建不确定 ✗；
 *   若只靠"先 append 的先在左" ⇒ 同一行会在运行中**换位** ✗✗。
 * 故 `appendFooterPill` 按 `PILL_ORDER`（耗时 0 → tokens 1 → 积分 2 ✓）**插入到正确位置** ✓，
 * 与调用顺序、数据到达顺序都无关 ✓。本 suite 就把这条钉住 ✓。
 */
suite('三类药丸顺序不变量（2026-09-19）', () => {

	/** 取容器里药丸的顺序（按种类类名；非三类记为 other）。 */
	const orderOf = (h: HTMLElement): string[] => {
		const kinds = ['duration-item', 'tokens-item', 'credit-item'];
		return Array.from(h.children)
			.filter(c => c.classList.contains('chat-footer-pill'))
			.map(c => kinds.find(k => c.classList.contains(k)) ?? 'other');
	};

	test('★★★ 乱序创建 ⇒ DOM 顺序恒为 耗时 → Tokens → 积分', () => {
		const h = host();
		// 刻意按「倒序 + 跳序」创建：积分 → 耗时 → tokens（最坏情形 ✓）
		appendFooterPill(h, 'credit', '0.42');
		appendFooterPill(h, 'duration', '4.5s');
		appendFooterPill(h, 'tokens', '12,345');
		assert.deepStrictEqual(orderOf(h), ['duration-item', 'tokens-item', 'credit-item'],
			'顺序必须由构建入口决定，与创建顺序无关 ✗');
	});

	test('★★★ 处理中实时场景：先有耗时，tokens/积分随后到达 ⇒ 仍为正序', () => {
		const h = host();
		appendFooterPill(h, 'duration', '9s', { valueClass: 'chat-footer-processing-elapsed', live: true });
		assert.deepStrictEqual(orderOf(h), ['duration-item']);
		// 数据陆续到达（真实顺序：usage delta 先给 tokens，再给积分 ✓）
		appendFooterPill(h, 'tokens', '12,345', { valueClass: 'chat-footer-processing-tokens', live: true });
		appendFooterPill(h, 'credit', '0.42', { valueClass: 'chat-footer-processing-credit', live: true });
		assert.deepStrictEqual(orderOf(h), ['duration-item', 'tokens-item', 'credit-item'],
			'流式到达后不得换位 ✗（这正是"顺序不稳定"的根因 ✓）');
	});

	test('★★★ 反向到达（积分先于 tokens 到达）也必须归位', () => {
		const h = host();
		appendFooterPill(h, 'duration', '9s');
		appendFooterPill(h, 'credit', '0.42');   // 积分先到（某些网关可能只先给积分 ✓）
		appendFooterPill(h, 'tokens', '12,345'); // tokens 后到 ⇒ 必须插到积分**前面** ✓
		assert.deepStrictEqual(orderOf(h), ['duration-item', 'tokens-item', 'credit-item']);
	});

	test('★★ 非本约定的子元素不受影响（复制按钮 / 分隔线在前，「已中断」恒在最后）', () => {
		const h = host();
		const copy = document.createElement('button'); copy.className = 'chat-msg-copy-btn'; h.appendChild(copy);
		const sep = document.createElement('div'); sep.className = 'chat-bubble-footer-sep'; h.appendChild(sep);
		const interrupted = document.createElement('span');
		interrupted.className = 'chat-bubble-footer-item chat-footer-pill interrupted-item';
		h.appendChild(interrupted);
		// 刻意在「已中断」**之后**才建三类药丸（现实代码是之前建 ✓）⇒ 也必须插到它前面 ✓
		appendFooterPill(h, 'credit', '0.1');
		appendFooterPill(h, 'duration', '1s');
		assert.strictEqual(h.children[0], copy, '复制按钮位置不动');
		assert.strictEqual(h.children[1], sep, '分隔线位置不动');
		assert.strictEqual(h.children[h.children.length - 1], interrupted, '「已中断」必须恒在最后 ✓');
		// ⚠ orderOf 会把「已中断」记为 other（它不是三类之一 ✓）⇒ 期望里要带上它 ✓，
		//   而且要排在最后 —— 这正是"非三类药丸视为最大顺序"的**行为证据** ✓
		assert.deepStrictEqual(orderOf(h), ['duration-item', 'credit-item', 'other']);
	});

	test('★★ 缺中间项时插入仍正确（只建耗时 + 积分）', () => {
		const h = host();
		appendFooterPill(h, 'credit', '0.42');
		appendFooterPill(h, 'duration', '4.5s');
		assert.deepStrictEqual(orderOf(h), ['duration-item', 'credit-item']);
	});
});

// ─── 配色不变量：三类药丸必须**黑白灰**（2026-09-19，用户截图要求）────────────

/**
 * 背景（用户截图）：处理中的三药丸 `18.8s / 58,200 / 0.66` 是**蓝色** ✗，
 * 要求「统一 tokens、积分、耗时的 UI 样式（黑白灰）」✓。
 *
 * 蓝色的**唯一来源**是两个"被当中性色用"的主题强调色 ✗：
 *   · `--vscode-progressBar-background`（**进度条填充色**，真机里是蓝色 ✗、且不透明 ✓）—— 曾用于 live 态；
 *   · `--vscode-focusBorder`（焦点蓝 ✗）—— 曾用于 hover 描边。
 * 修法：配色**单点**收敛到 `.chat-bubble-footer-item.chat-footer-pill` 上的 `--pill-*` 变量，
 * 全部由 `--vscode-foreground` 按百分比混出灰阶 ✓
 * （深色主题 foreground=白 ⇒ 白/灰 ✓；浅色主题 foreground=黑 ⇒ 黑/灰 ✓ = "黑白灰" ✓✓）。
 * 三类药丸 × 四个展示位（主气泡完成态/处理中、委派卡、子代理 ✓）因此**自动同色** ✓。
 *
 * 真实计算色已用「**真实 CSS + 真实主题变量**」的预览页核过（15/15 全部 GRAY ✓，
 * 教训见 MEMORY：预览页不注入主题变量会命中 fallback ⇒ 掩盖真机问题 ✗）；
 * 这里只能做**源码级**断言，锁住"结构不漂移"（不引入蓝色变量、不出现按种类的颜色规则 ✓）。
 */
suite('用量药丸配色：黑白灰不变量（2026-09-19）', () => {

	const CSS_REL = 'src/vs/sessions/browser/agentChat/media/agentChat.css';

	/** 读仓库内文件（测试从仓库根跑 ⇒ 路径相对 cwd ✓，与 `wsSwitchDiag.test.ts` 的 read 同法 ✓）。 */
	const readFile = (rel: string): string => {
		const abs = path.join(process.cwd(), rel);
		assert.ok(fs.existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
		return fs.readFileSync(abs, 'utf8');
	};

	/** 取「药丸区块」：pill 基础规则 → live 呼吸动画（中间只夹着 interrupted 块 ✓）。
	 *  ⚠ 刻意**不含**其后的 spinner 规则 ✓ —— 蓝色 spinner 是「进行中」信号，不属这三类用量 ✓。 */
	const pillSection = (): string => {
		const css = readFile(CSS_REL);
		const marker = css.indexOf('── Pill 样式 badge');
		// ⚠ 起点要**回退到注释开头** ✓ —— 否则切片从注释中间开始，`stripComments` 匹配不到那个
		//   `/*` ⇒ 注释内容会被当成"活代码"，测试假红 ✗（首次运行就踩了这个坑 ✓）。
		const start = css.lastIndexOf('/*', marker);
		const end = css.indexOf('@keyframes footer-pill-live-pulse');
		assert.ok(start > 0 && end > start, '定位不到药丸区块（注释被改动？）');
		return css.slice(start, end);
	};

	/** 去掉 CSS 注释 ⇒ 只对**活代码**做断言 ✓（注释里会刻意提到"不能用的蓝色变量"作为教训 ✓）。 */
	const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

	test('★★★ 配色必须由 --pill-* 单点定义，且基准是 --vscode-foreground（⇒ 灰阶 ✓）', () => {
		const s = stripComments(pillSection());
		assert.ok(s.includes('--pill-fg: var(--vscode-foreground'), '配色基准必须是 foreground（深色=白、浅色=黑 ⇒ 黑白灰 ✓）');
		for (const v of ['--pill-border:', '--pill-border-strong:', '--pill-bg:', '--pill-bg-strong:']) {
			assert.ok(s.includes(v), `缺少 ${v} —— 三类药丸靠这组变量保持一致 ✗`);
		}
	});

	test('★★★ 药丸区块内不得出现蓝色主题变量（progressBar-background / focusBorder ✗）', () => {
		// ⚠ 只查**活代码**：注释里提到这两个变量是**刻意保留的教训** ✓（"为何不能用它当底色"），
		//   若连注释一起查 ⇒ 测试会红 ✗（首次运行即如此 ✓）。这条与 composerHeight 回归同一原则：
		//   「注释可以解释、活代码不行」✓
		const code = stripComments(pillSection());
		assert.ok(!code.includes('progressBar-background'), 'live 态不得再用"进度条蓝" ✗（用户要求黑白灰）');
		assert.ok(!code.includes('focusBorder'), 'hover 描边不得再用"焦点蓝" ✗（用户要求黑白灰）');
	});

	test('★★ live 与 hover 都复用 --pill-*（不得各自写死颜色 ✗），且保留呼吸动画', () => {
		const s = stripComments(pillSection());
		assert.ok(s.includes('.chat-footer-pill.live {'), 'live 规则必须存在（"进行中"信号 ✓）');
		assert.ok(s.includes('border-color: var(--pill-border-strong)'), 'live 应是"加深一档灰"，而不是换色 ✗');
		assert.ok(s.includes('background: var(--pill-bg-strong)'), 'live 背景同理必须是灰 ✓');
		assert.ok(s.includes('animation: footer-pill-live-pulse'), 'live 的"进行中"信号保留图标呼吸 ✓');
	});

	test('★ 三类不得有各自的颜色规则（duration / tokens / credit 必须共用同一套 ✓）', () => {
		const s = stripComments(pillSection());
		for (const cls of ['.duration-item', '.tokens-item', '.credit-item']) {
			assert.ok(!s.includes(cls), `${cls} 不应出现在配色区块（三类配色必须完全一致 ✗）`);
		}
	});
});

// ─── 零值可见性：0 是真实读数，不是"没数据"（2026-09-20，用户要求）──────────────

/**
 * 用户要求：「运行时右下角的 耗时/积分/token UI 中，**当积分为 0 时，也要显示 token 和积分**」✓。
 * 口径：字段 **undefined** = 没数据（不显示 ✓）；字段 **= 0** = 真实读数（**必须显示** ✓）——
 * 与积分侧 07-27 的既有裁定一致（`credit !== undefined` 即显示 ✓）。
 * 修前：tokens 两处门控是 `total > 0` ✗（处理中 + 完成态都吞 0 ✗）。
 */
suite('用量药丸零值可见性（2026-09-20）', () => {

	const MSG_REL = 'src/vs/sessions/browser/agentChat/agentChatPanel.messages.ts';
	const readMsg = (): string => {
		const abs = path.join(process.cwd(), MSG_REL);
		assert.ok(fs.existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
		return fs.readFileSync(abs, 'utf8');
	};
	/** 去掉块/行注释 ⇒ 只对活代码断言 ✓（注释里会刻意保留旧写法作教训 ✓）。 */
	const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

	test('★★★ 处理中 tokens/积分必须**常驻**（数据未到显示 0 占位 ✗ 不再消失）', () => {
		// 2026-09-20 二次反馈：usage delta 是「每个 LLM 轮次末块」才发 ⇒ 第一轮没跑完
		// 就没有数据 ⇒ 旧「有数据才显示」口径下 runtime 只有耗时 ✗。⇒ 处理中常驻 ✓。
		const code = strip(readMsg());
		assert.ok(code.includes('formatTokenCount(tu?.total ?? 0)'),
			'处理中 tokens 必须 0 占位常驻（tu?.total ?? 0 ✗）');
		assert.ok(code.includes('formatCreditAmount(tu?.credit ?? 0)'),
			'处理中积分必须 0 占位常驻（tu?.credit ?? 0 ✗）');
		assert.ok(!code.includes('tu.total !== undefined && tu.total > 0'),
			'处理中 tokens 不得再有 > 0 门控 ✗');
	});

	test('★★★ 完成态 tokens 门控保持「字段存在即显示」（不得再要 total > 0 ✗）', () => {
		const code = strip(readMsg());
		assert.ok(!code.includes('msg.tokenUsage?.total !== undefined && msg.tokenUsage.total > 0'),
			'完成态 tokens 又出现了 > 0 门控 ⇒ credit=0 时 tokens pill 会消失 ✗');
	});

	test('★★ 完成态积分门控保持「存在即显示」（防回退 ✓）；处理中常驻不误伤完成态 ✓', () => {
		const code = strip(readMsg());
		assert.ok(code.includes('msg.tokenUsage?.credit !== undefined'),
			'完成态积分必须是 !== undefined（0 也显示 ✓）');
		// 处理中常驻只应改 `_syncProcessingUsagePills` ✓ —— 完成态构建不得被 0 占位 ✗
		assert.ok(!code.includes('formatCreditAmount(msg.tokenUsage.credit ?? 0)'),
			'完成态积分不得改成 0 占位（无 credit 字段的旧消息不该冒出 pill ✗）');
	});

	test('★★★ 完成态必须有「用量药丸补建」（usage 晚于 done ⇒ footer 需重刷 ✗）', () => {
		// 2026-09-20 截图：完成态只有「耗时: 57.2S」✗，而处理中正常 ✓ ——
		// 因为完成态 footer 只创建一次、之后 tokenUsage 更新不重建 footer ✗✓。
		const base = strip(fs.readFileSync(path.join(process.cwd(),
			'src/vs/sessions/browser/agentChat/agentChatPanel.base.ts'), 'utf8'));
		assert.ok(base.includes('this._refreshDoneUsagePills(m)'),
			'updateMessage 必须在 tokenUsage 更新时触发补建 ✗');
		assert.ok(base.includes('if (updates.tokenUsage !== undefined)'),
			'补建必须以 tokenUsage 更新为触发条件 ✓');
		const msg = strip(readMsg());
		assert.ok(msg.includes('protected override _refreshDoneUsagePills('),
			'messages 侧必须实现补建 ✓');
		assert.ok(msg.includes('bubble.appendChild(this._createFooter(msg))'),
			'补建必须复用唯一构建入口 _createFooter（否则 DOM/顺序/浮层会分叉 ✗）');
	});

	test('★★★ 子代理处理中 tokens/积分同样**常驻**（2026-09-20 截图：1m33s 只有耗时 ✗）', () => {
		const abs = path.join(process.cwd(),
			'src/vs/sessions/browser/agentChat/agentChatPanel.delegateCards.ts');
		assert.ok(fs.existsSync(abs), `源码不存在：${abs}`);
		const code = strip(fs.readFileSync(abs, 'utf8'));
		// 与主气泡同口径：undefined / 0 都显示 0 ✓（数据到达后随重渲染覆盖 ✓）
		assert.ok(code.includes('formatTokenCount(typeof saTotal === \'number\' ? saTotal : 0)'),
			'子代理处理中 tokens 必须 0 占位常驻 ✗');
		assert.ok(code.includes('formatCreditAmount(typeof saCredit === \'number\' ? saCredit : 0)'),
			'子代理处理中积分必须 0 占位常驻 ✗');
		assert.ok(!code.includes('typeof saTotal === \'number\' && saTotal > 0'),
			'子代理 tokens 不得再有 > 0 门控 ✗');
	});
});
