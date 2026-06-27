/*---------------------------------------------------------------------------------------------
 *  Git 提交捕获 — 捕获 Git 提交信息并存入记忆。
 *  参考 agentmemory src/hooks/post-commit.ts
 *
 *  核心场景：
 *    当用户执行 git commit 时，自动捕获：
 *    1. 提交消息（commit message）
 *    2. 变更统计（增/删行数）
 *    3. 变更文件列表
 *    4. 关联到当前会话
 *
 *  与外部 hook 的区别：
 *    - agentmemory post-commit.ts：通过 git hooks 捕获（需要 shell 脚本）
 *    - 本模块：在进程内由调用方传入 commit 信息
 *--------------------------------------------------------------------------------------------*/

export interface CommitInfo {
	sha: string;
	message: string;
	author: string;
	authorEmail: string;
	timestamp: number;
	filesChanged: string[];
	insertions: number;
	deletions: number;
	branch?: string;
	repoPath?: string;
}

export interface CommitMemoryEntry {
	id: string;
	type: 'episodic';
	content: string;
	timestamp: number;
	importance: number;
	metadata: {
		event: 'git_commit';
		sha: string;
		author: string;
		filesChanged: string[];
		insertions: number;
		deletions: number;
		branch?: string;
		concepts: string[];
	};
}

export interface CommitStats {
	totalCommits: number;
	totalInsertions: number;
	totalDeletions: number;
	avgFilesPerCommit: number;
	topAuthors: Array<{ author: string; count: number }>;
	topFiles: Array<{ file: string; count: number }>;
}

function generateId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function extractConcepts(message: string, files: string[]): string[] {
	const concepts = new Set<string>();

	// 从提交消息提取
	const msgWords = message.match(/\b(\w{4,})\b/g);
	if (msgWords) {
		const stopWords = new Set(['this', 'that', 'with', 'from', 'have', 'will', 'been', 'were', 'they', 'your', 'what', 'when', 'some', 'more', 'feat', 'fix', 'chore', 'docs', 'refactor']);
		for (const word of msgWords) {
			const lower = word.toLowerCase();
			if (!stopWords.has(lower) && lower.length <= 20) {
				concepts.add(lower);
			}
		}
	}

	// 从文件路径提取
	for (const file of files) {
		const parts = file.split(/[/\\]/);
		// 取目录名作为概念
		if (parts.length > 1) {
			concepts.add(parts[0].toLowerCase());
		}
		// 取文件扩展名
		const ext = parts[parts.length - 1].split('.').pop();
		if (ext) {
			concepts.add(`.${ext}`);
		}
	}

	return Array.from(concepts).slice(0, 10);
}

function buildCommitContent(commit: CommitInfo): string {
	const lines: string[] = [];
	lines.push(`[Git Commit] ${commit.sha.slice(0, 8)}`);
	lines.push(`Author: ${commit.author}`);
	lines.push(`Message: ${commit.message.slice(0, 500)}`);
	lines.push(`Files: ${commit.filesChanged.length} changed (+${commit.insertions} / -${commit.deletions})`);
	if (commit.branch) {
		lines.push(`Branch: ${commit.branch}`);
	}
	if (commit.filesChanged.length > 0 && commit.filesChanged.length <= 10) {
		lines.push(`Changed files:`);
		for (const file of commit.filesChanged) {
			lines.push(`  - ${file}`);
		}
	}
	return lines.join('\n');
}

export class PostCommitCapture {
	private _commits: CommitMemoryEntry[] = [];
	private _maxCommits = 500;
	private _byAuthor = new Map<string, number>();
	private _byFile = new Map<string, number>();
	private _totalInsertions = 0;
	private _totalDeletions = 0;

