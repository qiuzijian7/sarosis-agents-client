/*---------------------------------------------------------------------------------------------
 *  Plugin 详情页「Configuration」区的**布局决策**（纯逻辑：不 import 任何东西、不碰 DOM）。
 *
 *  为什么单独成文件：设置项从 8 个长到 40 个之后（例：pocket 28 项设置 + 12 个按钮），
 *  「一节扁平列表、每项占一整行」会让用户滚很久，而且分不清「按钮 / 开关 / 要填的值」。
 *  分组、紧凑化、过滤、改动检测这些决策集中在这里：
 *    - 易读：渲染代码只管画，判断逻辑都在这一处；
 *    - 可测：本文件零依赖，node 测试可直接加载（见 test/browser/pluginConfigLayout.test.ts）。
 *--------------------------------------------------------------------------------------------*/

/**
 * 布局关心的属性形状（`contributes.configuration.properties[key]` 的子集）。
 */
export interface IConfigPropertyLike {
	key: string;
	type: string;
	/** 声明的默认值（用于「已修改」判断与「恢复默认」） */
	default?: unknown;
	description?: string;
	markdownDescription?: string;
	/** `x-action`：该属性是**动作按钮**（执行命令），不是配置值 */
	action?: string;
	actionLabel?: string;
	/** `x-readonly`：插件自动维护的派生值，只读展示 */
	readOnly?: boolean;
	/** 由扩展 manifest 的 configuration **section 标题**给出（最权威的分组依据） */
	group?: string;
	/** 该分组的说明（section 上的 `description`，作为右侧内容区的副标题） */
	groupDescription?: string;
	/** 该分组的图标（section 上的 `x-icon`，左栏导航用；可空） */
	groupIcon?: string;
	/** `x-advanced`：低频/易错项，默认收进「高级」，不与其他项平铺（2026-09-21 方案 A） */
	advanced?: boolean;
}

/** configuration section（VS Code 允许 `contributes.configuration` 是对象或数组两种形态）。 */
export interface IConfigSectionSource {
	title?: string;
	/** 非标准字段：本产品用它当分组的副标题（对 VS Code 无害） */
	description?: string;
	properties?: Record<string, unknown>;
}

/**
 * 归一化 `contributes.configuration`：对象 / 数组（含 null、脏数据）都收敛成 section 列表。
 *
 * VS Code 原生设置页把数组形态的每一项当成一个**分组**渲染，所以这里保留 `title`
 * 与顺序 —— 扩展作者想控制分组顺序/标题时，这是唯一的官方通道。
 */
export function readConfigSections(configuration: unknown): IConfigSectionSource[] {
	if (Array.isArray(configuration)) {
		return configuration
			.filter((s): s is IConfigSectionSource => !!s && typeof s === 'object');
	}
	if (configuration && typeof configuration === 'object') {
		return [configuration as IConfigSectionSource];
	}
	return [];
}

/**
 * 不渲染也不保存的属性：内部标识（`*.agentId`）与已废弃的分组配置（`knot.models`）。
 * 抽出来是为了让「计数 / 过滤 / 保存」三处用同一套规则，避免计数与实际渲染不一致。
 */
export function isHiddenConfigProperty(prop: { key: string }): boolean {
	return prop.key.endsWith('.agentId') || prop.key === 'knot.models';
}

/** 分组类型：`declared` = 扩展自己声明的 section；`advanced` = 低频项聚合；其余是本页的兜底归类。 */
export type ConfigGroupKind = 'declared' | 'actions' | 'switches' | 'values' | 'advanced';

export interface IConfigGroup<T extends IConfigPropertyLike> {
	/** 稳定标识（declared 组用标题，兜底组用 kind），用于折叠状态记忆 */
	id: string;
	/** 扩展声明的标题；兜底组为 null（由渲染层本地化） */
	title: string | null;
	/** 分组副标题（扩展在 section 上写的 description） */
	description?: string;
	kind: ConfigGroupKind;
	props: T[];
}

