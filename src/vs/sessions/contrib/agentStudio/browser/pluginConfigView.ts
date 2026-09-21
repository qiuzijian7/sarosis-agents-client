/*---------------------------------------------------------------------------------------------
 *  Plugin 详情页「Configuration」区的**渲染**（只依赖 DOM，不 import 任何 VS Code 模块）。
 *
 *  设计演进（2026-09-21 方案 A，已与用户确认效果图 docs/settings-mockup.html）：
 *    v1 一节扁平列表、每项占一整行 —— pocket 40 项（28 设置 + 12 按钮）时又长又混；
 *    v2 分组 + 过滤 + 紧凑开关行 + 底部 sticky 保存（零滚动仍做不到，找「桌面画面」要滚过 27 项）；
 *    v3（本文件）**左栏分组导航 + 右栏卡片 + 顶部状态条 + 快捷操作卡 + 高级折叠**：
 *        · 左栏点一下即切换右侧内容 ⇒ 找一项从「滚动查找」变成「一次点击」；
 *        · 状态条把「手机能不能连 / 公网开没开 / 远程键鼠生效没」提到最上面（数据由调用方探测，失败即隐藏）；
 *        · `x-action` 按钮从「列表项」变成按用途分行的按钮（快捷操作卡），可标主色/危险；
 *        · `x-advanced` 的低频项进「高级」（左栏独立入口，默认收起）。
 *
 *  不依赖 VS Code 模块 ⇒ 可用 jsdom 直接单测（见 test/browser/pluginConfigView.test.ts），
 *  也便于单独渲染出来做视觉核对。**分组、紧凑化、改动检测等决策都在 `pluginConfigLayout.ts`。**
 *--------------------------------------------------------------------------------------------*/

import { ConfigFieldKind } from './pluginConfigLayout.js';

/** 字段上下文：自定义控件（agents / models 展开列表）通过它回写值并触发刷新。 */
export interface IConfigFieldContext {
	readonly key: string;
	readonly value: unknown;
	setValue(value: unknown): void;
	/** 通知视图重算「已修改」标记与计数（不传值，仅刷新状态） */
	notify(): void;
}

export interface IConfigFieldInput {
	key: string;
	/** 显示名（已本地化 / 已由键名格式化） */
	label: string;
	/** 描述文本（markdown 链接请解析到 links） */
	description?: string;
	links?: readonly { label: string; url: string }[];
	type: string;
	value: unknown;
	defaultValue: unknown;
	kind: ConfigFieldKind;
	/** 动作按钮（kind === 'action'）：点击执行，不参与保存 */
	actionId?: string;
	/** 动作按钮所在行（同一行的按钮排在一起）；空 = 不进分行，直接流式排列 */
	actionRow?: string;
	/** 主操作（用主色按钮） */
	primary?: boolean;
	/** 危险操作（红色按钮 + 需要二次确认的说明） */
	danger?: boolean;
	placeholder?: string;
	/** 敏感值（token / password）→ 密码输入框 */
	secret?: boolean;
	min?: number;
	max?: number;
	step?: number;
	/** 枚举选项（string 类型且给出时渲染为下拉框） */
	options?: readonly { value: string; label: string }[];
	/** array 类型的文本域行数 */
	rows?: number;
	/** 自定义控件（返回 null 则走内置渲染） */
	custom?: (ctx: IConfigFieldContext) => HTMLElement | null;
}

export interface IConfigGroupInput {
	id: string;
	/** 扩展声明的分组标题；null = 未声明（渲染层用 fallbackTitles 取名） */
	title: string | null;
	/** 分组副标题（扩展在 section 上写的 description） */
	subtitle?: string;
	/** 左栏导航里的小图标（扩展在 section 上写的 x-icon；可空） */
	icon?: string;
	/** 'advanced' 低频聚合组 / 'actions' 操作组（快速访问） / 'normal' 常规组 */
	kind?: 'normal' | 'advanced' | 'actions';
	fields: readonly IConfigFieldInput[];
	/**
	 * 内嵌视图（由调用方创建好元素后交进来，例如插件详情页里的**内嵌访问面板**）。
	 * 视图只负责把它插进该分组的内容区，不关心里面是什么 —— 这样「页签内直接显示」不必把
	 * webview / iframe 之类的宿主逻辑塞进这个只依赖 DOM 的模块。
	 */
	embed?: {
		/** 已创建好的宿主元素（如 webview 容器） */
		element: HTMLElement;
		/** 内嵌区标题（可空） */
		title?: string;
		/** 一行说明（可空；例如「面板已内嵌在此，不再另开页面」） */
		hint?: string;
		/** 内嵌区右上角的小动作（如「刷新」「在新标签打开」） */
		actions?: readonly { label: string; onClick(): void }[];
	};
}

