// @vssaros/dsh-agents — Git 分道图（纯函数，2026-10-31）。
//
// 参照 DeepSeekBot 的 `packages/client/src/client/memory-git-lanes.ts`（同一个算法），
// 但我们把它放在**后端**：布局与轨道路径只有这一份实现，页面只负责把 `paths` 拼成 `<path d>`。
// 若放在前端，就得在 SSR 页的 clientJs 里再抄一遍 ⇒ 两份 layout 必然分叉（本项目已踩过多次）。
//
// 用法：
//   ① `layoutGitLanes(commits)` —— 按 **topo-order 的输出顺序**给每个提交分配轨道；
//      `commits[i] = { full, parents: [full...] }`（`full` = 40 位 sha，`parents` 同口径）。
//      返回同长度数组，每项 `{ lane, fromAbove, through, joins, toParents, width }`。
//   ② `laneRowPaths(row)` —— 把上一步的一项转成可直接画的 SVG：`{ width, paths: string[], dot }`。
//
// ⚠ 两个刻意的选择：
//   · **不在显示列表里的父提交不占轨道**（`known` 判定）—— 否则 `log --max-count=N` 截断处的
//     父提交会开一条永不收敛的悬空轨，图右侧凭空多出一列（DSB 那边是 60 条一页，同样会遇到，
//     它选择照画）。
//   · 几何常量集中在这里（`LANE_W/ROW_H/NODE_Y`）—— 页面的 CSS 行高必须与 `ROW_H` 一致，
//     否则轨道接不上；把常量导出，页面用它写行高。

/** 一条轨道的宽度（px）。 */
export const LANE_W = 12;
/** 一行的高度（px）；页面行高必须同值，否则上下两行的轨道接不上。 */
export const ROW_H = 46;
/** 节点圆心距行顶的距离（px）。 */
export const NODE_Y = 12;

/**
 * 给 topo-order 的提交序列分配轨道。
 *
 * @param commits `Array<{ full?: string, hash?: string, parents?: string[] }>`
 * @returns `Array<{ lane, fromAbove, through, joins, toParents, width }>`
 */
export function layoutGitLanes(commits) {
	const list = Array.isArray(commits) ? commits : [];
	const known = new Set(list.map(c => String(c?.full ?? c?.hash ?? '')));
	const active = [];
	const rows = [];
	const slot = () => {
		const free = active.indexOf(null);
		return free >= 0 ? free : active.length;
	};
	for (const commit of list) {
		const sha = String(commit?.full ?? commit?.hash ?? '');
		let lane = active.indexOf(sha);
		const fromAbove = lane >= 0;
		if (lane < 0) { lane = slot(); }
		// `joins`：其它轨道上同一个 sha（merge 的第二父汇入）⇒ 画一条汇入曲线
		const joins = active.flatMap((cur, index) => (cur === sha && index !== lane ? [index] : []));
		// `through`：本行"路过"的活跃轨道 ⇒ 一条竖线穿过
		const through = active.flatMap((cur, index) => (cur !== null && cur !== sha ? [index] : []));
		for (const index of joins) { active[index] = null; }
		active[lane] = null;
		const toParents = [];
		const parents = Array.isArray(commit?.parents) ? commit.parents : [];
		for (const [index, parent] of parents.entries()) {
			const full = String(parent ?? '');
			if (!known.has(full)) { continue; } // 超出显示范围 ⇒ 不留悬空轨
			let parentLane = index === 0 ? lane : active.indexOf(full);
			if (parentLane < 0) { parentLane = slot(); }
			active[parentLane] = full;
			toParents.push(parentLane);
		}
		rows.push({
			lane,
			fromAbove,
			through,
			joins,
			toParents,
			width: Math.max(lane, ...through, ...joins, ...toParents, 0) + 1,
		});
	}
	return rows;
}

/** 一段轨道的 SVG path（照 DSB 的 `memoryGraphRailPath`：圆弧半径取 5 与半距的较小者）。 */
function rail(from, to, nodeY, rowH, direction) {
	const radius = Math.min(5, Math.abs(to - from) / 2);
	if (direction === 'outgoing') {
		if (from === to) { return `M ${from} ${nodeY} V ${rowH + 0.5}`; }
		const sign = to > from ? 1 : -1;
		const sweep = to > from ? 1 : 0;
		return `M ${from} ${nodeY} H ${to - sign * radius} A ${radius} ${radius} 0 0 ${sweep} ${to} ${nodeY + radius} V ${rowH + 0.5}`;
	}
	if (from === to) { return `M ${from} -0.5 V ${nodeY}`; }
	const sign = to > from ? 1 : -1;
	const sweep = to > from ? 0 : 1;
	return `M ${from} -0.5 V ${nodeY - radius} A ${radius} ${radius} 0 0 ${sweep} ${from + sign * radius} ${nodeY} H ${to}`;
}

/**
 * 把一行轨道数据转成 SVG 片段。
 *
 * @returns `{ width, x, y, paths, dot }` —— `paths` 是若干 `d` 字符串，页面直接 `<path d="...">`；
 *          `dot` 是提交圆点的圆心；`width` 是该行需要的轨道数（页面据此定 svg 宽度）。
 */
export function laneRowPaths(row, options = {}) {
	const laneW = Number.isFinite(options.laneW) ? options.laneW : LANE_W;
	const rowH = Number.isFinite(options.rowH) ? options.rowH : ROW_H;
	const nodeY = Number.isFinite(options.nodeY) ? options.nodeY : NODE_Y;
	const width = Math.max(1, Number(row?.width ?? 1));
	const lane = Number(row?.lane ?? 0);
	const X = (value) => value * laneW + laneW / 2;
	const paths = [];
	// 1) 路过的轨道：整行竖线
	for (const index of row?.through ?? []) {
		paths.push(`M ${X(index)} -0.5 V ${rowH + 0.5}`);
	}
	// 2) 汇入本节点：本轨道自身的延续（fromAbove）+ 其它轨道并进来（joins）
	const ins = row?.fromAbove ? [lane, ...(row.joins ?? [])] : [...(row.joins ?? [])];
	for (const index of ins) {
		paths.push(rail(X(index), X(lane), nodeY, rowH, 'incoming'));
	}
	// 3) 出边：本节点连向父提交（下一行）
	for (const parent of row?.toParents ?? []) {
		paths.push(rail(X(lane), X(parent), nodeY, rowH, 'outgoing'));
	}
	return { width, x: X(lane), y: nodeY, paths, dot: { x: X(lane), y: nodeY } };
}
