/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 插件启停（方案 4.3「停用」）的纯逻辑。
 *
 * **真源是 dsh 原生的 profile 组合**：`<profile>/package.json` 的 `dsh.profile.bundles` 列表。
 * 依据（dsh 自带技能 `editing-cordis-compositions` / `cordis-composition-reference`，0.2.0-rc.2）：
 * profile 由「有序的 patch 层」组合而成，**列在 `dsh.profile.bundles` 里的包才会被组合**；
 * 方案 4.3 也写明「激活：加入 `dsh.profile.bundles`；停用：从 `bundles` 移出，**依赖与数据保留**」。
 *
 * 所以：
 * - 停用 = 从 `bundles` 移出（`dependencies` 不动 ⇒ 不用重装、数据不动）；
 * - 启用 = 加回 `bundles`；
 * - 变更要**重启 Host**（或 profile 启用 `dsh-hmr` 时热重载）才生效——这是 dsh 原生的口径，
 *   界面里如实提示；
 * - 基础组合与 VsSaros 控制桥不可停用（见 {@link DSH_UNDISABLABLE_BUNDLES}）：移出它们 Host
 *   要么起不来、要么 VsSaros 失去与 Host 的唯一通道。
 *
 * 本文件是纯逻辑（不改入参、无 I/O）；文件读写见 `electron-main/dshPluginActivationStore.ts`。
 */

/** 不可停用的 bundle：基础组合 / Web 应用 / VsSaros 控制桥（缺任一，Host 不可用或其控制权丢失）。 */
export const DSH_UNDISABLABLE_BUNDLES: readonly string[] = [
	'@deepseek-ai/dsh-base',
	'@deepseek-ai/dsh-web-app',
	'@vssaros/dsh-bridge',
];

export function isBundleDisableForbidden(pluginName: string): boolean {
	return DSH_UNDISABLABLE_BUNDLES.includes(pluginName.trim());
}