/** 顶部状态条的一项（数据由调用方探测；provider 失败时整条隐藏，不显示假状态）。 */
export interface IConfigStatusItem {
	label: string;
	value?: string;
	state?: 'ok' | 'off' | 'warn';
	/** 点它跳到哪个分组（省略则不可点） */
	groupId?: string;
	title?: string;
}

export interface IConfigViewLabels {
	filterPlaceholder: string;
	noMatch: string;
	/** 单字段「已修改」提示（用于小圆点 title） */
	modified: string;
	resetField: string;
	/** 「N 项已修改」 */
	modifiedSummary: (count: number) => string;
	save: string;
	saved: string;
	resetAll: string;
	/** 撤销本次未保存的改动（恢复到打开页面时的值） */
	undo: string;
	/** 兜底分组的标题（扩展未声明 section 时用）：按组内字段的性质取名 */
	fallbackTitles: Record<ConfigFieldKind, string> & { advanced: string };
	/** 子卡片标题 */
	quickActionsTitle: string;
	switchesTitle: string;
	valuesTitle: string;
	statusTitle: string;
	/** 高级组提示（改错会连不上之类） */
	advancedHint: string;
	/** 只读值复制 */
	copy: string;
	copied: string;
	/** 搜索结果提示 */
	searchHint: (count: number) => string;
}

export interface IConfigViewOptions {
	title: string;
	groups: readonly IConfigGroupInput[];
	labels: IConfigViewLabels;
	/** 状态条（省略/空数组 = 不渲染状态条） */
	statusItems?: readonly IConfigStatusItem[];
	onSave(): void;
	onResetAll(): void;
	onAction?(actionId: string, button: HTMLButtonElement): void;
}

export interface IConfigView {
	readonly element: HTMLElement;
	/** 当前值（保存时用） */
	getValues(): Map<string, unknown>;
	/** 尚未保存的改动项数 */
	modifiedCount(): number;
	setStatus(text: string, kind?: 'success' | 'error' | ''): void;
	focusFilter(): void;
	/** 外部探测完状态后回填（空数组则隐藏状态条） */
	setStatusItems(items: readonly IConfigStatusItem[]): void;
}

const KIND_ORDER: ConfigFieldKind[] = ['switch', 'value', 'readonly', 'action'];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) { node.className = className; }
	return node;
}

/** 「已修改」判定：与默认值比较（决策在 pluginConfigLayout，这里只调用传入的 compare）。 */
type ModifiedCompare = (current: unknown, defaultValue: unknown) => boolean;
type FilterMatch = (field: IConfigFieldInput, query: string) => boolean;

interface IFieldHandle {
	field: IConfigFieldInput;
	element: HTMLElement;
	/** 把值写回控件（重置 / 恢复默认 / 撤销后用） */
	applyValue(value: unknown): void;
}

/**
 * 是否参与「已修改」计数与标记：
 * 动作按钮没有值；只读派生值由插件自动维护，用户没「改」过，标成已修改只会误导。
 */
function isCountable(field: IConfigFieldInput): boolean {
	return field.kind === 'switch' || field.kind === 'value';
}

/** 复制到剪贴板：优先 Clipboard API，退回 textarea + execCommand（WebView / 老环境）。 */
async function copyText(text: string): Promise<boolean> {
	try {
		const nav = typeof navigator === 'undefined' ? null : navigator;
		if (nav?.clipboard && typeof nav.clipboard.writeText === 'function') {
			await nav.clipboard.writeText(text);
			return true;
		}
	} catch { /* 落到回退路径 */ }
	try {
		const area = document.createElement('textarea');
		area.value = text;
		area.setAttribute('readonly', 'readonly');
		area.style.position = 'fixed';
		area.style.opacity = '0';
		document.body.appendChild(area);
		area.select();
		const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
		area.remove();
		return ok;
	} catch {
		return false;
	}
}

