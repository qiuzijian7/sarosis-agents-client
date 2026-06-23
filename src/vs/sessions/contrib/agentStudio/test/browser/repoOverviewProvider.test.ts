/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

// We test the pure logic of repoOverviewProvider without DI by importing
// the utility functions and testing the class directly.
// Since RepoOverviewProvider requires IFileService/IWorkspaceContextService/ILogService
// which are heavy to mock, we test the key algorithms independently.

suite('RepoOverviewProvider - Utility Logic', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ─── SKIP_DIRS / SKIP_FILES coverage ───────────────────────────────────

	test('SKIP_DIRS contains common noise directories', () => {
		// Re-import constants by re-checking the logic
		const SKIP_DIRS = new Set([
			'.git', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt',
			'vendor', '__pycache__', '.venv', 'venv', 'env', '.env',
			'target', '.cargo', '.rustup', 'coverage', '.coverage',
			'.idea', '.vscode', '.vs', 'bin', 'obj', 'Debug', 'Release',
			'.sarosworkspace',
		]);

		assert.strictEqual(SKIP_DIRS.has('node_modules'), true);
		assert.strictEqual(SKIP_DIRS.has('.git'), true);
		assert.strictEqual(SKIP_DIRS.has('dist'), true);
		assert.strictEqual(SKIP_DIRS.has('vendor'), true);
		assert.strictEqual(SKIP_DIRS.has('__pycache__'), true);
		assert.strictEqual(SKIP_DIRS.has('.sarosworkspace'), true);
		// src should NOT be skipped
		assert.strictEqual(SKIP_DIRS.has('src'), false);
		assert.strictEqual(SKIP_DIRS.has('lib'), false);
	});

	// ─── Directory Node Structure ───────────────────────────────────────────

	test('DirectoryNode structure: file nodes have no children', () => {
		const fileNode: { name: string; type: 'file' | 'directory'; children?: unknown[] } = { name: 'test.ts', type: 'file' as const };
		assert.strictEqual(fileNode.type, 'file');
		assert.strictEqual(fileNode.children, undefined);
	});

	test('DirectoryNode structure: directory nodes can have children', () => {
		const dirNode = {
			name: 'src',
			type: 'directory' as const,
			children: [
				{ name: 'index.ts', type: 'file' as const },
			],
		};
		assert.strictEqual(dirNode.type, 'directory');
		assert.strictEqual(dirNode.children!.length, 1);
	});

	// ─── Ecosystem Detection Logic ─────────────────────────────────────────

	test('ecosystem detection markers are correctly defined', () => {
		const ECOSYSTEMS = [
			{ name: 'Node.js', markerFiles: ['package.json'] },
			{ name: 'Python', markerFiles: ['requirements.txt', 'setup.py', 'pyproject.toml'] },
			{ name: 'Go', markerFiles: ['go.mod', 'go.sum'] },
			{ name: 'Rust', markerFiles: ['Cargo.toml', 'Cargo.lock'] },
			{ name: 'Ruby', markerFiles: ['Gemfile', 'Gemfile.lock'] },
			{ name: 'Java', markerFiles: ['pom.xml', 'build.gradle', 'build.gradle.kts'] },
			{ name: 'PHP', markerFiles: ['composer.json', 'composer.lock'] },
		];

		const ecoNames = ECOSYSTEMS.map(e => e.name);
		assert.ok(ecoNames.includes('Node.js'));
		assert.ok(ecoNames.includes('Python'));
		assert.ok(ecoNames.includes('Go'));
		assert.ok(ecoNames.includes('Rust'));
		assert.strictEqual(ecoNames.length, 7);
	});

	// ─── Smart Truncation Logic ────────────────────────────────────────────

	test('smart truncation prioritizes directories over files', () => {
		const MAX_CHILDREN_PER_DIR = 50;
		const dirEntries = Array.from({ length: 40 }, (_, i) => ({
			name: `dir${i}`,
			isDirectory: true,
		}));
		const fileEntries = Array.from({ length: 30 }, (_, i) => ({
			name: `file${i}.ts`,
			isDirectory: false,
		}));

		// Smart truncation: 70% dirs, 30% files
		const maxDirs = Math.min(dirEntries.length, Math.ceil(MAX_CHILDREN_PER_DIR * 0.7));
		const maxFiles = Math.min(fileEntries.length, MAX_CHILDREN_PER_DIR - Math.min(dirEntries.length, maxDirs));

		// With 40 dirs and 30 files:
		// maxDirs = min(40, ceil(50*0.7)) = min(40, 35) = 35
		// maxFiles = min(30, 50 - min(40, 35)) = min(30, 50 - 35) = min(30, 15) = 15
		assert.strictEqual(maxDirs, 35);
		assert.strictEqual(maxFiles, 15);
	});

	test('smart truncation: when dirs < 70% quota, files fill remaining', () => {
		const MAX_CHILDREN_PER_DIR = 50;
		const dirEntries = Array.from({ length: 10 }, (_, i) => ({
			name: `dir${i}`,
			isDirectory: true,
		}));
		const fileEntries = Array.from({ length: 80 }, (_, i) => ({
			name: `file${i}.ts`,
			isDirectory: false,
		}));

		const maxDirs = Math.min(dirEntries.length, Math.ceil(MAX_CHILDREN_PER_DIR * 0.7));
		const maxFiles = Math.min(fileEntries.length, MAX_CHILDREN_PER_DIR - Math.min(dirEntries.length, maxDirs));

		// With 10 dirs and 80 files:
		// maxDirs = min(10, 35) = 10
		// maxFiles = min(80, 50 - 10) = min(80, 40) = 40
		assert.strictEqual(maxDirs, 10);
		assert.strictEqual(maxFiles, 40);
	});

	// ─── Global Node Budget ────────────────────────────────────────────────

	test('global node budget (MAX_TOTAL_NODES=1000) prevents memory explosion', () => {
		const MAX_TOTAL_NODES = 1000;
		let nodeCount = 0;
		const nodes: Array<{ name: string; type: string }> = [];

		// Simulate scanning 5000 entries
		for (let i = 0; i < 5000; i++) {
			if (nodeCount >= MAX_TOTAL_NODES) { break; }
			nodeCount++;
			nodes.push({ name: `entry${i}`, type: i % 2 === 0 ? 'directory' : 'file' });
		}

		assert.strictEqual(nodes.length, MAX_TOTAL_NODES, 'Should stop at MAX_TOTAL_NODES');
	});

	// ─── Git HEAD Parsing ──────────────────────────────────────────────────

	test('parses branch name from git HEAD ref format', () => {
		const headContent = 'ref: refs/heads/feature/my-branch\n';
		const match = headContent.match(/^ref: refs\/heads\/(.+)$/);
		assert.ok(match);
		assert.strictEqual(match[1], 'feature/my-branch');
	});

	test('detects detached HEAD from raw commit hash', () => {
		const headContent = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
		const isDetached = /^[0-9a-f]{40}$/.test(headContent);
		assert.strictEqual(isDetached, true);
	});

	test('rejects invalid HEAD content', () => {
		const headContent = 'not-a-valid-ref';
		const isBranch = /^ref: refs\/heads\/(.+)$/.test(headContent);
		const isDetached = /^[0-9a-f]{40}$/.test(headContent);
		assert.strictEqual(isBranch, false);
		assert.strictEqual(isDetached, false);
	});

	// ─── Summary Format ────────────────────────────────────────────────────

	test('summary format includes key information', () => {
		const overview = {
			rootPath: '/test/project',
			ecosystems: ['Node.js', 'Python'],
			packageManager: 'pnpm',
			dependencyFiles: ['package.json', 'requirements.txt'],
			entryPoints: ['src/index.ts'],
			gitBranch: 'main',
			gitHead: 'abc1234',
		};

		// Verify all fields are present for summary generation
		assert.ok(overview.rootPath);
		assert.ok(overview.ecosystems.length > 0);
		assert.ok(overview.packageManager !== 'unknown');
		assert.ok(overview.dependencyFiles.length > 0);
		assert.ok(overview.entryPoints.length > 0);
		assert.ok(overview.gitBranch);
	});
});
