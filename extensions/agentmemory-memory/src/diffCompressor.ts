/*---------------------------------------------------------------------------------------------
 *  差分压缩 — 只存储记忆版本间的差异部分。
 *
 *  与现有 compressor.ts 的区别：
 *    - compressor：单条记忆的结构化提取
 *    - diffCompressor：多条记忆间的差分存储
 *
 *  核心场景：
 *    1. 同一记忆被多次更新 → 只存 diff
 *    2. 批量记忆相似度高 → 只存差异
 *    3. 记忆快照对比 → 快速 diff
 *
 *  差分算法：
 *    - LCS（最长公共子序列）行级 diff
 *    - 相似度 > 80% 时使用 diff 存储
 *    - 相似度 < 80% 时全量存储
 *--------------------------------------------------------------------------------------------*/

export interface DiffEntry {
	type: 'add' | 'remove' | 'equal';
	oldLine?: number;
	newLine?: number;
	content: string;
}

export interface DiffResult {
	similarity: number;
	originalSize: number;
	diffSize: number;
	entries: DiffEntry[];
	compressionRatio: number;
}

export interface VersionedContent {
	id: string;
	version: number;
	content: string;
	parentVersion?: number;
	diff?: DiffEntry[];
	isFullSnapshot: boolean;
	createdAt: number;
}

function tokenizeLines(text: string): string[] {
	return text.split('\n');
}

/**
 * LCS 算法（行级）
 */
function longestCommonSubsequence(a: string[], b: string[]): number[][] {
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			if (a[i - 1] === b[j - 1]) {
				dp[i][j] = dp[i - 1][j - 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
			}
		}
	}

	return dp;
}

/**
 * 从 LCS 表生成 diff
 */
function backtrackDiff(dp: number[][], a: string[], b: string[]): DiffEntry[] {
	const result: DiffEntry[] = [];
	let i = a.length;
	let j = b.length;

	while (i > 0 && j > 0) {
		if (a[i - 1] === b[j - 1]) {
			result.unshift({
				type: 'equal',
				oldLine: i,
				newLine: j,
				content: a[i - 1],
			});
			i--;
			j--;
		} else if (dp[i - 1][j] >= dp[i][j - 1]) {
			result.unshift({
				type: 'remove',
				oldLine: i,
				content: a[i - 1],
			});
			i--;
		} else {
			result.unshift({
				type: 'add',
				newLine: j,
				content: b[j - 1],
			});
			j--;
		}
	}

	while (i > 0) {
		result.unshift({ type: 'remove', oldLine: i, content: a[i - 1] });
		i--;
	}
	while (j > 0) {
		result.unshift({ type: 'add', newLine: j, content: b[j - 1] });
		j--;
	}

	return result;
}

const SIMILARITY_THRESHOLD = 0.8;

export class DiffCompressor {
	private _versions = new Map<string, VersionedContent[]>();
	private _maxVersionsPerId = 20;

	/**
	 * 计算两个文本的差分
	 */
	diff(oldText: string, newText: string): DiffResult {
		const a = tokenizeLines(oldText);
		const b = tokenizeLines(newText);
		const originalSize = newText.length;

		const dp = longestCommonSubsequence(a, b);
		const lcsLength = dp[a.length][b.length];
		const similarity = (a.length + b.length) > 0
			? (2 * lcsLength) / (a.length + b.length)
			: 1;

		const entries = backtrackDiff(dp, a, b);

		// 计算 diff 大小（只存 add/remove 行）
		const diffSize = entries
			.filter(e => e.type !== 'equal')
			.reduce((s, e) => s + e.content.length + 10, 0);

		return {
			similarity,
			originalSize,
			diffSize,
			entries,
			compressionRatio: diffSize > 0 ? originalSize / diffSize : 1,
		};
	}

	/**
	 * 存储版本（自动选择全量或差分）
	 */
	storeVersion(id: string, content: string): VersionedContent {
		const versions = this._versions.get(id) ?? [];
		const now = Date.now();

		if (versions.length === 0) {
			// 第一个版本：全量存储
			const version: VersionedContent = {
				id,
				version: 1,
				content,
				isFullSnapshot: true,
				createdAt: now,
			};
			versions.push(version);
			this._versions.set(id, versions);
			return version;
		}

		const lastVersion = versions[versions.length - 1];
		const diffResult = this.diff(lastVersion.content, content);

		const newVersion: VersionedContent = {
			id,
			version: lastVersion.version + 1,
			content: diffResult.similarity >= SIMILARITY_THRESHOLD ? '' : content,
			parentVersion: lastVersion.version,
			diff: diffResult.similarity >= SIMILARITY_THRESHOLD ? diffResult.entries : undefined,
			isFullSnapshot: diffResult.similarity < SIMILARITY_THRESHOLD,
			createdAt: now,
		};

		versions.push(newVersion);
		if (versions.length > this._maxVersionsPerId) {
			// 保留最新的全量快照 + 后续 diff
			const lastFullIdx = versions.map(v => v.isFullSnapshot ? 1 : 0).lastIndexOf(1);
			if (lastFullIdx > 0) {
				versions.splice(0, lastFullIdx);
			} else {
				versions.shift();
			}
		}

		this._versions.set(id, versions);
		return newVersion;
	}

	/**
	 * 重建完整内容（从版本历史）
	 */
	reconstruct(id: string, version?: number): string | null {
		const versions = this._versions.get(id);
		if (!versions || versions.length === 0) return null;

		let targetIdx: number;
		if (version !== undefined) {
			targetIdx = versions.findIndex(v => v.version === version);
			if (targetIdx < 0) return null;
		} else {
			targetIdx = versions.length - 1;
		}

		// 找到最近的全量快照
		let snapshotIdx = targetIdx;
		for (let i = targetIdx; i >= 0; i--) {
			if (versions[i].isFullSnapshot) {
				snapshotIdx = i;
				break;
			}
		}

		// 从快照开始应用 diff
		let content = versions[snapshotIdx].content;
		for (let i = snapshotIdx + 1; i <= targetIdx; i++) {
			const v = versions[i];
			if (v.isFullSnapshot) {
				content = v.content;
			} else if (v.diff) {
				content = this._applyDiff(content, v.diff);
			}
		}

		return content;
	}

	/**
	 * 应用 diff 到内容
	 */
	private _applyDiff(content: string, diff: DiffEntry[]): string {
		const lines = tokenizeLines(content);
		const result: string[] = [];

		for (const entry of diff) {
			switch (entry.type) {
				case 'equal':
					result.push(entry.content);
					break;
				case 'add':
					result.push(entry.content);
					break;
				case 'remove':
					// 跳过
					break;
			}
		}

		return result.join('\n');
	}

	/**
	 * 获取版本历史
	 */
	getVersions(id: string): VersionedContent[] {
		return this._versions.get(id) ?? [];
	}

	/**
	 * 获取统计
	 */
	getStats(): { totalTracked: number; totalVersions: number; avgVersionsPerId: number; diffRatio: number } {
		let totalVersions = 0;
		let diffCount = 0;
		let fullCount = 0;
		for (const versions of this._versions.values()) {
			totalVersions += versions.length;
			for (const v of versions) {
				if (v.isFullSnapshot) fullCount++;
				else diffCount++;
			}
		}
		return {
			totalTracked: this._versions.size,
			totalVersions,
			avgVersionsPerId: this._versions.size > 0 ? totalVersions / this._versions.size : 0,
			diffRatio: totalVersions > 0 ? diffCount / totalVersions : 0,
		};
	}

	/**
	 * 清除
	 */
	clear(): void {
		this._versions.clear();
	}
}