/**
 * 渲染整个 Configuration 区。
 *
 * 布局：
 *   ┌ 标题 + 过滤框 + 「N 项已修改」
 *   ├ 状态条（局域网 / 公网 / 远程键鼠 / 上游 …，可空）
 *   ├ ┌ 左栏：分组导航（项数 + ● 已修改）… 全部重置为默认
 *   │ └ 右栏：当前分组的卡片（快捷操作 / 开关 / 需要填写 / 状态）
 *   └ sticky：状态提示 ………………… [撤销更改] [保存设置]
 */
export function renderConfigView(options: IConfigViewOptions, deps: { isModified: ModifiedCompare; matches: FilterMatch }): IConfigView {
	const { labels } = options;
	const values = new Map<string, unknown>();
	/** 打开页面时的值快照：用于「撤销更改」（把未保存的编辑回退） */
	const initialValues = new Map<string, unknown>();
	const handles: IFieldHandle[] = [];

	let activeGroupId = options.groups.length > 0 ? options.groups[0].id : '';

	const container = el('div', 'plugin-detail-section');

	// ─── 标题行：标题 + 过滤框 + 改动计数 ─────────────────────
	const header = el('div', 'plugin-detail-config-header');
	const title = el('h2', 'plugin-detail-section-title');
	title.textContent = options.title;
	header.appendChild(title);

	const toolbar = el('div', 'plugin-detail-config-toolbar');
	const filterInput = el('input', 'plugin-detail-config-filter');
	filterInput.type = 'text';
	filterInput.placeholder = labels.filterPlaceholder;
	filterInput.setAttribute('aria-label', labels.filterPlaceholder);
	const searchHint = el('span', 'plugin-detail-config-searchhint hidden');
	const modifiedBadge = el('span', 'plugin-detail-config-modified-badge');
	toolbar.append(filterInput, searchHint, modifiedBadge);
	header.appendChild(toolbar);
	container.appendChild(header);

	// ─── 状态条（可空：探测失败就不显示，避免假状态） ───────────
	const statusRow = el('div', 'plugin-detail-config-statusrow hidden');
	container.appendChild(statusRow);

	// ─── 主体：左栏导航 + 右栏内容 ───────────────────────────
	const split = el('div', 'plugin-detail-config-split');
	const nav = el('nav', 'plugin-detail-config-nav');
	const main = el('div', 'plugin-detail-config-main');
	split.append(nav, main);
	container.appendChild(split);

	const navItems = new Map<string, HTMLElement>();
	const paneElements = new Map<string, { element: HTMLElement; handles: IFieldHandle[]; title: string }>();

	for (const group of options.groups) {
		const isAdvanced = group.kind === 'advanced';
		const groupTitle = group.title ?? (isAdvanced
			? labels.fallbackTitles.advanced
			: labels.fallbackTitles[group.fields[0]?.kind ?? 'value'] ?? group.id);

		// ── 左栏项 ──
		const navItem = el('button', 'plugin-detail-config-navitem');
		navItem.type = 'button';
		if (isAdvanced) { navItem.classList.add('advanced'); }
		const iconEl = el('span', 'plugin-detail-config-navicon');
		iconEl.textContent = group.icon ?? (isAdvanced ? '⚙' : '•');
		const nameEl = el('span', 'plugin-detail-config-navname');
		nameEl.textContent = groupTitle;
		const modDot = el('span', 'plugin-detail-config-navmod hidden');
		const countEl = el('span', 'plugin-detail-config-navcount');
		countEl.textContent = String(group.fields.length);
		navItem.append(iconEl, nameEl, modDot, countEl);
		nav.appendChild(navItem);
		navItems.set(group.id, navItem);
		navItem.onclick = () => {
			// 搜索中点击分组 ⇒ 清空搜索，进入该分组（避免「点了没反应」）
			if (filterInput.value) { filterInput.value = ''; }
			activeGroupId = group.id;
			applyFilter();
			main.scrollTop = 0;
		};

		// ── 右栏内容 ──
		const pane = el('div', 'plugin-detail-config-pane');
		pane.dataset.groupId = group.id;
		const paneHead = el('div', 'plugin-detail-config-panehead');
		const paneTitle = el('h4', 'plugin-detail-config-panetitle');
		paneTitle.textContent = groupTitle;
		const paneCount = el('span', 'plugin-detail-config-panecount');
		paneCount.textContent = String(group.fields.length);
		paneHead.append(paneTitle, paneCount);
		pane.appendChild(paneHead);
		if (group.subtitle) {
			const sub = el('div', 'plugin-detail-config-panesub');
			sub.textContent = group.subtitle;
			pane.appendChild(sub);
		}
		if (isAdvanced) {
			const hint = el('div', 'plugin-detail-config-advhint');
			hint.textContent = labels.advancedHint;
			pane.appendChild(hint);
		}
		// 内嵌视图（如访问面板）排在该分组最上面：进页签就能直接看到，不必再点按钮跳页
		if (group.embed) {
			pane.appendChild(renderEmbed(group.embed));
		}

		const groupHandles: IFieldHandle[] = [];
		const byKind = new Map<ConfigFieldKind, IConfigFieldInput[]>();
		for (const kind of KIND_ORDER) { byKind.set(kind, []); }
		for (const field of group.fields) { byKind.get(field.kind)?.push(field); }

		for (const kind of KIND_ORDER) {
			const fields = byKind.get(kind) ?? [];
			if (fields.length === 0) { continue; }

			if (kind === 'action') {
				pane.appendChild(renderActionsCard(fields, groupHandles));
				continue;
			}
			if (kind === 'readonly') {
				pane.appendChild(renderReadonlyCard(fields, groupHandles));
				continue;
			}

			const card = createCard(kind === 'switch' ? labels.switchesTitle : labels.valuesTitle);
			const grid = el('div', kind === 'switch'
				? 'plugin-detail-config-grid plugin-detail-config-grid--compact'
				: 'plugin-detail-config-grid');
			for (const field of fields) {
				const handle = createField(field, kind);
				grid.appendChild(handle.element);
				groupHandles.push(handle);
			}
			card.appendChild(grid);
			pane.appendChild(card);
		}

		handles.push(...groupHandles);
		paneElements.set(group.id, { element: pane, handles: groupHandles, title: groupTitle });
		main.appendChild(pane);
	}

	// 左栏底部：全部重置为默认（低频但需要显眼可达 —— 效果图 ①）
	if (options.groups.length > 0) {
		const navFoot = el('div', 'plugin-detail-config-navfoot');
		const resetAllNavBtn = el('button', 'plugin-detail-config-navitem dangerish');
		resetAllNavBtn.type = 'button';
		const ri = el('span', 'plugin-detail-config-navicon');
		ri.textContent = '↺';
		const rn = el('span', 'plugin-detail-config-navname');
		rn.textContent = labels.resetAll;
		resetAllNavBtn.append(ri, rn);
		resetAllNavBtn.onclick = () => resetAllToDefaults();
		navFoot.appendChild(resetAllNavBtn);
		nav.appendChild(navFoot);
	}

	const emptyHint = el('div', 'plugin-detail-config-empty hidden');
	emptyHint.textContent = labels.noMatch;
	main.appendChild(emptyHint);

	// ─── 底部 sticky 操作条 ─────────────────────────────────
	const footer = el('div', 'plugin-detail-config-footer');
	const statusEl = el('div', 'plugin-detail-config-status');
	statusEl.id = 'plugin-config-status';
	const summaryEl = el('span', 'plugin-detail-config-footer-summary');
	const spacer = el('span', 'plugin-detail-config-footer-spacer');
	const undoBtn = el('button', 'plugin-detail-config-save-btn secondary');
	undoBtn.type = 'button';
	undoBtn.textContent = labels.undo;
	const saveBtn = el('button', 'plugin-detail-config-save-btn');
	saveBtn.type = 'button';
	saveBtn.textContent = labels.save;
	footer.append(statusEl, summaryEl, spacer, undoBtn, saveBtn);
	container.appendChild(footer);

	// ─── 子构建器 ───────────────────────────────────────────

	function createCard(cardTitle: string, extraClass = ''): HTMLElement {
		const card = el('div', `plugin-detail-config-card${extraClass ? ' ' + extraClass : ''}`);
		const head = el('div', 'plugin-detail-config-cardhead');
		head.textContent = cardTitle;
		card.appendChild(head);
		return card;
	}

	/**
	 * 内嵌视图（如访问面板）：标题 + 小动作 + 宿主元素。
	 * 宿主元素由调用方创建（webview / iframe 都行），这里只摆位置 —— 保持本模块零宿主依赖。
	 */
	function renderEmbed(embed: NonNullable<IConfigGroupInput['embed']>): HTMLElement {
		const box = el('div', 'plugin-detail-config-embed');
		const head = el('div', 'plugin-detail-config-embedhead');
		if (embed.title) {
			const t = el('span', 'plugin-detail-config-embedtitle');
			t.textContent = embed.title;
			head.appendChild(t);
		}
		for (const action of embed.actions ?? []) {
			const btn = el('button', 'plugin-detail-config-embedaction');
			btn.type = 'button';
			btn.textContent = action.label;
			btn.onclick = () => action.onClick();
			head.appendChild(btn);
		}
		if (embed.title || (embed.actions ?? []).length > 0) { box.appendChild(head); }
		if (embed.hint) {
			const hint = el('div', 'plugin-detail-config-embedhint');
			hint.textContent = embed.hint;
			box.appendChild(hint);
		}
		const host = el('div', 'plugin-detail-config-embedhost');
		host.appendChild(embed.element);
		box.appendChild(host);
		return box;
	}

	/** 动作按钮卡：按 `actionRow` 分行（未标注则流式），主色/危险按钮分样式。 */
	function renderActionsCard(fields: readonly IConfigFieldInput[], sink: IFieldHandle[]): HTMLElement {
		const card = createCard(labels.quickActionsTitle, 'actions');
		const rows = new Map<string, IConfigFieldInput[]>();
		const ungrouped: IConfigFieldInput[] = [];
		for (const field of fields) {
			if (field.actionRow) {
				if (!rows.has(field.actionRow)) { rows.set(field.actionRow, []); }
				rows.get(field.actionRow)!.push(field);
			} else {
				ungrouped.push(field);
			}
		}
		const renderRow = (rowFields: readonly IConfigFieldInput[], rowLabel?: string) => {
			const row = el('div', 'plugin-detail-config-actionrow');
			if (rowLabel) {
				const label = el('div', 'plugin-detail-config-actionrowlabel');
				label.textContent = rowLabel;
				row.appendChild(label);
			}
			const btns = el('div', 'plugin-detail-config-actions');
			for (const field of rowFields) {
				const handle = createField(field, 'action');
				btns.appendChild(handle.element);
				sink.push(handle);
			}
			row.appendChild(btns);
			card.appendChild(row);
		};
		if (ungrouped.length > 0) { renderRow(ungrouped); }
		for (const [rowLabel, rowFields] of rows) { renderRow(rowFields, rowLabel); }
		return card;
	}

	/** 只读派生值卡：键值对 + 一键复制（不参与「已修改」计数）。 */
	function renderReadonlyCard(fields: readonly IConfigFieldInput[], sink: IFieldHandle[]): HTMLElement {
		const card = createCard(labels.statusTitle);
		const kv = el('div', 'plugin-detail-config-kv');
		for (const field of fields) {
			// 一行 = key + value + 复制；用 display:contents 的包裹层，既能享受 grid 布局，
			// 又能在过滤时整行隐藏（只藏 value 会留下「孤零零的键」）
			const kvRow = el('div', 'plugin-detail-config-kvrow');
			const keyEl = el('div', 'plugin-detail-config-kvkey');
			keyEl.textContent = field.label;
			const valueEl = el('div', 'plugin-detail-config-kvvalue');
			const raw = field.value === undefined || field.value === null || field.value === '' ? '—' : String(field.value);
			valueEl.textContent = raw;
			valueEl.title = raw;
			const copyBtn = el('button', 'plugin-detail-config-copy');
			copyBtn.type = 'button';
			copyBtn.textContent = labels.copy;
			copyBtn.disabled = raw === '—';
			copyBtn.onclick = async () => {
				const ok = await copyText(raw);
				copyBtn.textContent = ok ? labels.copied : '×';
				setTimeout(() => { copyBtn.textContent = labels.copy; }, 1500);
			};
			kvRow.append(keyEl, valueEl, copyBtn);
			kv.appendChild(kvRow);
			sink.push({
				field,
				element: kvRow,
				applyValue: (next) => {
					const text = next === undefined || next === null || next === '' ? '—' : String(next);
					valueEl.textContent = text;
					valueEl.title = text;
					copyBtn.disabled = text === '—';
				},
			});
		}
		card.appendChild(kv);
		return card;
	}

	// ─── 行为 ───────────────────────────────────────────────

	/** 刷新「N 项已修改」+ 每个字段的标记 + 过滤结果。 */
	function refresh(): void {
		let count = 0;
		for (const handle of handles) {
			if (!isCountable(handle.field)) { continue; }
			const isModified = deps.isModified(values.get(handle.field.key), handle.field.defaultValue);
			if (isModified) { count += 1; }
			handle.element.classList.toggle('modified', isModified);
		}
		modifiedBadge.textContent = labels.modifiedSummary(count);
		modifiedBadge.classList.toggle('hidden', count === 0);
		summaryEl.textContent = count > 0 ? labels.modifiedSummary(count) : '';
		// 左栏「● 已修改」：按分组统计
		for (const [groupId, entry] of paneElements) {
			const modified = entry.handles.some(h => isCountable(h.field)
				&& deps.isModified(values.get(h.field.key), h.field.defaultValue));
			entry.element.classList.toggle('modified', modified);
			navItems.get(groupId)?.querySelector('.plugin-detail-config-navmod')?.classList.toggle('hidden', !modified);
		}
		applyFilter();
	}

	/**
	 * 过滤：空查询 = 只显示当前分组；有查询 = 跨分组显示命中项，并给出命中数。
	 *
	 * 计数只看**真正命中**的字段（动作按钮 / 只读值算命中项，但不因为「没被隐藏」而被计数）。
	 */
	function applyFilter(): void {
		const query = filterInput.value.trim();
		let hitCount = 0;
		for (const [groupId, entry] of paneElements) {
			let paneHits = 0;
			for (const handle of entry.handles) {
				const hit = deps.matches(handle.field, query);
				if (query) { handle.element.classList.toggle('hidden', !hit); }
				else { handle.element.classList.remove('hidden'); }
				if (query && hit) { paneHits += 1; }
			}
			// 每个子卡片 / 按钮行若全被隐藏，则整块收起（避免留空壳）
			for (const card of Array.from(entry.element.querySelectorAll('.plugin-detail-config-card, .plugin-detail-config-actionrow'))) {
				const children = Array.from(card.querySelectorAll('.plugin-detail-config-field, .plugin-detail-config-kvrow'));
				const hasVisible = children.length === 0 || children.some(c => !c.classList.contains('hidden'));
				card.classList.toggle('hidden', !hasVisible);
			}
			// 有查询 ⇒ 跨组视图（只显示有命中的分组）；无查询 ⇒ 只看当前组
			const showPane = query ? paneHits > 0 : groupId === activeGroupId;
			entry.element.classList.toggle('hidden', !showPane);
			hitCount += paneHits;
		}
		for (const [groupId, item] of navItems) {
			item.classList.toggle('active', !query && groupId === activeGroupId);
		}
		split.classList.toggle('searching', !!query);
		searchHint.classList.toggle('hidden', !query);
		if (query) { searchHint.textContent = labels.searchHint(hitCount); }
		emptyHint.classList.toggle('hidden', !query || hitCount > 0);
	}

	function resetAllToDefaults(): void {
		for (const handle of handles) {
			if (handle.field.kind === 'action' || handle.field.kind === 'readonly') { continue; }
			if (handle.field.defaultValue === undefined) { continue; }
			handle.applyValue(handle.field.defaultValue);
		}
		options.onResetAll();
	}

	function undoChanges(): void {
		for (const handle of handles) {
			if (handle.field.kind === 'action' || handle.field.kind === 'readonly') { continue; }
			handle.applyValue(initialValues.get(handle.field.key));
		}
		refresh();
	}

	function createField(field: IConfigFieldInput, kind: ConfigFieldKind): IFieldHandle {
		values.set(field.key, field.value);
		initialValues.set(field.key, field.value);
		const ctx: IConfigFieldContext = {
			key: field.key,
			get value() { return values.get(field.key); },
			setValue: (next) => { values.set(field.key, next); },
			notify: () => refresh(),
		};

		const row = el('div', kind === 'switch'
			? 'plugin-detail-config-field plugin-detail-config-field--compact'
			: 'plugin-detail-config-field');
		row.dataset.configKey = field.key;

		// ── 动作按钮：**只渲染按钮**（描述进 tooltip） ──
		// 早先这里把描述文字一起渲染出来，结果每个按钮都被长描述撑成"整行一个"的大块
		// （截图里那排又高又宽的按钮）；按钮只该占按钮本身的大小，靠 x-actionRow 分行即可。
		if (kind === 'action') {
			const btn = el('button', 'plugin-detail-config-action-btn');
			btn.type = 'button';
			btn.textContent = field.label;
			btn.title = field.description ?? field.label;
			if (field.primary) { btn.classList.add('primary'); }
			if (field.danger) { btn.classList.add('danger'); }
			btn.onclick = () => { options.onAction?.(field.actionId ?? field.key, btn); };
			row.classList.add('plugin-detail-config-field--action');
			row.appendChild(btn);
			return { field, element: row, applyValue: () => { /* 按钮无值 */ } };
		}

		// 标签 + 描述 + 已修改标记 + 单字段「恢复默认」
		const head = el('div', 'plugin-detail-config-head');
		const labelEl = el('label', 'plugin-detail-config-label');
		labelEl.textContent = field.label;
		labelEl.setAttribute('for', `config-${field.key}`);
		head.appendChild(labelEl);

		if (isCountable(field)) {
			const marker = el('span', 'plugin-detail-config-modified-dot');
			marker.textContent = '●';
			marker.title = labels.modified;
			head.appendChild(marker);
		}

		if (field.description || (field.links && field.links.length > 0)) {
			const desc = el('div', 'plugin-detail-config-desc');
			if (field.description) { desc.appendChild(document.createTextNode(field.description)); }
			for (const link of field.links ?? []) {
				const a = el('a', 'plugin-detail-config-link');
				a.textContent = link.label;
				a.href = link.url;
				a.title = link.url;
				a.onclick = (e) => { e.preventDefault(); window.open(link.url, '_blank', 'noopener'); };
				desc.appendChild(a);
			}
			head.appendChild(desc);
		}
		row.appendChild(head);

		// ── 控件 ──
		let control: HTMLElement;
		let syncControl = () => { /* 由各分支替换 */ };

		const custom = field.custom?.(ctx) ?? null;
		if (custom) {
			control = custom;
			// 自定义控件自己维护值；重置时重建它以反映默认值
			syncControl = () => {
				const rebuilt = field.custom?.(ctx) ?? null;
				if (rebuilt) { control.replaceWith(rebuilt); control = rebuilt; }
			};
		} else if (kind === 'readonly') {
			const valueEl = el('div', 'plugin-detail-config-readonly');
			const raw = field.value === undefined || field.value === null || field.value === '' ? '—' : String(field.value);
			valueEl.textContent = raw;
			valueEl.title = raw;
			control = valueEl;
			syncControl = () => {
				const next = values.get(field.key);
				const text = next === undefined || next === null || next === '' ? '—' : String(next);
				valueEl.textContent = text;
				valueEl.title = text;
			};
		} else if (field.type === 'boolean') {
			const toggle = el('label', 'plugin-detail-config-toggle');
			const checkbox = el('input');
			checkbox.type = 'checkbox';
			checkbox.id = `config-${field.key}`;
			checkbox.checked = !!field.value;
			checkbox.onchange = () => { values.set(field.key, checkbox.checked); refresh(); };
			toggle.appendChild(checkbox);
			toggle.appendChild(el('span', 'plugin-detail-config-toggle-slider'));
			control = toggle;
			syncControl = () => { checkbox.checked = !!values.get(field.key); };
		} else if (field.type === 'number') {
			const input = el('input', 'plugin-detail-config-input plugin-detail-config-input-number');
			input.type = 'number';
			if (field.min !== undefined) { input.min = String(field.min); }
			if (field.max !== undefined) { input.max = String(field.max); }
			if (field.step !== undefined) { input.step = String(field.step); }
			input.value = String(field.value ?? field.defaultValue ?? '');
			input.oninput = () => {
				values.set(field.key, input.value === '' ? undefined : Number(input.value));
				refresh();
			};
			control = input;
			syncControl = () => { input.value = String(values.get(field.key) ?? ''); };
		} else if (field.options && field.options.length > 0) {
			const select = el('select', 'plugin-detail-config-input plugin-detail-config-select');
			select.id = `config-${field.key}`;
			for (const option of field.options) {
				const opt = el('option');
				opt.value = option.value;
				opt.textContent = option.label;
				select.appendChild(opt);
			}
			select.value = String(field.value ?? '');
			select.onchange = () => { values.set(field.key, select.value); refresh(); };
			control = select;
			syncControl = () => { select.value = String(values.get(field.key) ?? ''); };
		} else if (field.type === 'array') {
			const textarea = el('textarea', 'plugin-detail-config-textarea');
			textarea.id = `config-${field.key}`;
			textarea.rows = field.rows ?? 4;
			textarea.placeholder = field.placeholder ?? '[]';
			textarea.value = Array.isArray(field.value) ? JSON.stringify(field.value, undefined, 2) : String(field.value ?? '[]');
			textarea.oninput = () => { values.set(field.key, textarea.value); refresh(); };
			control = textarea;
			syncControl = () => {
				const next = values.get(field.key);
				textarea.value = Array.isArray(next) ? JSON.stringify(next, undefined, 2) : String(next ?? '[]');
			};
		} else {
			const input = el('input', field.secret
				? 'plugin-detail-config-input plugin-detail-config-input-secret'
				: 'plugin-detail-config-input');
			input.type = field.secret ? 'password' : 'text';
			input.id = `config-${field.key}`;
			input.value = String(field.value ?? '');
			input.placeholder = field.placeholder ?? (field.defaultValue !== undefined ? String(field.defaultValue) : '');
			input.oninput = () => { values.set(field.key, input.value); refresh(); };
			control = input;
			syncControl = () => { input.value = String(values.get(field.key) ?? ''); };
		}
		row.appendChild(control);

		// 单字段「恢复默认」：只在「有默认值 + 可编辑」时出现
		if (field.defaultValue !== undefined && isCountable(field)) {
			const resetBtn = el('button', 'plugin-detail-config-reset');
			resetBtn.type = 'button';
			resetBtn.textContent = '↺';
			resetBtn.title = labels.resetField;
			resetBtn.onclick = () => {
				values.set(field.key, field.defaultValue);
				syncControl();
				refresh();
			};
			head.appendChild(resetBtn);
		}

		return {
			field,
			element: row,
			applyValue: (next) => { values.set(field.key, next); syncControl(); refresh(); },
		};
	}

	// ─── 状态条回填 ─────────────────────────────────────────
	function setStatusItems(items: readonly IConfigStatusItem[]): void {
		statusRow.replaceChildren();
		if (items.length === 0) { statusRow.classList.add('hidden'); return; }
		for (const item of items) {
			const pill = el('button', `plugin-detail-config-pill${item.state === 'warn' ? ' warn' : item.state === 'off' ? ' off' : ''}`);
			pill.type = 'button';
			const dot = el('span', 'plugin-detail-config-pilldot');
			const label = el('span', 'plugin-detail-config-pilllabel');
			label.textContent = item.value ? `${item.label} ${item.value}` : item.label;
			pill.append(dot, label);
			if (item.title) { pill.title = item.title; }
			if (item.groupId && paneElements.has(item.groupId)) {
				pill.classList.add('clickable');
				pill.onclick = () => {
					filterInput.value = '';
					activeGroupId = item.groupId!;
					applyFilter();
				};
			} else {
				pill.disabled = true;
			}
			statusRow.appendChild(pill);
		}
		statusRow.classList.remove('hidden');
	}

	// ─── 事件接线 ───────────────────────────────────────────
	filterInput.oninput = () => applyFilter();
	saveBtn.onclick = () => { options.onSave(); };
	undoBtn.onclick = () => undoChanges();

	setStatusItems(options.statusItems ?? []);
	refresh();

	return {
		element: container,
		getValues: () => values,
		modifiedCount: () => {
			let count = 0;
			for (const handle of handles) {
				if (!isCountable(handle.field)) { continue; }
				if (deps.isModified(values.get(handle.field.key), handle.field.defaultValue)) { count += 1; }
			}
			return count;
		},
		setStatus: (text, kind = '') => {
			statusEl.textContent = text;
			statusEl.className = `plugin-detail-config-status${kind ? ' ' + kind : ''}`;
		},
		focusFilter: () => filterInput.focus(),
		setStatusItems,
	};
}
