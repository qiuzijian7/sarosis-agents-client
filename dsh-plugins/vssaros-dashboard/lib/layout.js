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
/** 单张卡的行数上限（**顺序流**语义：`h` 是最小高度，不该有人填到几十行）。 */
export const MAX_ROWS = 30;
/**
 * **自由摆放**下的行数上限（`y` 与 `h` 都用它）。
 *
 * ⚠ 为什么必须比 `MAX_ROWS` 大得多：顺序流里 `h` 是"最小高度"，而自由摆放里 `h` 是**真实高度** ——
 *   一页 8 张卡按实测高度换算下来轻松超过 100 行。第一版沿用 30 ⇒ 装箱时 y 全被夹到 29，
 *   8 张卡叠在同一行（真机复现：拖一张卡，其余全部互相压住 ✗）。
 */
export const MAX_ROWS_FREE = 400;
/**
 * 行高 / 间距 / 页宽上限（px；`maxWidth` 的 0 = 不限宽）。
 *
 * ⚠ `gap` 的历史：P1 是等价重构，为了"出厂默认视觉与改造前一致"曾把 `DEFAULT_GAP` 定成 **0**
 *   （改造前是自然堆叠，没有网格间距）。**2026-10-23 用户反馈"组件中间太密集"** ⇒ 卡片彼此紧贴、
 *   描边挨着描边，读起来是一整块。现在默认 **12px**：卡片之间才看得出"几块独立面板"。
 *   旧的布局文件（`version < 2`）里若显式存了 `gap: 0`，读入时**自动迁移**成新默认（见 `normalizeLayoutFile`）。
 *
 * ⚠ 2026-10-13（P3）：`h` 的语义定成「**最小高度**（行）」—— 卡片高度仍由内容撑，
 *   `h` 只加下限：`min-height = h * var(--dash-row) + (h-1) * var(--dash-gap)`。
 *   因此 `--dash-row` 必须是**小刻度**（24px）：出厂默认 `h` 是 1 / 1 / 3 ⇒ 24 / 24 / 72px，
 *   都低于各自内容高度 ⇒ 卡片高度仍由内容决定 ✓；把 `h` 拉大（缩放手柄）才看得见效果 ✓。
 */
export const DEFAULT_ROW_HEIGHT = 24;
export const DEFAULT_GAP = 12;
export const DEFAULT_MAX_WIDTH = 0;
/**
 * 布局版本号（P2 起写进落盘 JSON）。
 *
 * `2`（2026-10-23）：默认间距 0 → 12px。读 `version < 2` 的文件时会把显式存的 `gap: 0` 迁到新默认；
 *   比当前版本**更新**的文件按当前形状尽量读，但会提示（未来字段读不懂，硬猜更危险）。
 */
export const LAYOUT_VERSION = 2;

/**
 * 出厂默认布局。
 *
 * ★ 2026-10-23（用户：「主页中，要求第一个默认显示工作台组件」）：**工作台排第一** ——
 *   它是主页最主要的入口（13 个模块的磁贴网格），比"我先看到几个数字"更该先出现。
 *   其余顺序保持：关键指标 → 诊断行 → 会话明细。
 * ⚠ `h` 是**最小高度**（行）；工作台给 3 行（72px）兜底，实际高度由磁贴网格撑开。
 */
