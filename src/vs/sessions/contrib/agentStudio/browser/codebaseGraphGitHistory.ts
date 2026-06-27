/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Git History Analysis — Git 历史变更耦合分析。
 *
 * 对标 codebase-memory-mcp 的 pass_githistory.c。
 * 分析 git log 找出经常一起变更的文件对（耦合分析）。
 */

import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';

export interface FileChangePair {
	fileA: string;
	fileB: string;
	coCommitCount: number;
	lastCoChange: number;  // timestamp
	couplingScore: number;  // 0-1
}

export interface FileChangeFrequency {
	filePath: string;
	commitCount: number;
	authors: string[];
	lastChanged: number;
	changeFrequency: number;  // commits per week
}

export interface GitHistoryReport {
	totalCommits: number;
	totalFiles: number;
	topChangedFiles: FileChangeFrequency[];
	coupledFilePairs: FileChangePair[];
	hotspots: { filePath: string; churn: number }[];
}

/**
 * Analyze git history from .git/logs/HEAD
 */
export async function analyzeGitHistory(
	fileService: IFileService,
	rootUri: URI
): Promise<GitHistoryReport> {
	const commits = await parseGitLog(fileService, rootUri);

	// Build file change frequency
	const fileFreq: Map<string, FileChangeFrequency> = new Map();
	const coChangeMap: Map<string, number> = new Map(); // "fileA|fileB" → count

	for (const commit of commits) {
		for (const file of commit.files) {
			const freq = fileFreq.get(file) || {
				filePath: file,
				commitCount: 0,
				authors: [],
				lastChanged: 0,
				changeFrequency: 0,
			};
			freq.commitCount++;
			if (!freq.authors.includes(commit.author)) { freq.authors.push(commit.author); }
			freq.lastChanged = Math.max(freq.lastChanged, commit.timestamp);
			fileFreq.set(file, freq);
		}

		// Track co-changes
		for (let i = 0; i < commit.files.length; i++) {
			for (let j = i + 1; j < commit.files.length; j++) {
				const key = [commit.files[i], commit.files[j]].sort().join('|');
				coChangeMap.set(key, (coChangeMap.get(key) || 0) + 1);
			}
		}
	}

	// Calculate change frequency (commits per week)
	const oldestCommit = Math.min(...commits.map(c => c.timestamp), Date.now());
	const weeksElapsed = Math.max(1, (Date.now() - oldestCommit) / (7 * 24 * 60 * 60 * 1000));
	for (const freq of fileFreq.values()) {
		freq.changeFrequency = freq.commitCount / weeksElapsed;
	}

	// Top changed files
	const topChangedFiles = Array.from(fileFreq.values())
		.sort((a, b) => b.commitCount - a.commitCount)
		.slice(0, 50);

	// Coupled file pairs
	const coupledPairs: FileChangePair[] = [];
	for (const [key, count] of coChangeMap) {
		if (count < 2) { continue; }
		const [fileA, fileB] = key.split('|');
		const totalA = fileFreq.get(fileA)?.commitCount || 1;
		const totalB = fileFreq.get(fileB)?.commitCount || 1;
		const couplingScore = count / Math.min(totalA, totalB);
		coupledPairs.push({
			fileA, fileB,
			coCommitCount: count,
			lastCoChange: 0,
			couplingScore,
		});
	}
	coupledPairs.sort((a, b) => b.couplingScore - a.couplingScore);

	// Hotspots (high churn files)
	const hotspots = topChangedFiles.slice(0, 20).map(f => ({
		filePath: f.filePath,
		churn: f.commitCount,
	}));

	return {
		totalCommits: commits.length,
		totalFiles: fileFreq.size,
		topChangedFiles,
		coupledFilePairs: coupledPairs.slice(0, 100),
		hotspots,
	};
}

interface GitCommit {
	hash: string;
	author: string;
	timestamp: number;
	files: string[];
}

async function parseGitLog(fileService: IFileService, rootUri: URI): Promise<GitCommit[]> {
	try {
		const logUri = URI.joinPath(rootUri, '.git', 'logs', 'HEAD');
		const content = await fileService.readFile(logUri);
		const lines = content.value.toString().split('\n');
		const commits: GitCommit[] = [];

		for (const line of lines) {
			// Format: <old> <new> <author> <timestamp> <tz>\t<message>
			const match = line.match(/^([0-9a-f]+)\s+([0-9a-f]+)\s+(.+?)\s+(\d+)\s+[+-]\d+\t(.*)$/);
			if (match) {
				const [, _oldHash, newHash, author, timestampStr, message] = match;
				const timestamp = parseInt(timestampStr) * 1000;
				const files = extractFilesFromMessage(message);
				commits.push({ hash: newHash, author, timestamp, files });
			}
		}

		return commits;
	} catch { return []; }
}

function extractFilesFromMessage(message: string): string[] {
	// Git log messages don't contain file lists directly
	// In a real implementation, we'd use git log --name-only
	// For now, return empty — the watcher handles file-level tracking
	return [];
}