	/**
	 * 捕获 Git 提交
	 */
	capture(commit: CommitInfo): CommitMemoryEntry {
		const concepts = extractConcepts(commit.message, commit.filesChanged);
		const content = buildCommitContent(commit);
		const importance = this._computeImportance(commit);

		const entry: CommitMemoryEntry = {
			id: generateId('commit'),
			type: 'episodic',
			content,
			timestamp: commit.timestamp,
			importance,
			metadata: {
				event: 'git_commit',
				sha: commit.sha,
				author: commit.author,
				filesChanged: commit.filesChanged.slice(0, 50),
				insertions: commit.insertions,
				deletions: commit.deletions,
				branch: commit.branch,
				concepts,
			},
		};

		this._commits.push(entry);
		if (this._commits.length > this._maxCommits) {
			this._commits.shift();
		}

		// 更新统计
		this._byAuthor.set(commit.author, (this._byAuthor.get(commit.author) ?? 0) + 1);
		for (const file of commit.filesChanged) {
			this._byFile.set(file, (this._byFile.get(file) ?? 0) + 1);
		}
		this._totalInsertions += commit.insertions;
		this._totalDeletions += commit.deletions;

		return entry;
	}

	/**
	 * 计算提交重要性
	 */
	private _computeImportance(commit: CommitInfo): number {
		let importance = 5;

		// 大变更 → 更重要
		if (commit.insertions + commit.deletions > 100) importance += 2;
		if (commit.insertions + commit.deletions > 500) importance += 1;

		// 提交消息包含关键词 → 调整
		const msg = commit.message.toLowerCase();
		if (/\b(break|major|critical|security|hotfix)\b/.test(msg)) importance += 3;
		if (/\b(fix|bug)\b/.test(msg)) importance += 1;
		if (/\b(feature|feat|add)\b/.test(msg)) importance += 1;
		if (/\b(docs?|comment|readme)\b/.test(msg)) importance -= 2;
		if (/\b(chore|cleanup|format|lint)\b/.test(msg)) importance -= 1;

		// 影响文件多 → 更重要
		if (commit.filesChanged.length > 5) importance += 1;
		if (commit.filesChanged.length > 15) importance += 1;

		return Math.max(1, Math.min(10, importance));
	}

	/**
	 * 获取最近提交
	 */
	getRecent(limit: number = 20): CommitMemoryEntry[] {
		return this._commits.slice(-limit).reverse();
	}

	/**
	 * 搜索提交
	 */
	search(query: string, limit: number = 10): CommitMemoryEntry[] {
		const lower = query.toLowerCase();
		return this._commits
			.filter(c =>
				c.content.toLowerCase().includes(lower) ||
				c.metadata.sha.toLowerCase().includes(lower) ||
				c.metadata.concepts.some(concept => concept.includes(lower)),
			)
			.slice(-limit)
			.reverse();
	}

	/**
	 * 按作者获取提交
	 */
	getByAuthor(author: string, limit: number = 20): CommitMemoryEntry[] {
		return this._commits
			.filter(c => c.metadata.author === author)
			.slice(-limit)
			.reverse();
	}

	/**
	 * 按文件获取提交
	 */
	getByFile(filePath: string, limit: number = 10): CommitMemoryEntry[] {
		return this._commits
			.filter(c => c.metadata.filesChanged.includes(filePath))
			.slice(-limit)
			.reverse();
	}

	/**
	 * 获取统计
	 */
	getStats(): CommitStats {
		const commits = this._commits;
		const totalFiles = commits.reduce((s, c) => s + c.metadata.filesChanged.length, 0);

		const topAuthors = Array.from(this._byAuthor.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([author, count]) => ({ author, count }));

		const topFiles = Array.from(this._byFile.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([file, count]) => ({ file, count }));

		return {
			totalCommits: commits.length,
			totalInsertions: this._totalInsertions,
			totalDeletions: this._totalDeletions,
			avgFilesPerCommit: commits.length > 0 ? Math.round(totalFiles / commits.length * 10) / 10 : 0,
			topAuthors,
			topFiles,
		};
	}

	/**
	 * 清除所有
	 */
	clear(): void {
		this._commits = [];
		this._byAuthor.clear();
		this._byFile.clear();
		this._totalInsertions = 0;
		this._totalDeletions = 0;
	}
}