/** 是否为「紧凑字段」：布尔开关可以一行放两个（label 左、开关右），不需要占一整行。 */
export function isCompactConfigField(prop: IConfigPropertyLike): boolean {
	return prop.type === 'boolean' && !prop.action && !prop.readOnly;
}

/** 字段的渲染种类 —— 决定它在组内的排布方式与顺序。 */
export type ConfigFieldKind = 'switch' | 'value' | 'readonly' | 'action';

export function configFieldKind(prop: IConfigPropertyLike): ConfigFieldKind {
	if (prop.action) { return 'action'; }
	if (prop.readOnly) { return 'readonly'; }
	return isCompactConfigField(prop) ? 'switch' : 'value';
}

/** 组内呈现顺序：开关 → 需填写的值 → 只读展示 → 按钮。稳定排序，不改动同类内的相对顺序。 */
const FIELD_KIND_ORDER: Record<ConfigFieldKind, number> = { switch: 0, value: 1, readonly: 2, action: 3 };

export function orderConfigFields<T extends IConfigPropertyLike>(props: readonly T[]): T[] {
	return [...props].sort((a, b) => FIELD_KIND_ORDER[configFieldKind(a)] - FIELD_KIND_ORDER[configFieldKind(b)]);
}

/**
 * 分组。规则（按优先级，全部确定性、无关键词猜测）：
 *  1. **只要有一个属性带 section 标题**（`group`）→ 按标题分组，顺序 = 首次出现顺序；
 *     没带标题的归入兜底组「其他设置」并排在最后。← 扩展作者可控，最权威；
 *  2. 否则按字段性质归三桶：**操作**（x-action 按钮）→ **开关**（布尔）→ **其他设置**。
 *
 * 空桶会被丢弃；只剩一个桶且不是 declared 时，`title` 为 null —— 渲染层据此省掉分组标题
 * （单个分组再套一层标题只是噪音）。
 *
 * 组**内**顺序由 `orderConfigFields` 决定（开关 / 值 / 只读 / 按钮），组**间**顺序即上面的规则。
 */
export function groupConfigProperties<T extends IConfigPropertyLike>(props: readonly T[]): IConfigGroup<T>[] {
	const visible = props.filter(p => !isHiddenConfigProperty(p));
	// 三块，各自的归属规则互不干扰：
	//   1. **操作**（x-action）：不管扩展有没有声明 section，都收进一个「快速访问」组并排在**最前**
	//      —— 详情页据此给它独立页签（用户要求：动作按钮不要再散在各个分组里）；
	//   2. 常规项：按声明 section 分组，没声明就按性质兜底；
	//   3. `x-advanced` 的低频项：汇总成最后一组（默认收起）。
	const actionProps = visible.filter(p => !!p.action);
	const withoutActions = visible.filter(p => !p.action);
	const advanced = withoutActions.filter(p => p.advanced === true);
	const normal = withoutActions.filter(p => p.advanced !== true);

	const groups = groupNormalConfigProperties(normal);
	if (advanced.length > 0) {
		groups.push({ id: 'kind:advanced', title: null, kind: 'advanced', props: advanced });
	}
	if (actionProps.length > 0) {
		groups.unshift({ id: 'kind:actions', title: null, kind: 'actions', props: actionProps });
	}
	return groups;
}

