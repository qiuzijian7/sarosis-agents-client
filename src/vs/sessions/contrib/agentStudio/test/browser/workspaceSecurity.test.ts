/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * workspaceSecurity — worktree 独占沙箱「强隔离」开关验收测试（真实导入集成测试）。
 *
 * 直接 import 被测实现 `resolveAndCheckWorkspacePathImpl`（而非重新实现逻辑），覆盖
 * worktree 绑定下的两种隔离策略：
 *
 *   - 严格隔离（chat.agent.worktreeStrictIsolation = true，默认开启）：
 *       仅放行 worktreeRoot + ~/.vssaros* 数据目录（含 KB 根），
 *       【不再】放行 VS Code 工作区文件夹 / Saros 主仓 / 关联文件夹。
 *   - 非严格（显式设置 worktreeStrictIsolation = false）：
 *       继续放行上述全部文件夹，便于多根代码分析。
 *
 * 运行方式：
 *   cd <project-root>
 *   npx mocha --require ts-node/register \
 *     src/vs/sessions/contrib/agentStudio/test/browser/workspaceSecurity.test.ts
 */

import assert from 'assert';
import * as path from 'path';

import {
	resolveAndCheckWorkspacePathImpl,
	SandboxViolationError,
	WorkspacePathDeps,
} from '../../browser/providers/tool/workspaceSecurity.js';
import { AgentNetworkDomainSettingId } from '../../../../../platform/networkFilter/common/settings.js';

// ── 测试用常量（与 source 中使用的 config / storage key 保持一致）────────────
const KB_STORAGE_PATH_KEY = 'agentStudio.knowledge.storage.path';
const KB_DIR_KEY = 'agentStudio.kb.kbDir';
const KB_VAULTS_KEY = 'agentStudio.kb.vaults';

// ── 平台无关的绝对路径构造 ────────────────────────────────────────────────
const ROOT = process.platform === 'win32' ? 'C:\\__agent_test__' : '/__agent_test__';
const WORKTREE_ROOT = path.join(ROOT, 'worktree-a');
const VSCODE_FOLDER = path.join(ROOT, 'vscode-folder');
const SAROS_MAIN = path.join(ROOT, 'saros-main');
const RELATED_REPO = path.join(ROOT, 'related-repo');
const USER_DATA_DIR = path.join(ROOT, '.vssaros'); // ~/.vssaros* 数据目录
const KB_ROOT = path.join(USER_DATA_DIR, 'knowledge-base'); // resolveKbRoot(undefined, userDataDir)

// ── 依赖 mock 工厂 ────────────────────────────────────────────────────────
interface Scenario {
	strict?: boolean | undefined;
	vscodeFolders?: (string | { uri: { fsPath: string } })[];
	sarosWorkspace?: { path?: string; relatedFolders?: { path: string }[]; sandboxRoots?: string[] };
	kbStoragePath?: string | undefined;
	kbDir?: string | undefined;
	sandboxBypassRoots?: Set<string>;
}

function makeDeps(scenario: Scenario): WorkspacePathDeps {
	const {
		strict = undefined,
		vscodeFolders = [],
		sarosWorkspace = { sandboxRoots: [] },
		kbStoragePath = undefined,
		kbDir = undefined,
		sandboxBypassRoots = new Set<string>(),
	} = scenario;

	const configurationService: any = {
		getValue(key: string): unknown {
			if (key === AgentNetworkDomainSettingId.WorktreeStrictIsolation) return strict;
			if (key === KB_STORAGE_PATH_KEY) return kbStoragePath;
			return undefined;
		},
	};

	const storageService: any = {
		get(key: string): string | undefined {
			if (key === KB_DIR_KEY) return kbDir;
			if (key === KB_VAULTS_KEY) return undefined;
			return undefined;
		},
	};

	const workspaceService: any = {
		getWorkspace(): { folders: { uri: { fsPath: string } }[] } {
			// 源码按 folder.uri.fsPath 读取（workspaceSecurity.ts:117），故此处需包裹 uri
			return { folders: vscodeFolders.map((f) => (typeof f === 'string' ? { uri: { fsPath: f } } : f)) };
		},
	};

	const studioService: any = {
		getActiveWorkspaceId: () => 'ws-1',
		getAgentBinding: () => ({ worktreePath: WORKTREE_ROOT }),
		getWorkspace: () => sarosWorkspace,
	};

	const environmentService: any = {
		userDataPath: USER_DATA_DIR,
	};

	const logService: any = {
		info: () => {},
		warn: () => {},
	};

	return {
		studioService,
		workspaceService,
		environmentService,
		configurationService,
		storageService,
		logService,
		sandboxBypassRoots,
		kbStoragePathKey: KB_STORAGE_PATH_KEY,
	};
}

const AGENT_ID = 'agent-1';

// ── 断言辅助 ───────────────────────────────────────────────────────────────
async function expectAllowed(deps: WorkspacePathDeps, requested: string): Promise<string> {
	return resolveAndCheckWorkspacePathImpl(deps, AGENT_ID, requested);
}

async function expectBlocked(deps: WorkspacePathDeps, requested: string): Promise<SandboxViolationError> {
	try {
		await resolveAndCheckWorkspacePathImpl(deps, AGENT_ID, requested);
	} catch (e) {
		if (e instanceof SandboxViolationError) return e;
		throw new Error(`expected SandboxViolationError but got: ${(e as Error).message}`);
	}
	throw new Error(`expected SandboxViolationError for path "${requested}" but resolved successfully`);
}

