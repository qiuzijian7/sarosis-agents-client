// @vssaros/dsh-agents — 行级 diff（2026-10-19，「记忆」页签的"对比当前"用）。
//
// 为什么自己写：只需要**行级**、两侧都是纯文本、量级 ≤ 几千行的场景；引一个 diff 库不值得
// （插件按 `file:` 装，多一个依赖就多一份装不上的风险）。算法是课本 LCS + 先削公共前后缀。
//
// 边界（都是刻意选的，别"优化"掉）：
//   · 只按 `\n` 切行，`\r\n` 归一（记忆文件是我们自己写的，但用户可能手改过）；
//   · **末尾换行不算一行**（否则"加了个空行"会显示成两条 diff，噪音）；
//   · 中间段 > `maxMiddle`（默认 1200 行）⇒ 放弃精细 diff，退化成"整块删除 + 整块新增"，
//     并标 `coarse: true` —— 大文件精确 DP 的内存是 O(n·m)，真会炸（1200² 的 Int32 已是 5.7MB）。

/** 文本 → 行数组（`\r\n` 归一；末尾换行不产生空行）。 */
export function splitLines(text) {
	const norm = String(text ?? '').replace(/\r\n/g, '\n');
	if (!norm) {
		return [];
	}
	const lines = norm.split('\n');
	if (lines.length && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

/**
 * 行级 diff。
 * @returns `{ rows: [{ type:'same'|'add'|'del', a:number|null, b:number|null, text:string }], added, removed, lines:{left,right}, coarse }`
 */
export function lineDiff(leftText, rightText, options = {}) {
	const maxMiddle = Number.isInteger(options.maxMiddle) ? options.maxMiddle : 1200;
	const a = splitLines(leftText);
	const b = splitLines(rightText);

	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) {
		start += 1;
	}
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA -= 1;
		endB -= 1;
	}
	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);

	const rows = [];
	for (let i = 0; i < start; i += 1) {
		rows.push({ type: 'same', a: i + 1, b: i + 1, text: a[i] });
	}

	let coarse = false;
	if (midA.length > maxMiddle || midB.length > maxMiddle) {
		coarse = true;
		for (let i = 0; i < midA.length; i += 1) {
			rows.push({ type: 'del', a: start + i + 1, b: null, text: midA[i] });
		}
		for (let i = 0; i < midB.length; i += 1) {
			rows.push({ type: 'add', a: null, b: start + i + 1, text: midB[i] });
		}
	} else {
		const n = midA.length;
		const m = midB.length;
		const dp = new Int32Array((n + 1) * (m + 1));
		const at = (i, j) => i * (m + 1) + j;
		for (let i = n - 1; i >= 0; i -= 1) {
			for (let j = m - 1; j >= 0; j -= 1) {
				dp[at(i, j)] = midA[i] === midB[j]
					? dp[at(i + 1, j + 1)] + 1
					: Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
			}
		}
		let i = 0;
		let j = 0;
		while (i < n && j < m) {
			if (midA[i] === midB[j]) {
				rows.push({ type: 'same', a: start + i + 1, b: start + j + 1, text: midA[i] });
				i += 1;
				j += 1;
			} else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) {
				rows.push({ type: 'del', a: start + i + 1, b: null, text: midA[i] });
				i += 1;
			} else {
				rows.push({ type: 'add', a: null, b: start + j + 1, text: midB[j] });
				j += 1;
			}
		}
		for (; i < n; i += 1) {
			rows.push({ type: 'del', a: start + i + 1, b: null, text: midA[i] });
		}
		for (; j < m; j += 1) {
			rows.push({ type: 'add', a: null, b: start + j + 1, text: midB[j] });
		}
	}

	for (let k = endA; k < a.length; k += 1) {
		rows.push({ type: 'same', a: k + 1, b: endB + (k - endA) + 1, text: a[k] });
	}

	let added = 0;
	let removed = 0;
	for (const row of rows) {
		if (row.type === 'add') { added += 1; }
		else if (row.type === 'del') { removed += 1; }
	}
	return { rows, added, removed, lines: { left: a.length, right: b.length }, coarse };
}