function readObject(value: unknown): Record<string, unknown> | undefined {
	return !!value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** 读 profile 组合里的 bundle 列表（`dsh.profile.bundles`）；缺省 / 非法一律当作空列表。 */
export function parseProfileBundles(profilePackageJson: unknown): string[] {
	const dsh = readObject(readObject(profilePackageJson)?.['dsh']);
	const profile = readObject(dsh?.['profile']);
	const bundles = profile?.['bundles'];
	if (!Array.isArray(bundles)) {
		return [];
	}
	return bundles.filter((b): b is string => typeof b === 'string' && !!b.trim()).map(b => b.trim());
}

/** 该包当前是否参与 profile 组合（= 是否启用）。 */
export function isBundleEnabled(profilePackageJson: unknown, pluginName: string): boolean {
	return parseProfileBundles(profilePackageJson).includes(pluginName.trim());
}

/**
 * **写入归属**（README 5.64）：把清单的 `owns` 声明与**当前启用状态**合起来，回答"这条数据路径现在谁在写"。
 *
 * 为什么放这里：本模块本来回答的就是"谁参与了 profile 组合" ✓ —— 写入归属是**同一个问题的另一半** ✓
 *（`owns` 的注释原文："独占写入的数据路径（单写者声明，方案 6.8）"、"插件启用时触发所有权切换" ✓）。
 *
 * ⚠ **本函数只做判定，不做执行**（别误读 ✗）：`owns` 至今**没有任何执行点**（README 5.60 的摸底 ✓）⇒
 * 这里给的是"**应当**谁在写" ✓;"IDE 侧到底停写了没有"要等各写服务的开关分支落地 ✓（README 5.64 的"仍未做"✓）。
 */
export interface IWriteOwnershipEntry {
	/** 被声明的数据路径（清单 `owns` 的原文，原样带回 ✓）。 */
	readonly path: string;
	/** 声明者（插件包名）。 */
	readonly owner: string;
	/** 对应的旧模块 id（清单 `legacyCounterpart`；没有则不带这个字段 ✓）。 */
	readonly legacyCounterpart?: string;
	/** `dsh` = 声明者已启用（由它写）；`ide` = 未启用（旧模块仍写 ✓）。 */
	readonly writer: 'dsh' | 'ide';
	/** 人读依据（界面 / 日志 / 报错直接显示 ✓）。 */
	readonly reason: string;
}

/**
 * 派生写入归属表（按插件名、再按路径**排序** ⇒ 同输入同输出，可断言 ✓）。
 *
 * `isEnabled` 用注入的判据（生产里就是本模块的 {@link isBundleEnabled} + profile 组合 ✓）⇒ 纯函数、
 * 无 I/O ✓，测试可直接喂 `() => true/false` 覆盖两条分支 ✓。
 */
export function resolveWriteOwnership(
	plugins: readonly { readonly name: string; readonly owns?: readonly string[]; readonly legacyCounterpart?: string }[],
	isEnabled: (pluginName: string) => boolean,
): readonly IWriteOwnershipEntry[] {
	const out: IWriteOwnershipEntry[] = [];
	for (const plugin of [...plugins].sort((a, b) => a.name.localeCompare(b.name))) {
		const owns = plugin.owns ?? [];
		if (!owns.length) { continue; }
		const enabled = isEnabled(plugin.name);
		for (const path of [...owns].sort()) {
			out.push({
				path,
				owner: plugin.name,
				...(plugin.legacyCounterpart ? { legacyCounterpart: plugin.legacyCounterpart } : {}),
				writer: enabled ? 'dsh' : 'ide',
				reason: enabled
					? `${plugin.name} 已启用 ⇒ 由 dsh 写${plugin.legacyCounterpart ? `，${plugin.legacyCounterpart} 应停写` : ''}`
					: `${plugin.name} 未启用 ⇒ 仍由旧模块写${plugin.legacyCounterpart ? `（${plugin.legacyCounterpart}）` : ''}`,
			});
		}
	}
	return out;
}

/**
 * 同一路径被**两个**声明者声明 ⇒ 归属无法成立（返回冲突描述，交调用方如实报错 ✓，绝不"取第一个" ✗）。
 * 返回空数组 = 无冲突 ✓。
 */
export function findWriteOwnershipConflicts(entries: readonly IWriteOwnershipEntry[]): readonly string[] {
	const seen = new Map<string, string>();
	const conflicts: string[] = [];
	for (const entry of entries) {
		const previous = seen.get(entry.path);
		if (previous && previous !== entry.owner) {
			conflicts.push(`${entry.path}：${previous} 与 ${entry.owner} 同时声明`);
		}
		seen.set(entry.path, entry.owner);
	}
	return conflicts;
}

/**
 * 启停某个包：在 `dsh.profile.bundles` 里增删。
 *
 * 返回新的 package.json 对象（**不改入参**）与是否发生了变化；其它字段、`dependencies`
 * 与既有顺序都保留（启用时追加到末尾；禁用时保留其余项的相对顺序）。
 * `pluginName` 为空或属于 {@link DSH_UNDISABLABLE_BUNDLES} 时不改动（调用方据此报错）。
 */
export function setBundleEnabled(profilePackageJson: unknown, pluginName: string, enabled: boolean):
	{ readonly packageJson: Record<string, unknown>; readonly changed: boolean } {
	const pkg = readObject(profilePackageJson) ?? {};
	const name = pluginName.trim();
	if (!name || isBundleDisableForbidden(name)) {
		return { packageJson: pkg, changed: false };
	}
	const bundles = parseProfileBundles(pkg);
	const has = bundles.includes(name);
	if (enabled === has) {
		return { packageJson: pkg, changed: false };
	}
	const next = enabled ? [...bundles, name] : bundles.filter(b => b !== name);
	const dsh = { ...(readObject(pkg['dsh']) ?? {}) };
	const profile = { ...(readObject(dsh['profile']) ?? {}) };
	profile['bundles'] = next;
	dsh['profile'] = profile;
	return { packageJson: { ...pkg, dsh }, changed: true };
}

// ─── HMR（改完组合是"热重载"还是"需重启"的判断依据）─────────────────────────────

/** HMR 的 loader 行 id（由 base bundle 提供；见 `@deepseek-ai/dsh-hmr` README）。 */
export const DSH_HMR_ENTRY_ID = 'hmr';

/**
 * - `active`：HMR 生效——改 profile 组合会被串行热重载（约 2 秒：chokidar 写稳定窗口 + debounce）；
 * - `disabled`：profile patch 显式停用了 `hmr` 行（或未提供 profileContext）→ 改动要重启 Host 才生效；
 * - `unknown`：patch 里没有相关条目，无法从文件判断（界面按"若未生效请重启"提示）。
 */
export type DshHmrState = 'active' | 'disabled' | 'unknown';

/**
 * 从 profile 的 `cordis.patch.yml` **文本**判断 HMR 行是否被显式覆盖。
 *
 * 只做行级扫描、不解析 YAML（我们不引 YAML 依赖）：定位 `- id: <hmr>` 条目，然后在它之后
 * 直到下一个同级条目之前找 `disabled:`；`true` → 停用，`false`/缺省 → 启用，`!!js` 表达式 → unknown。
 * 没有任何 `hmr` 条目时返回 `unknown`（条目来自 base bundle，patch 里看不到）。
 */
export function parseHmrPatchState(patchText: unknown): DshHmrState {
	if (typeof patchText !== 'string' || !patchText.trim()) {
		return 'unknown';
	}
	const lines = patchText.split(/\r?\n/);
	const idRe = new RegExp(`^\\s*-\\s*id:\\s*['"]?${DSH_HMR_ENTRY_ID}['"]?\\s*(#.*)?$`);
	for (let i = 0; i < lines.length; i++) {
		if (!idRe.test(lines[i])) {
			continue;
		}
		for (let j = i + 1; j < lines.length; j++) {
			const line = lines[j];
			// 下一个条目开始 ⇒ 本条目结束
			if (/^\s*-\s/.test(line)) {
				break;
			}
			const m = /^\s*disabled:\s*(.*?)\s*$/.exec(line);
			if (!m) {
				continue;
			}
			const value = m[1];
			if (/^(true|yes)$/i.test(value)) {
				return 'disabled';
			}
			if (/^(false|no|null|~)$/i.test(value) || value === '') {
				return 'active';
			}
			// !!js 表达式等：运行期才知道
			return 'unknown';
		}
		return 'active';
	}
	return 'unknown';
}

/** 把字符串里"在正则里有意义"的字符转义（条目 id 可能带 `.` / `+` 等）。 */
function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 取一行的缩进（用于把新写的 `disabled:` 对齐到同一条目既有属性的缩进）。 */
function indentOf(line: string): string {
	return /^(\s*)/.exec(line)?.[1] ?? '  ';
}

/**
 * 在 profile 的 `cordis.patch.yml` **文本**里写/删某个条目的 `disabled` 覆盖（**行级启停的文件级通路**）。
 *
 * 为什么要有它：Host 的实时重组在 VsSaros 的启动路径上必然失败（README 4.51——dsh 的
 * `reconcileProfilePatches()` 要求 root Include entry），那时用户点"禁用某一行"就会**白点**。
 * 这条路与 {@link setBundleEnabled}（改 `dsh.profile.bundles`）同源：**写盘**，由 HMR 或下次启动生效。
 *
 * 落盘形态与 dsh 自己写的一致（`dsh-plugin-manager`：`setIn(["disabled"], !enabled)`）：
 * `enabled:false` ⇒ 写 `disabled: true`；`enabled:true` ⇒ **删掉**该键（回到"由 base bundle 提供"）。
 * 只认**顶层**条目（`- id:` 顶格）——与 dsh 的 `findLastIndex(… !item.has("insert"))` 同口径：
 * `insert:` 里面那一行是**补丁内容**、不是可覆盖的条目；同 id 多条时取**最后**一条、给了 {@link moduleName}
 * 时还要求条目自带的 `name` 与它一致（都是 dsh `expectedName` 判定的一部分）。
 * 另一处有意的偏离：**启用时我们删掉这个键**（条目只剩 id/name 时整条删掉），而 dsh 是写成
 * `disabled: false`——两者对 dsh 的读取完全等价（缺省即启用），但我们的写法不会在 patch 里攒下空条目。
 *
 * 与 {@link parseHmrPatchState} 同一套做法：**行级编辑、不引 YAML 依赖**，保留既有注释与缩进风格。
 * 返回 `changed:false` 表示"本来就是这个状态"（幂等；调用方据此不必写盘、也不必报变更）。
 */
export function setRowDisabledOverride(patchText: unknown, rowId: string, enabled: boolean, moduleName?: string): { readonly text: string; readonly changed: boolean } {
	const source = typeof patchText === 'string' ? patchText : '';
	const id = rowId.trim();
	if (!id) {
		return { text: source, changed: false };
	}
	const eol = source.includes('\r\n') ? '\r\n' : '\n';
	const lines = source.trim() === '' ? [] : source.split(/\r?\n/);

	/** 顶层条目的行区间终点（到下一个顶格 `- ` 为止）。 */
	const rowEnd = (start: number): number => {
		for (let j = start + 1; j < lines.length; j++) {
			if (/^-\s/.test(lines[j])) {
				return j;
			}
		}
		return lines.length;
	};
	/** 条目自己写的 `name:`（没有就是 `undefined`）。 */
	const rowName = (start: number): string | undefined => {
		for (let j = start + 1; j < rowEnd(start); j++) {
			const m = /^\s*name:\s*(.*?)\s*$/.exec(lines[j]);
			if (m) {
				return m[1].replace(/^['"]|['"]$/g, '');
			}
		}
		return undefined;
	};

	// 与 dsh 的条目匹配**同口径**：取**最后**一条满足条件的顶层条目（补丁是"后者覆盖前者"），
	// 且给了 `moduleName` 时，条目自带的 `name` 必须与它一致（dsh 的 `expectedName` 判定：
	// 同名不同 name 的行是"换过模块的残留"，不该被当成目标）。
	const idPattern = new RegExp(`^-\\s*id:\\s*['"]?${escapeRegExp(id)}['"]?\\s*(?:#.*)?$`);
	let target = -1;
	for (let i = 0; i < lines.length; i++) {
		if (!idPattern.test(lines[i])) {
			continue;
		}
		const name = rowName(i);
		if (moduleName === undefined || name === undefined || name === moduleName) {
			target = i;
		}
	}

	// 没有该条目：只有"停用"需要落一条覆盖（启用 = 没有覆盖 = 本来就启用）
	if (target < 0) {
		if (enabled) {
			return { text: source, changed: false };
		}
		const next = [...lines];
		// 先吃掉尾随空行（`'- id: other\n'` 会 split 出末尾空串），再补**恰好一个**空行作分隔
		while (next.length > 0 && next[next.length - 1].trim() === '') {
			next.pop();
		}
		if (next.length > 0) {
			next.push('');
		}
		next.push(`- id: ${id}`, '  disabled: true');
		return { text: `${next.join(eol)}${eol}`, changed: true };
	}

	// 条目的行区间 [target, end)
	const end = rowEnd(target);
	let disabledAt = -1;
	for (let j = target + 1; j < end; j++) {
		if (/^\s*disabled:\s*/.test(lines[j])) {
			disabledAt = j;
			break;
		}
	}

	if (!enabled) {
		if (disabledAt >= 0) {
			if (/^\s*disabled:\s*(?:true|yes)\s*(?:#.*)?$/i.test(lines[disabledAt])) {
				return { text: source, changed: false };   // 已经是停用态 ⇒ 幂等
			}
			const next = [...lines];
			next[disabledAt] = `${indentOf(lines[disabledAt])}disabled: true`;
			return { text: next.join(eol), changed: true };
		}
		// 追加到**条目末尾**（dsh 的 `document.setIn` 就是把键加到 map 末尾）——而不是紧跟 id，
		// 这样"同一个文件里我们写的行"和"dsh 自己写的行"长得一样（便于人工比对与 diff）
		let insertAt = end;
		while (insertAt > target + 1 && lines[insertAt - 1].trim() === '') {
			insertAt--;
		}
		const next = [...lines];
		next.splice(insertAt, 0, '  disabled: true');
		return { text: next.join(eol), changed: true };
	}

	// 启用：删掉 `disabled`；若该条目剩余内容只有 id / name（没有 config 等实质项）⇒ **连条目一起删**
	// （与 dsh 自己的清理同口径：它会把"删掉 config 后只剩 id/name"的条目整行删除）
	if (disabledAt < 0) {
		return { text: source, changed: false };
	}
	const remaining = lines.slice(target + 1, end).filter((_, offset) => target + 1 + offset !== disabledAt);
	const meaningful = remaining
		.map(line => line.trim())
		.filter(trimmed => trimmed !== '' && !trimmed.startsWith('#'));
	const onlyIdentity = meaningful.every(trimmed => /^(?:id|name):\s*/.test(trimmed));
	const next = [...lines];
	if (onlyIdentity) {
		next.splice(target, end - target);
	} else {
		next.splice(disabledAt, 1);
	}
	return { text: next.join(eol), changed: true };
}

/** profile package.json 的落盘格式：2 空格缩进 + 末尾换行（与 dsh 自己写的形态一致）。 */
export function serializeProfilePackageJson(profilePackageJson: unknown): string {
	return `${JSON.stringify(readObject(profilePackageJson) ?? {}, null, 2)}\n`;
}
