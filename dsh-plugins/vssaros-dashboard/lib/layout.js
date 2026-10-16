// @vssaros/dsh-dashboard — 首页布局：**纯函数**（不碰 I/O、不碰 DOM）。
//
// 为什么单独一层：布局的「归一化 / 重排 / 夹紧」是最容易出错、又最难从页面上看出来的部分
// （坏 JSON、越界数字、重复 id、未知 kind）。抽成纯函数后可以**脱离真机**逐条断言
// （见探针 `p3-38-dashboard-homepage-layout.mjs`），而不是靠"页面看起来对"。
//
// ⚠ 2026-10-13 引入（「dashboard → 可编排首页」P1：服务端组件化**等价重构**）：
//   P1 阶段页面仍渲染**出厂默认布局**；本文件的 `normalizeLayout` 由 P2（持久化）真正接上。

/** 网格列数（12 列制：与参考实现同口径，够表达"整行 / 半行 / 三分之一"）。 */
export const GRID_COLUMNS = 12;
/** 单张卡的行数上限。 */
export const MAX_ROWS = 30;
/**
 * 行高 / 间距 / 页宽上限（px；0 = 不限）。
 *
 * ⚠ `DEFAULT_GAP = 0` 是**刻意**的：P1 是等价重构，必须保证"出厂默认布局下的视觉与改造前一致"，
 * 而改造前是**自然堆叠**（`h2` / `.cards` 自带外边距，没有网格间距）⇒ 默认 0 才不会凭空多出缝隙。
 *
 * ⚠ 2026-10-13（P3）：`h` 的语义定成「**最小高度**（行）」—— 卡片高度仍由内容撑，
 *   `h` 只加下限：`min-height = h * var(--dash-row) + (h-1) * var(--dash-gap)`。
 *   因此 `--dash-row` 必须是**小刻度**（24px）：出厂默认 `h` 是 1 / 1 / 3 ⇒ 24 / 24 / 72px，
 *   **三个都低于各自内容高度 ⇒ 视觉与 P1 完全一致** ✓；而把 `h` 拉大（缩放手柄）才看得见效果 ✓。
 *   （定成 96px 就会让"诊断行"那张卡凭空多出一大截空白 ✗ —— 第一版就是这么写的。）
 */
export const DEFAULT_ROW_HEIGHT = 24;
export const DEFAULT_GAP = 0;
export const DEFAULT_MAX_WIDTH = 0;
/** 布局版本号（P2 起写进落盘 JSON；读入时不认识就回落出厂默认）。 */
export const LAYOUT_VERSION = 1;

/**
 * 出厂默认布局 —— **与改造前那三块的顺序逐一对应**（等价重构的锚）：
 *   ① 关键指标卡片组 ② 诊断行 ③ 会话明细。
 */
export const DEFAULT_LAYOUT = [
	{ id: 'kpi', kind: 'kpi', w: GRID_COLUMNS, h: 1 },
	{ id: 'diag', kind: 'diag', w: GRID_COLUMNS, h: 1 },
	{ id: 'sessions', kind: 'sessions', w: GRID_COLUMNS, h: 3 },
];

/** 出厂默认布局的**副本**（调用方随便改，不会污染常量）。 */
export function defaultLayout() {
	return DEFAULT_LAYOUT.map(item => ({ ...item, config: {} }));
}

/**
 * 整数夹紧（类型纠正 + 越界夹紧）。
 *
 * ⚠ 非有限值一律回落 `fallback`（**不是**夹到边界）：`w: "abc"` 与 `w: -3` 是两种错，
 * 前者该用默认值、后者该夹到 1 —— 混为一谈会把"数据坏了"伪装成"用户设了个小值"✗。
 */
export function clampInt(value, min, max, fallback) {
	const parsed = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, Math.round(parsed)));
}

/**
 * 单条布局项的归一化。返回 `undefined` 表示**整条丢掉**（连 kind 都没有 ⇒ 没有任何意义保留）。
 *
 * ⚠ **未知 kind 一律保留**（不在这里判存在性）：插件/组件装卸时用户的布局必须能回来，
 * 渲染期再由 `catalog.getWidget()` 决定给不给占位卡（参考实现同口径）。
 */
export function normalizeItem(raw) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return undefined;
	}
	const kind = typeof raw.kind === 'string' && raw.kind.trim() ? raw.kind.trim() : undefined;
	if (!kind) {
		return undefined;
	}
	// ⚠ id 缺省时**不在这里编**：`w-<kind>` 这种自动 id 会撞车（同一 kind 放两张卡时，第二张会被
	//   `normalizeLayout` 的去重规则当成"重复 id"**悄悄丢掉** ✗ —— 写这一层时真踩过）。
	//   ⇒ 自动 id 由 `normalizeLayout` 统一分配**唯一**值（见 `uniqueId`）。
	const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : undefined;
	const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : undefined;
	const config = raw.config && typeof raw.config === 'object' && !Array.isArray(raw.config) ? { ...raw.config } : {};
	const item = {
		kind,
		w: clampInt(raw.w, 1, GRID_COLUMNS, GRID_COLUMNS),
		h: clampInt(raw.h, 1, MAX_ROWS, 1),
		config,
	};
	if (id) {
		item.id = id;
	}
	if (title) {
		item.title = title;
	}
	return item;
}

/** 在 `seen` 里挑一个没被占用的 id（`w-kpi` → `w-kpi-2` → `w-kpi-3` …）。 */
function uniqueId(base, seen) {
	if (!seen.has(base)) {
		return base;
	}
	let n = 2;
	while (seen.has(`${base}-${n}`)) {
		n++;
	}
	return `${base}-${n}`;
}

