#!/usr/bin/env node
/**
 * sync-codebase-memory.mjs
 * 将 codebase-memory-mcp 生成的 graph 同步到远程 Git 仓库。
 *
 * 用法：
 *   node scripts/sync-codebase-memory.mjs [workspacePath]
 *
 * 如果不传 workspacePath，默认使用当前目录。
 *
 * 远程仓库：https://git.woa.com/zijianqiu/vssaros-codebase-memory.git
 * 分支策略：每个项目一个分支，分支名为项目目录名。
 *
 * Graph 路径（通过 Junction 重定向后）：
 *   {workspace}/.sarosworkspace/.codebase-memory/graph.db.zst
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join, basename, resolve } from 'path';
import { homedir } from 'os';

const REMOTE_URL = 'https://git.woa.com/zijianqiu/vssaros-codebase-memory.git';

// ─── Parse args ──────────────────────────────────────────────────────
const workspacePath = process.argv[2]
	? resolve(process.argv[2])
	: process.cwd();
const projectName = basename(workspacePath);
const graphDir = join(workspacePath, '.sarosworkspace', '.codebase-memory');

console.log(`[sync] Workspace : ${workspacePath}`);
console.log(`[sync] Project  : ${projectName}`);
console.log(`[sync] Graph dir: ${graphDir}`);
console.log(`[sync] Remote   : ${REMOTE_URL}`);
console.log(`[sync] Branch   : ${projectName}`);
console.log('');

// ─── Validate ────────────────────────────────────────────────────────
if (!existsSync(graphDir)) {
	console.error(`[sync] ✗ Graph directory does not exist: ${graphDir}`);
	console.error(`[sync]   Run index_repository first to generate the graph.`);
	process.exit(1);
}

const graphFile = join(graphDir, 'graph.db.zst');
if (!existsSync(graphFile)) {
	console.warn(`[sync] ⚠ graph.db.zst not found in ${graphDir}`);
	console.warn(`[sync]   Continuing anyway (may sync other files)...`);
}

// ─── Git helper ──────────────────────────────────────────────────────
function git(args, cwd = graphDir) {
	const cmd = `git ${args}`;
	try {
		const result = execSync(cmd, { cwd, encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
		return result;
	} catch (err) {
		throw new Error(`git ${args} failed: ${err.stderr?.trim() || err.message}`);
	}
}

function gitTry(args, cwd = graphDir) {
	try {
		return git(args, cwd);
	} catch {
		return null;
	}
}

// ─── Main ────────────────────────────────────────────────────────────
try {
	// 1. Init Git repo (if not already)
	if (!existsSync(join(graphDir, '.git'))) {
		console.log('[sync] Initializing Git repository...');
		git('init');
		console.log('[sync] ✓ Git repository initialized');
	}

	// 2. Configure remote
	const remotes = gitTry('remote') || '';
	if (!remotes.includes('origin')) {
		git(`remote add origin ${REMOTE_URL}`);
		console.log('[sync] ✓ Remote added');
	} else {
		git(`remote set-url origin ${REMOTE_URL}`);
		console.log('[sync] ✓ Remote URL updated');
	}

	// 3. Create / switch to project branch
	const branchName = projectName;
	const currentBranch = gitTry('branch --show-current');
	if (currentBranch !== branchName) {
		// Check if branch exists locally
		const branches = gitTry('branch --list') || '';
		if (branches.includes(branchName)) {
			git(`checkout ${branchName}`);
			console.log(`[sync] ✓ Switched to existing branch: ${branchName}`);
		} else {
			// Check if branch exists on remote
			const remoteBranch = gitTry(`ls-remote --heads origin ${branchName}`);
			if (remoteBranch) {
				git(`checkout -b ${branchName} origin/${branchName}`);
				console.log(`[sync] ✓ Checked out remote branch: ${branchName}`);
			} else {
				git(`checkout -b ${branchName}`);
				console.log(`[sync] ✓ Created new branch: ${branchName}`);
			}
		}
	}

	// 4. Stage files
	git('add -A');
	console.log('[sync] ✓ Files staged');

	// 5. Check if there are changes to commit
	const status = git('status --porcelain');
	if (!status) {
		console.log('[sync] No changes to commit, trying pull...');
		gitTry(`pull origin ${branchName} --no-edit`);
		console.log('[sync] ✓ Pull complete');
	} else {
		// 6. Commit
		const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
		const commitMsg = `Update graph: ${timestamp}`;
		git(`commit -m "${commitMsg}"`);
		console.log(`[sync] ✓ Committed: ${commitMsg}`);
	}

	// 7. Push
	try {
		git(`push -u origin ${branchName}`);
		console.log(`[sync] ✓ Pushed to origin/${branchName}`);
	} catch (pushErr) {
		// Push might fail if remote has newer commits — try pull --rebase then push
		console.log('[sync] Push failed, trying pull --rebase...');
		gitTry(`pull origin ${branchName} --rebase --no-edit`);
		git(`push -u origin ${branchName}`);
		console.log(`[sync] ✓ Pushed after rebase`);
	}

	console.log('');
	console.log('[sync] ✅ Sync complete!');
	console.log(`[sync]    Branch : ${branchName}`);
	console.log(`[sync]    Remote : ${REMOTE_URL}`);
	console.log(`[sync]    Graph  : ${graphDir}`);
} catch (err) {
	console.error('');
	console.error(`[sync] ✗ Error: ${err.message}`);
	console.error('[sync]   You may need to:');
	console.error('[sync]   1. Check your Git credentials for git.woa.com');
	console.error('[sync]   2. Ensure the remote repository exists');
	console.error('[sync]   3. Run "git config --global user.name/user.email" if not set');
	process.exit(1);
}