export const DEFAULT_LAYOUT = [
	{ id: 'workbench', kind: 'workbench', w: GRID_COLUMNS, h: 3 },
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
 * 渲染期再由渲染层决定给不给占位卡（2026-10-22 起是 React 的 `MissingCard`，见 lib/app/src/app.jsx）。
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
	// ⚠ 坐标是**可选**的：两个都给才认（只给一个 = 数据半套，宁可当没给 ⇒ 回落顺序流，不猜）。
	//   `x` 是列号 0..11，`y` 是行号；**有坐标时 `h` 是真实高度**，所以上限用 MAX_ROWS_FREE。
	const placed = raw.x !== undefined && raw.y !== undefined;
	const item = {
		kind,
		w: clampInt(raw.w, 1, GRID_COLUMNS, GRID_COLUMNS),
		h: clampInt(raw.h, 1, placed ? MAX_ROWS_FREE : MAX_ROWS, 1),
		config,
	};
	if (placed) {
		item.x = clampInt(raw.x, 0, GRID_COLUMNS - 1, 0);
		item.y = clampInt(raw.y, 0, MAX_ROWS_FREE - 1, 0);
	}
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
	// 只有"比当前版本更新"才提示：老版本是**可迁移**的（v1→v2 只影响默认间距，见 `normalizeLayoutFile`），
	// 一律报"版本不对"会让每次读老文件都弹一条无意义的"被自动纠正"（用户以为出事了）。
	if (Number.isFinite(raw.version) && raw.version > LAYOUT_VERSION) {
		repaired.push(`布局版本 ${raw.version} 比当前 ${LAYOUT_VERSION} 新 ⇒ 尽量按当前形状读（新字段会被忽略）`);
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
		mode: normalizeMode(raw.mode),
	};
}

/** 布局模式：`flow`（顺序流，默认）/ `free`（自由 x/y 摆放）。认不出来一律回落 `flow`。 */
export const LAYOUT_MODES = ['flow', 'free'];

export function normalizeMode(value) {
	return value === 'free' ? 'free' : 'flow';
}

/**
 * 顺序流 → 自由摆放坐标（**从 flow 切到 free 时的那一次换算**）。
 *
 * 规则：按数组顺序**贪心装箱** —— 一行放不下（`x + w > 12`）就换行，换行时行高取该行最高的那张。
 * ⚠ `h` 在 free 模式下是**真实高度**（行），不再是"最小高度" ⇒ 切换前调用方必须先把
 *   每张卡的实测高度换算成行（见 `app.jsx` 的 `measureRows`），否则 h=1 的卡只有 24px 高、内容全溢出 ✗。
 */
export function packFlow(items) {
	let cursorX = 0;
	let cursorY = 0;
	let rowHeight = 0;
	return items.map(item => {
		const w = clampInt(item.w, 1, GRID_COLUMNS, GRID_COLUMNS);
		// 装箱结果带坐标 ⇒ `h` 是真实高度，上限用 MAX_ROWS_FREE（见上面那条注释）
		const h = clampInt(item.h, 1, MAX_ROWS_FREE, 1);
		if (cursorX + w > GRID_COLUMNS) {
			cursorX = 0;
			cursorY += rowHeight;
			rowHeight = 0;
		}
		const placed = { ...item, x: cursorX, y: cursorY, w, h };
		cursorX += w;
		rowHeight = Math.max(rowHeight, h);
		return placed;
	});
}

/** 自由摆放 → 顺序流（切回 flow 时把坐标**剥掉**，不留下半套数据）。 */
export function stripPlacement(items) {
	return items.map(item => {
		const { x, y, ...rest } = item;
		return rest;
	});
}

/** 这一份布局是不是自由摆放（两张都有坐标才算 —— 与 `normalizeItem` 同口径）。 */
export function hasPlacement(items) {
	return Array.isArray(items) && items.some(item => Number.isFinite(item?.x) && Number.isFinite(item?.y));
}