// ── 测试套件 ───────────────────────────────────────────────────────────────
suite('Workspace Security — worktree 强隔离开关', () => {

	suite('严格隔离（worktreeStrictIsolation = true）', () => {
		const deps = makeDeps({ strict: true });

		test('放行 worktree 内的路径', async () => {
			const resolved = await expectAllowed(deps, path.join(WORKTREE_ROOT, 'src', 'file.ts'));
			assert.strictEqual(resolved, path.join(WORKTREE_ROOT, 'src', 'file.ts'));
		});

		test('相对路径 "." 解析到 worktree 根', async () => {
			const resolved = await expectAllowed(deps, '.');
			assert.strictEqual(resolved, WORKTREE_ROOT);
		});

		test('放行 ~/.vssaros 数据目录', async () => {
			const resolved = await expectAllowed(deps, path.join(USER_DATA_DIR, 'skills', 'x.md'));
			assert.strictEqual(resolved, path.join(USER_DATA_DIR, 'skills', 'x.md'));
		});

		test('放行知识库根（~/.vssaros/knowledge-base）', async () => {
			const resolved = await expectAllowed(deps, path.join(KB_ROOT, 'note.md'));
			assert.strictEqual(resolved, path.join(KB_ROOT, 'note.md'));
		});

		test('【关键】不再放行 VS Code 工作区文件夹', async () => {
			const err = await expectBlocked(deps, path.join(VSCODE_FOLDER, 'engine', 'x.cpp'));
			assert.strictEqual(err.isWorktree, true);
			const blocked = err.allowedRoots.some(
				r => r.toLowerCase() === VSCODE_FOLDER.toLowerCase(),
			);
			assert.ok(!blocked, 'VS Code 工作区文件夹不应出现在放行根中');
		});

		test('【关键】不再放行 Saros 主仓 / 关联文件夹', async () => {
			const mainErr = await expectBlocked(deps, path.join(SAROS_MAIN, 'y.ts'));
			assert.strictEqual(mainErr.isWorktree, true);

			const relatedErr = await expectBlocked(deps, path.join(RELATED_REPO, 'z.ts'));
			assert.strictEqual(relatedErr.isWorktree, true);
		});

		test('未绑定的其它仓库被拦截', async () => {
			const other = path.join(ROOT, 'other-repo', 'a.ts');
			const err = await expectBlocked(deps, other);
			assert.strictEqual(err.isWorktree, true);
		});
	});

	suite('非严格隔离（显式 worktreeStrictIsolation = false）', () => {
		const deps = makeDeps({
			strict: false,
			vscodeFolders: [{ uri: { fsPath: VSCODE_FOLDER } }],
			sarosWorkspace: {
				path: SAROS_MAIN,
				relatedFolders: [{ path: RELATED_REPO }],
				sandboxRoots: [],
			},
		});

		test('放行 worktree 内路径', async () => {
			const resolved = await expectAllowed(deps, path.join(WORKTREE_ROOT, 'a.ts'));
			assert.strictEqual(resolved, path.join(WORKTREE_ROOT, 'a.ts'));
		});

		test('继续放行 VS Code 工作区文件夹（多根代码分析）', async () => {
			const resolved = await expectAllowed(deps, path.join(VSCODE_FOLDER, 'engine', 'x.cpp'));
			assert.strictEqual(resolved, path.join(VSCODE_FOLDER, 'engine', 'x.cpp'));
		});

		test('继续放行 Saros 主仓', async () => {
			const resolved = await expectAllowed(deps, path.join(SAROS_MAIN, 'y.ts'));
			assert.strictEqual(resolved, path.join(SAROS_MAIN, 'y.ts'));
		});

		test('继续放行关联文件夹', async () => {
			const resolved = await expectAllowed(deps, path.join(RELATED_REPO, 'z.ts'));
			assert.strictEqual(resolved, path.join(RELATED_REPO, 'z.ts'));
		});

		test('仍放行 ~/.vssaros 数据目录', async () => {
			const resolved = await expectAllowed(deps, path.join(USER_DATA_DIR, 'memory', 'm.json'));
			assert.strictEqual(resolved, path.join(USER_DATA_DIR, 'memory', 'm.json'));
		});

		test('sandboxBypassRoots 仍临时放行精确路径', async () => {
			const bypass = path.join(ROOT, 'tmp-bypass', 't.ts');
			deps.sandboxBypassRoots.add(bypass);
			const resolved = await expectAllowed(deps, bypass);
			assert.strictEqual(resolved, bypass);
		});

		test('越界的其它仓库仍被拦截', async () => {
			const other = path.join(ROOT, 'other-repo', 'a.ts');
			const err = await expectBlocked(deps, other);
			assert.strictEqual(err.isWorktree, true);
		});
	});

	suite('默认值行为（配置缺省 = true）', () => {
		test('配置返回 undefined 时等价于 true（默认严格隔离）', async () => {
			const deps = makeDeps({
				strict: undefined, // 模拟配置未设置
				vscodeFolders: [{ uri: { fsPath: VSCODE_FOLDER } }],
				sarosWorkspace: { path: SAROS_MAIN, relatedFolders: [], sandboxRoots: [] },
			});
			// 未设置时 VS Code 文件夹被拦截 → 证明默认是严格隔离
			const err = await expectBlocked(deps, path.join(VSCODE_FOLDER, 'x.ts'));
			assert.strictEqual(err.isWorktree, true);
		});
	});

	suite('checkSandbox = false（读操作直通）', () => {
		test('关闭沙箱判定时越界路径也直接返回解析结果', async () => {
			const deps = makeDeps({ strict: true });
			const outOfBounds = path.join(VSCODE_FOLDER, 'x.ts');
			const resolved = await resolveAndCheckWorkspacePathImpl(deps, AGENT_ID, outOfBounds, false);
			assert.strictEqual(resolved, outOfBounds);
		});
	});
});