/**
 * 整份布局的归一化：**读入即逐字段规整**（不是"整份坏才回落"）。
 *
 * 返回 `{ version, updatedAt, items, repaired }`：
 *   · `items` —— 一定可用（哪怕输入是 `null` / 字符串 / 空数组都不会抛）；
 *   · `repaired` —— 逐条说明"动过什么"，供页面如实展示（不静默 ✗）。
 *
 * ⚠ 空数组是**合法**布局（用户把组件全删了）⇒ **不**回落默认；只有"根本读不出 items"才回落。
 */
export function normalizeLayout(raw) {
	const repaired = [];
	if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) {
		return {
			version: LAYOUT_VERSION,
			updatedAt: 0,
			items: defaultLayout(),
			repaired: ['布局读不出来（缺失或不是对象）⇒ 已回落出厂默认'],
		};
	}
	if (raw.version !== undefined && raw.version !== LAYOUT_VERSION) {
		repaired.push(`布局版本 ${String(raw.version)} 不是当前版本 ${LAYOUT_VERSION} ⇒ 尽量按当前形状读`);
	}
	const items = [];
	const seen = new Set();
	// ★ 2026-10-13（用户要求「不允许重复添加组件」）：**同一 kind 只允许一张卡** ✓ ——
	//   第二张及以后**丢掉**，并**说明**（不静默 ✗ ⇒ 写进 `repaired`，页面会如实显示"N 处被纠正" ✓）。
	//   ⚠ 顺序要紧：先判**重复 id**、再判**重复 kind** —— 否则"同 id 的两张同名卡"会被报成"重复 kind"，
	//     原因指错地方 ✗（`p3-46` 对这两条的 repair 文案都有断言 ✓）。
	//   ⚠ 这条只在**读入**这一处生效 ⇒ 写口、渲染口、客户端全都不用各写一遍 ✓（用户已落盘的重复卡
	//     会在下一次渲染时被清掉，并在保存响应里报"被纠正"✓）。
	const seenKinds = new Set();
	for (const entry of raw.items) {
		const item = normalizeItem(entry);
		if (!item) {
			repaired.push('丢掉一条无效项（缺 kind）');
			continue;
		}
		if (item.id !== undefined && seen.has(item.id)) {
			repaired.push(`丢掉重复的组件 id ${item.id}`);
			continue;
		}
		if (seenKinds.has(item.kind)) {
			repaired.push(`丢掉重复的组件 ${item.kind}（同一组件只允许一张）`);
			continue;
		}
		// ⚠ 自动 id 仍必须**唯一**：不同 kind 也可能撞 id（例如手改文件时把 id 写成 `w-kpi` 重复 ✓）
		const id = item.id ?? uniqueId(`w-${item.kind}`, seen);
		seen.add(id);
		seenKinds.add(item.kind);
		items.push({ ...item, id });
	}
	const updatedAt = Number.isFinite(raw.updatedAt) ? Math.max(0, Math.floor(raw.updatedAt)) : 0;
	return { version: LAYOUT_VERSION, updatedAt, items, repaired };
}

/**
 * 把 `id` 移到 `beforeId` **之前**（`beforeId === null` ⇒ 移到末尾）。原地修改并返回"是否真的变了"。
 *
 * ⚠ 语义是**插入点**（beforeId）而不是索引算术：拖拽时拿到的是"落点卡"，换算成 beforeId 后
 * 再交给本函数 ⇒ 轴自适应 / 前后半判定那些逻辑都在外面，这里只做一次干净的数组操作 ✓。
 * ⚠ 注意 `before > from` 时要 `-1`（先摘后插会把目标位置前移一位）—— 这是本函数唯一的坑，
 * 探针里专门有一条断言钉它。
 */
export function moveBefore(items, id, beforeId) {
	const from = items.findIndex(item => item.id === id);
	const before = beforeId === null || beforeId === undefined
		? items.length
		: items.findIndex(item => item.id === beforeId);
	if (from < 0 || before < 0 || id === beforeId) {
		return false;
	}
	const to = before > from ? before - 1 : before;
	if (to === from) {
		return false;
	}
	const [moved] = items.splice(from, 1);
	items.splice(to, 0, moved);
	return true;
}

/**
 * 网格设置（行高 / 间距 / 页宽上限）的归一化。
 *
 * ⚠ 与 `layoutCssVars` 用**同一套夹紧**，且**两道都要有**：这一道在**落盘前**（挡手改/坏客户端），
 * `layoutCssVars` 那道在**渲染前**（页面不假设拿到的文件一定干净 ✓）。
 *
 * 返回 `undefined` = 没给设置（渲染期据此回落到行配置里的 `config.layout` ✓）。
 */
export function normalizeSettings(raw) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return undefined;
	}
	return {
		rowHeight: clampInt(raw.rowHeight, 24, 400, DEFAULT_ROW_HEIGHT),
		gap: clampInt(raw.gap, 0, 48, DEFAULT_GAP),
		maxWidth: clampInt(raw.maxWidth, 0, 10000, DEFAULT_MAX_WIDTH),
	};
}

/** 布局 → CSS 变量（页内网格用它；P1 只暴露，不靠它改变默认视觉）。 */
export function layoutCssVars({ rowHeight = DEFAULT_ROW_HEIGHT, gap = DEFAULT_GAP, maxWidth = DEFAULT_MAX_WIDTH } = {}) {
	return {
		row: `${clampInt(rowHeight, 24, 400, DEFAULT_ROW_HEIGHT)}px`,
		gap: `${clampInt(gap, 0, 48, DEFAULT_GAP)}px`,
		maxWidth: clampInt(maxWidth, 0, 10000, DEFAULT_MAX_WIDTH) > 0 ? `${clampInt(maxWidth, 0, 10000, DEFAULT_MAX_WIDTH)}px` : 'none',
	};
}