/** 非高级项的常规分组（declared 优先，否则按字段性质兜底）。 */
function groupNormalConfigProperties<T extends IConfigPropertyLike>(visible: readonly T[]): IConfigGroup<T>[] {
	const declared = visible.filter(p => !!p.group);
	if (declared.length > 0) {
		const order: string[] = [];
		const byTitle = new Map<string, T[]>();
		const rest: T[] = [];
		for (const prop of visible) {
			if (!prop.group) {
				rest.push(prop);
				continue;
			}
			if (!byTitle.has(prop.group)) {
				byTitle.set(prop.group, []);
				order.push(prop.group);
			}
			byTitle.get(prop.group)!.push(prop);
		}
		const groups: IConfigGroup<T>[] = order.map(title => ({
			id: `declared:${title}`,
			title,
			description: byTitle.get(title)!.find(p => !!p.groupDescription)?.groupDescription,
			kind: 'declared' as const,
			props: byTitle.get(title)!,
		}));
		if (rest.length > 0) {
			groups.push({ id: 'kind:values', title: null, kind: 'values', props: rest });
		}
		return groups;
	}

	const buckets: { kind: ConfigGroupKind; id: string; props: T[] }[] = [
		{ kind: 'switches', id: 'kind:switches', props: visible.filter(p => !p.action && isCompactConfigField(p)) },
		{ kind: 'values', id: 'kind:values', props: visible.filter(p => !p.action && !isCompactConfigField(p) && !p.readOnly) },
		{ kind: 'values', id: 'kind:readonly', props: visible.filter(p => !p.action && !isCompactConfigField(p) && !!p.readOnly) },
	];

	const nonEmpty = buckets.filter(b => b.props.length > 0);
	// 「只读派生值」与「其他设置」合并（它们视觉上同属「只展示/填写」），避免 6 项也要两个标题
	const merged: IConfigGroup<T>[] = [];
	for (const bucket of nonEmpty) {
		const prev = merged[merged.length - 1];
		if (prev && prev.kind === 'values' && bucket.kind === 'values') {
			prev.props.push(...bucket.props);
			continue;
		}
		merged.push({ id: bucket.id, title: null, kind: bucket.kind, props: [...bucket.props] });
	}
	if (merged.length === 1) {
		merged[0] = { ...merged[0], title: null };
	}
	return merged;
}

/**
 * 值是否已偏离默认值 —— 用于「已修改」标记与底部「N 项已修改」。
 *
 * 没声明默认值 → 无法判断，一律视为未修改（不误报）。
 * 数组/对象按 JSON 比较（设置项里的数组通常很小，够用且无依赖）。
 */
export function isConfigValueModified(current: unknown, defaultValue: unknown): boolean {
	if (defaultValue === undefined) { return false; }
	if (Array.isArray(defaultValue) || (defaultValue !== null && typeof defaultValue === 'object')) {
		return JSON.stringify(current ?? null) !== JSON.stringify(defaultValue);
	}
	return current !== defaultValue;
}

/**
 * 过滤框的匹配文本：键名 + 显示名 + 描述（都转小写）。
 * 让用户既能搜 `lan`（键名），也能搜「密码」（描述）。
 */
export function configSearchText(prop: IConfigPropertyLike, label: string): string {
	return [prop.key, label, prop.description ?? '', prop.markdownDescription ?? '']
		.join(' ')
		.toLowerCase();
}

/** 过滤是否命中（空查询一律命中）。 */
export function matchesConfigFilter(prop: IConfigPropertyLike, label: string, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) { return true; }
	// 多词 = AND（「桌面 开关」能同时缩小范围）
	return q.split(/\s+/).every(token => configSearchText(prop, label).includes(token));
}

/**
 * 把 `markdownDescription` 拆成「纯文本 + 链接」。
 *
 * 视图层只用 `textContent` 渲染（绝不把 schema 里的字符串当 HTML 插进去），
 * 所以 markdown 必须在这里被解析成结构化数据。描述里的链接（[文字](url)）会被摘出来，
 * 单独追加到描述文本之后。
 */
export function splitMarkdownDescription(
	markdown: string | undefined,
	fallback = '',
): { description: string; links: { label: string; url: string }[] } {
	if (!markdown) {
		return { description: fallback, links: [] };
	}
	const links: { label: string; url: string }[] = [];
	const description = markdown
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => {
			links.push({ label, url });
			return '';
		})
		.trim();
	return { description: description || fallback, links };
}