/** 两个格子矩形是否相交（自由摆放的碰撞判定，**唯一一处**实现；页面侧也从这里 import）。 */
export function rectsOverlap(a, b) {
	return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * 自由摆放的**网格压实**（"整理"按钮才调，不在拖拽过程中调）。
 *
 * 规则（按 (y, x) 顺序逐张）：先尽量**向上**顶到 0 或撞到已放置的卡，再尽量**向左**顶
 * （跨列填洞），然后再回头试着往上 —— 因为往左挪完，上面可能又空出来了。
 * 单卡最多来回 `MAX_ROUNDS` 轮，保证终止。
 *
 * 与旧版（只动 y）的区别：**横向的洞也会被填**（Grafana 那种"看起来该并拢"的效果）。
 * 代价：用户左右摆的相对位置可能被并拢 ⇒ 所以它只在**显式点「整理」**时发生，拖拽过程中绝不自动跑。
 *
 * 只处理带坐标的项；顺序流（没有 x/y）的项原样返回。
 */
const COMPACT_MAX_ROUNDS = 64;

export function compactGrid(items) {
	const next = (Array.isArray(items) ? items : []).map(item => ({ ...item }));
	const placed = [];
	const ordered = next
		.filter(item => Number.isFinite(item.x) && Number.isFinite(item.y))
		.sort((a, b) => (a.y - b.y) || (a.x - b.x));

	const free = (probe, others) => probe.x >= 0 && probe.y >= 0
		&& probe.x + probe.w <= GRID_COLUMNS
		&& others.every(other => !rectsOverlap(probe, other));

	for (const item of ordered) {
		let { x, y } = item;
		for (let round = 0; round < COMPACT_MAX_ROUNDS; round++) {
			let moved = false;
			// ① 向上
			while (y > 0 && free({ ...item, x, y: y - 1 }, placed)) { y -= 1; moved = true; }
			// ② 向左（跨列填洞）
			while (x > 0 && free({ ...item, x: x - 1, y }, placed)) { x -= 1; moved = true; }
			if (!moved) { break; }
		}
		item.x = x;
		item.y = y;
		placed.push(item);
	}
	return next;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 多套布局（预设）—— 2026-10-22
 *
 * ⚠ **落盘形状的兼容策略**：P2 时代的文件是单布局（顶层 `items` / `settings`）。
 *   `normalizeLayoutFile` 两种形状都读：老形状**在内存里**包成 `presets.default`，
 *   **不写盘**（"读一页不该产生文件"那条纪律不能破 ✓）；真正落新形状只在写口发生。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 预设名的最大长度（中文 24 字够长，且不会把工具栏撑坏）。 */
export const PRESET_NAME_MAX = 24;
/** 老布局升级后落进的名字（也是"至少留一个"的那个）。 */
export const DEFAULT_PRESET_NAME = 'default';

/** 预设名归一化：trim + 截断；空/非字符串 ⇒ `undefined`（调用方据此判"非法名字"）。 */
export function normalizePresetName(raw) {
	if (typeof raw !== 'string') {
		return undefined;
	}
	const name = raw.trim().slice(0, PRESET_NAME_MAX);
	return name || undefined;
}

/**
 * 落盘文件 → `{ version, active, presets: Map<name, { items, settings, updatedAt, repaired }>, repaired }`。
 *
 * 两种输入形状都认（见上面的兼容策略）；**任何坏输入都不会抛**：
 * 最差也会得到一份"只有 default、内容是出厂默认"的文件（并带上 `repaired` 说明）。
 */
export function normalizeLayoutFile(raw) {
	const repaired = [];
	const presets = new Map();
	const source = raw && typeof raw === 'object' && raw.presets && typeof raw.presets === 'object' && !Array.isArray(raw.presets)
		? raw.presets
		: undefined;
	/**
	 * v1 → v2 的**间距迁移**（2026-10-23）：
	 *   v1 时代默认间距是 0（等价重构期），用户一旦保存过布局，`gap: 0` 就被显式写进文件 ——
	 *   光改 `DEFAULT_GAP` 对**这些文件没用**（它们不是"缺省"，是"存了 0"）。
	 *   ⇒ 读 `version < 2` 的文件时，把显式的 `gap: 0` 提到新默认；v2 之后 `gap: 0` 是用户真的想要 0，原样保留。
	 * ⚠ 不写进 `repaired`：这是版本升级的既定迁移，不是"文件坏了"，报出来只会让用户以为出问题。
	 */
	const fileVersion = Number.isFinite(raw?.version) ? raw.version : 1;
	const migrateSettings = settings => {
		if (!settings || fileVersion >= LAYOUT_VERSION || settings.gap !== 0) { return settings; }
		return { ...settings, gap: DEFAULT_GAP };
	};

	if (source) {
		for (const [rawName, value] of Object.entries(source)) {
			const name = normalizePresetName(rawName);
			if (!name) {
				repaired.push('丢掉一个名字非法的预设');
				continue;
			}
			if (presets.has(name)) {
				repaired.push(`丢掉重名的预设 ${name}`);
				continue;
			}
			const normalized = normalizeLayout(value);
			presets.set(name, {
				items: normalized.items,
				settings: migrateSettings(normalizeSettings(value?.settings)),
				updatedAt: normalized.updatedAt,
				repaired: normalized.repaired,
			});
			for (const line of normalized.repaired) {
				repaired.push(`预设 ${name}：${line}`);
			}
		}
	} else if (raw && typeof raw === 'object' && Array.isArray(raw.items)) {
		// 老形状（单布局）⇒ 整份当作 default
		const normalized = normalizeLayout(raw);
		presets.set(DEFAULT_PRESET_NAME, {
			items: normalized.items,
			settings: migrateSettings(normalizeSettings(raw.settings)),
			updatedAt: normalized.updatedAt,
			repaired: normalized.repaired,
		});
		for (const line of normalized.repaired) {
			repaired.push(`预设 ${DEFAULT_PRESET_NAME}：${line}`);
		}
		if (raw.presets !== undefined) {
			repaired.push('presets 不是对象 ⇒ 按老的单布局读');
		}
	}

	if (presets.size === 0) {
		presets.set(DEFAULT_PRESET_NAME, { items: defaultLayout(), settings: undefined, updatedAt: 0, repaired: [] });
		repaired.push('没有任何可用预设 ⇒ 建了一个出厂默认的 default');
	}

	let active = normalizePresetName(raw?.active);
	if (active && !presets.has(active)) {
		repaired.push(`active 指向不存在的预设 ${active} ⇒ 已改到 default`);
		active = undefined;
	}
	if (!active) {
		active = presets.has(DEFAULT_PRESET_NAME) ? DEFAULT_PRESET_NAME : [...presets.keys()][0];
	}

	return { version: LAYOUT_VERSION, active, presets, repaired };
}

/** `normalizeLayoutFile` 的结果 → 落盘对象（`presets` 用普通对象 + 稳定字段顺序，diff 不抖）。 */
export function serializeLayoutFile(file) {
	const presets = {};
	for (const [name, value] of file.presets) {
		presets[name] = {
			...(value.settings ? { settings: value.settings } : {}),
			updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
			items: value.items,
		};
	}
	return { version: LAYOUT_VERSION, active: file.active, presets };
}

/** 当前生效的那一份（`normalizeLayoutFile` 保证 `active` 一定有对应项 ⇒ 不会 undefined）。 */
export function activePresetOf(file) {
	return file.presets.get(file.active);
}

/**
 * 文本型配置的归一化（`configFields` 的 `type: 'text'`）。
 * 只认字符串；`trim` 后为空 ⇒ 回落 `fallback`；超出 `maxLength` ⇒ **截断**（不是拒绝：
 * 拒绝会让用户"打着打着字没了"，截断至少是可见、可继续编辑的）。
 */
export function textOf(value, maxLength, fallback = '') {
	if (typeof value !== 'string') { return fallback; }
	const trimmed = value.trim();
	if (!trimmed) { return fallback; }
	return trimmed.slice(0, Math.max(1, clampInt(maxLength, 1, 500, 40)));
}

/** 布局 → CSS 变量（页内网格用它；P1 只暴露，不靠它改变默认视觉）。 */
export function layoutCssVars({ rowHeight = DEFAULT_ROW_HEIGHT, gap = DEFAULT_GAP, maxWidth = DEFAULT_MAX_WIDTH } = {}) {
	return {
		row: `${clampInt(rowHeight, 24, 400, DEFAULT_ROW_HEIGHT)}px`,
		gap: `${clampInt(gap, 0, 48, DEFAULT_GAP)}px`,
		maxWidth: clampInt(maxWidth, 0, 10000, DEFAULT_MAX_WIDTH) > 0 ? `${clampInt(maxWidth, 0, 10000, DEFAULT_MAX_WIDTH)}px` : 'none',
	};
}
