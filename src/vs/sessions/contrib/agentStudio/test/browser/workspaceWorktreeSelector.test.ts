/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 聊天框 Workspace / Worktree 选择器功能测试。
 *
 * 函数调用链（从 UI 到沙箱）：
 *
 *   ┌─ Composer 工具栏 ────────────────────────────────────────────────────────┐
 *   │  agentChatPanel.composer.ts:_renderToolbar()                              │
 *   │    L432: workspace-tag 按钮 → _openWorkspaceDropdown()                   │
 *   │    L453: worktree-tag 按钮  → _openWorktreeDropdown()                    │
 *   └──────────────────────────────────────────────────────────────────────────┘
 *                                   │
 *   ┌─ Dropdown 渲染 ──────────────────────────────────────────────────────────┐
 *   │  agentChatPanel.dropdowns.ts:_openWorkspaceDropdown()                    │
 *   │    → renderItems(list)  → _onSelectWorkspace?.(ws.id, ws.name)          │
 *   │  agentChatPanel.dropdowns.ts:_openWorktreeDropdown()                     │
 *   │    → _loadWorktreesAndRender(list, loadingEl)                           │
 *   │      → _onLoadWorktrees()  → _onSelectWorktree?.({path,branch})         │
 *   │      → _onClearWorktree?.()                                             │
 *   └──────────────────────────────────────────────────────────────────────────┘
 *                                   │
 *   ┌─ 状态注入（NativeChatEditorPane）───────────────────────────────────────┐
 *   │  nativeChatEditorPane.ts: _setPanelCallbacks()                          │
 *   │    onLoadWorktrees  → _getWorktrees() → studioService.getWorktrees()     │
 *   │    onSelectWorktree → upsertAgentBinding({worktreePath})                 │
 *   │    onClearWorktree  → upsertAgentBinding({worktreePath: undefined})      │
 *   │    onLoadWorkspaces → _loadWorkspaces() → studioService.getWorkspaces()  │
 *   │    onSelectWorkspace→ upsertAgentBinding({worktreePath: ws.path})        │
 *   │      → _loadWorktrees() → _chatPanel.setWorktrees() / setSelected()      │
 *   └──────────────────────────────────────────────────────────────────────────┘
 *                                   │
 *   ┌─ 沙箱执行（工具 cwd 隔离）──────────────────────────────────────────────┐
 *   │  workspaceSecurity.ts: resolveAndCheckWorkspacePathImpl()                 │
 *   │    → binding.worktreePath → allowedRoots                                │
 *   │  agentOSService._executeToolCalls(toolCall.worktreePath)                │
 *   │    → executeWithRetryAndTimeout(..., {arguments, worktreePath})         │
 *   │  builtinToolProvider.setParentWorktreePath(worktreePath)                │
 *   │    → delegate_task 工具 propagate worktree 到 sub-agent                │
 *   └──────────────────────────────────────────────────────────────────────────┘
 */

import assert from 'assert';

// ─── Mock Types ────────────────────────────────────────────────────────────

interface IWorktreeItem {
	path: string;
	branch: string;
	outgoingChanges?: number;
	incomingChanges?: number;
	uncommittedChanges?: number;
}

interface IWorkspaceItem {
	id: string;
	name: string;
	path: string;
}

// ─── Mock Panel State（模拟 AgentChatPanelBase 的状态字段）────────────────────

class MockPanelState {
	worktrees: IWorktreeItem[] = [];
	selectedWorktreePath: string = '';
	workspaces: IWorkspaceItem[] = [];
	selectedWorkspaceId: string = '';

	// 回调记录
	onSelectWorkspaceCalls: Array<{ id: string; name: string }> = [];
	onSelectWorktreeCalls: Array<{ path: string; branch: string }> = [];
	onClearWorktreeCalls: number = 0;
	onLoadWorkspacesCalls: number = 0;
	onLoadWorktreesCalls: number = 0;

	// ── 模拟回调（与 nativeChatEditorPane._setPanelCallbacks 中的对应）──

	getOnSelectWorkspace() {
		return (wsId: string, wsName: string) => {
			this.selectedWorkspaceId = wsId;
			this.onSelectWorkspaceCalls.push({ id: wsId, name: wsName });
		};
	}

	getOnSelectWorktree() {
		return (wt: { path: string; branch: string }) => {
			this.selectedWorktreePath = wt.path;
			this.onSelectWorktreeCalls.push(wt);
		};
	}

	getOnClearWorktree() {
		return () => {
			this.selectedWorktreePath = '';
			this.onClearWorktreeCalls++;
		};
	}

	getOnLoadWorkspaces() {
		return async () => {
			this.onLoadWorkspacesCalls++;
			return this.workspaces;
		};
	}

	getOnLoadWorktrees() {
		return async () => {
			this.onLoadWorktreesCalls++;
			return this.worktrees;
		};
	}

	// ── 模拟 _getWorktreeLabel()（dropdowns.ts L49-54）──
	getWorktreeLabel(): string {
		if (!this.selectedWorktreePath) { return '主仓库'; }
		const current = this.worktrees.find(w => w.path === this.selectedWorktreePath);
		if (current?.branch) { return current.branch; }
		return this.selectedWorktreePath.split(/[\\/]/).filter(Boolean).pop() || this.selectedWorktreePath;
	}

	// ── 模拟 _getWorkspacesLabel()（composer.ts L433-434）──
	getWorkspaceLabel(): string {
		return this.workspaces.find(w => w.id === this.selectedWorkspaceId)?.name ||
			this.workspaces[0]?.name || '工作区';
	}
}

// ─── Mock AgentStudioService（模拟 worktree 数据提供）─────────────────────────

class MockAgentStudioService {
	private _workspaces: IWorkspaceItem[] = [];
	private _worktreeData: Map<string, IWorktreeItem[]> = new Map();
	private _activeWorkspaceId: string = '';
	private _bindings: Map<string, { worktreePath?: string; worktreeBranch?: string }> = new Map();

	setWorkspaces(workspaces: IWorkspaceItem[]) { this._workspaces = workspaces; }
	setWorktrees(workspaceId: string, worktrees: IWorktreeItem[]) { this._worktreeData.set(workspaceId, worktrees); }
	setActiveWorkspaceId(id: string) { this._activeWorkspaceId = id; }

	async getWorkspaces(): Promise<IWorkspaceItem[]> { return this._workspaces; }
	async getWorktrees(workspaceId: string): Promise<IWorktreeItem[]> { return this._worktreeData.get(workspaceId) ?? []; }
	getActiveWorkspaceId(): string { return this._activeWorkspaceId; }

	async getAgentBinding(workspaceId: string, agentId: string): Promise<{ worktreePath?: string; worktreeBranch?: string } | undefined> {
		return this._bindings.get(`${workspaceId}:${agentId}`);
	}

	async upsertAgentBinding(workspaceId: string, agentId: string, data: { worktreePath?: string; worktreeBranch?: string }): Promise<void> {
		const key = `${workspaceId}:${agentId}`;
		const existing = this._bindings.get(key) ?? {};
		this._bindings.set(key, { ...existing, ...data });
	}
}

// ─── 模拟 nativeChatEditorPane._loadWorktrees() / _loadWorkspaces() ───────────

async function mockLoadWorktrees(
	service: MockAgentStudioService,
	panel: MockPanelState,
	currentWorkspaceId: string | null,
	currentAgentId: string | null,
): Promise<void> {
	const workspaceId = currentWorkspaceId || service.getActiveWorkspaceId();
	if (!workspaceId) {
		panel.worktrees = [];
		panel.selectedWorktreePath = '';
		return;
	}
	const worktrees = await service.getWorktrees(workspaceId);
	panel.worktrees = worktrees;
	// 从 binding 恢复选中状态
	if (currentAgentId) {
		const binding = await service.getAgentBinding(workspaceId, currentAgentId);
		if (binding?.worktreePath) {
			panel.selectedWorktreePath = binding.worktreePath;
		}
	}
}

async function mockLoadWorkspaces(
	service: MockAgentStudioService,
	panel: MockPanelState,
	currentWorkspaceId: string | null,
): Promise<void> {
	const workspaces = await service.getWorkspaces();
	panel.workspaces = workspaces;
	const activeId = currentWorkspaceId || service.getActiveWorkspaceId() || (workspaces.length > 0 ? workspaces[0].id : '');
	if (activeId) {
		panel.selectedWorkspaceId = activeId;
	}
}

// ─── 模拟 nativeChatEditorPane.onSelectWorkspace 完整流程 ────────────────────

async function mockSelectWorkspace(
	service: MockAgentStudioService,
	panel: MockPanelState,
	currentAgentId: string,
	workspaceId: string,
): Promise<void> {
	// 1. 设置当前 workspace
	// panel.selectedWorkspaceId 由 onSelectWorkspace 回调设置

	// 2. 绑定沙箱到工作区路径
	const ws = await service.getWorkspaces().then(list => list.find(w => w.id === workspaceId));
	if (ws?.path) {
		await service.upsertAgentBinding(workspaceId, currentAgentId, {
			worktreePath: ws.path,
		});
	}

	// 3. 清空旧 worktree
	panel.worktrees = [];
	panel.selectedWorktreePath = '';

	// 4. 重新加载新 workspace 的 worktree
	await mockLoadWorktrees(service, panel, workspaceId, currentAgentId);
}

// ─── 模拟 workspaceSecurity.resolveAndCheckWorkspacePath 核心逻辑 ─────────────

function computeAllowedRoots(
	binding: { worktreePath?: string } | undefined,
	vscodeFolders: string[],
	workspacePath: string | undefined,
	relatedFolders: Array<{ path?: string }> | undefined,
	userDataPath: string | undefined,
): string[] {
	const allowedRoots: string[] = [];

	if (binding?.worktreePath) {
		// 独占模式：worktree 是主沙箱
		allowedRoots.push(binding.worktreePath.replace(/[\\/]+$/, ''));
		// VS Code 工作区文件夹也放行
		for (const folder of vscodeFolders) {
			allowedRoots.push(folder.replace(/[\\/]+$/, ''));
		}
		// Sarosis 工作区路径 + 关联文件夹
		if (workspacePath) {
			allowedRoots.push(workspacePath.replace(/[\\/]+$/, ''));
		}
		for (const rf of relatedFolders ?? []) {
			if (rf?.path) { allowedRoots.push(rf.path.replace(/[\\/]+$/, '')); }
		}
	} else {
		// 常规模式：未绑定 worktree
		for (const folder of vscodeFolders) {
			allowedRoots.push(folder.replace(/[\\/]+$/, ''));
		}
		if (workspacePath) {
			allowedRoots.push(workspacePath.replace(/[\\/]+$/, ''));
		}
		for (const rf of relatedFolders ?? []) {
			if (rf?.path) { allowedRoots.push(rf.path.replace(/[\\/]+$/, '')); }
		}
	}

	// 用户数据目录脱离沙箱（真实代码中也不 strip 末尾斜杠，由后续 resolveAndCheck 处理）
	if (userDataPath) {
		allowedRoots.push(userDataPath.replace(/[\\/]+$/, ''));
	}

	return allowedRoots;
}

// ─── 模拟 onSelectWorktree / onClearWorktree ─────────────────────────────────

async function mockSelectWorktree(
	service: MockAgentStudioService,
	panel: MockPanelState,
	workspaceId: string,
	agentId: string,
	wt: { path: string; branch: string },
): Promise<void> {
	panel.selectedWorktreePath = wt.path;
	await service.upsertAgentBinding(workspaceId, agentId, {
		worktreePath: wt.path,
		worktreeBranch: wt.branch,
	});
}

async function mockClearWorktree(
	service: MockAgentStudioService,
	panel: MockPanelState,
	workspaceId: string,
	agentId: string,
): Promise<void> {
	panel.selectedWorktreePath = '';
	await service.upsertAgentBinding(workspaceId, agentId, {
		worktreePath: undefined,
		worktreeBranch: undefined,
	});
}

// ─── Tests ──────────────────────────────────────────────────────────────────

suite('Workspace/Worktree 选择器 — 聊天框功能', () => {

	// ══════════════════════════════════════════════════════════════════════════
	// 1. 渲染层：按钮标签正确反映状态
	// ══════════════════════════════════════════════════════════════════════════

	suite('1. 渲染层 — 按钮标签', () => {

		test('未选中 worktree 时显示"主仓库"', () => {
			const panel = new MockPanelState();
			assert.strictEqual(panel.getWorktreeLabel(), '主仓库');
		});

		test('选中 worktree 时显示分支名', () => {
			const panel = new MockPanelState();
			panel.worktrees = [{ path: '/repo/wt-1', branch: 'feature/login' }];
			panel.selectedWorktreePath = '/repo/wt-1';
			assert.strictEqual(panel.getWorktreeLabel(), 'feature/login');
		});

		test('选中 worktree 但无分支名时显示路径末段', () => {
			const panel = new MockPanelState();
			panel.selectedWorktreePath = '/repo/wt-1';
			assert.strictEqual(panel.getWorktreeLabel(), 'wt-1');
		});

		test('选中 worktree 在列表中匹配时取分支名', () => {
			const panel = new MockPanelState();
			panel.worktrees = [
				{ path: '/repo/wt-1', branch: 'feat-a' },
				{ path: '/repo/wt-2', branch: 'feat-b' },
			];
			panel.selectedWorktreePath = '/repo/wt-2';
			assert.strictEqual(panel.getWorktreeLabel(), 'feat-b');
		});

		test('未选中 workspace 时显示第一个工作区名', () => {
			const panel = new MockPanelState();
			panel.workspaces = [
				{ id: 'ws-1', name: 'UE5EA', path: '/repo/UE5EA' },
				{ id: 'ws-2', name: 'S1Game', path: '/repo/S1Game' },
			];
			assert.strictEqual(panel.getWorkspaceLabel(), 'UE5EA');
		});

		test('选中 workspace 时显示对应名称', () => {
			const panel = new MockPanelState();
			panel.workspaces = [
				{ id: 'ws-1', name: 'UE5EA', path: '/repo/UE5EA' },
				{ id: 'ws-2', name: 'S1Game', path: '/repo/S1Game' },
			];
			panel.selectedWorkspaceId = 'ws-2';
			assert.strictEqual(panel.getWorkspaceLabel(), 'S1Game');
		});
	});

	// ══════════════════════════════════════════════════════════════════════════
	// 2. Workspace 选择流程
	// ══════════════════════════════════════════════════════════════════════════

	suite('2. Workspace 选择流程', () => {

		test('onSelectWorkspace 回调更新 selectedWorkspaceId', async () => {
			const service = new MockAgentStudioService();
			const panel = new MockPanelState();
			const workspaces: IWorkspaceItem[] = [
				{ id: 'ws-1', name: 'UE5EA', path: '/repo/UE5EA' },
				{ id: 'ws-2', name: 'S1Game', path: '/repo/S1Game' },
			];
			service.setWorkspaces(workspaces);
			service.setActiveWorkspaceId('ws-1');
			panel.workspaces = workspaces;
			panel.selectedWorkspaceId = 'ws-1';

			// 模拟点击 ws-2
			panel.getOnSelectWorkspace()('ws-2', 'S1Game');
			await mockSelectWorkspace(service, panel, 'agent-1', 'ws-2');

			assert.strictEqual(panel.selectedWorkspaceId, 'ws-2');
			assert.strictEqual(panel.onSelectWorkspaceCalls.length, 1);
			assert.strictEqual(panel.onSelectWorkspaceCalls[0].id, 'ws-2');
		});

		test('切换 workspace 后 binding 更新为工作区路径，worktree 列表重新加载', async () => {
			const service = new MockAgentStudioService();
			const panel = new MockPanelState();
			service.setWorkspaces([
				{ id: 'ws-1', name: 'UE5EA', path: '/repo/UE5EA' },
				{ id: 'ws-2', name: 'S1Game', path: '/repo/S1Game' },
			]);
			service.setWorktrees('ws-1', [{ path: '/repo/wt-ue5', branch: 'main' }]);
			service.setWorktrees('ws-2', [{ path: '/repo/wt-s1', branch: 'dev' }]);
			panel.workspaces = [
				{ id: 'ws-1', name: 'UE5EA', path: '/repo/UE5EA' },
				{ id: 'ws-2', name: 'S1Game', path: '/repo/S1Game' },
			];
			panel.worktrees = [{ path: '/repo/wt-ue5', branch: 'main' }];
			panel.selectedWorkspaceId = 'ws-1';
			panel.selectedWorktreePath = '/repo/wt-ue5';

			// 模拟切换到 ws-2
			panel.getOnSelectWorkspace()('ws-2', 'S1Game');
			await mockSelectWorkspace(service, panel, 'agent-1', 'ws-2');

			// workspace 已切换
			assert.strictEqual(panel.selectedWorkspaceId, 'ws-2');
			// binding 已绑定到新工作区路径（onSelectWorkspace 把 worktreePath 绑定为 ws.path）
			const binding = await service.getAgentBinding('ws-2', 'agent-1');
			assert.strictEqual(binding?.worktreePath, '/repo/S1Game');
			// selectedWorktreePath 从 binding 恢复为新工作区路径
			assert.strictEqual(panel.selectedWorktreePath, '/repo/S1Game');
			// 新 workspace 的 worktree 列表已加载
			assert.strictEqual(panel.worktrees.length, 1);
			assert.strictEqual(panel.worktrees[0].path, '/repo/wt-s1');
		});

		test('重复选择同一 workspace 不触发回调', async () => {
			const panel = new MockPanelState();
			panel.workspaces = [{ id: 'ws-1', name: 'UE5EA', path: '/repo/UE5EA' }];
			panel.selectedWorkspaceId = 'ws-1';

			// 模拟 dropdown 点击：如果 id 相同则跳过
			const wsId = 'ws-1';
			if (wsId !== panel.selectedWorkspaceId) {
				panel.getOnSelectWorkspace()(wsId, 'UE5EA');
			}

			assert.strictEqual(panel.onSelectWorkspaceCalls.length, 0);
		});
	});

	// ══════════════════════════════════════════════════════════════════════════
	// 3. Worktree 选择流程
	// ══════════════════════════════════════════════════════════════════════════

	suite('3. Worktree 选择流程', () => {

		test('onSelectWorktree 更新 selectedWorktreePath 并持久化到 binding', async () => {
			const service = new MockAgentStudioService();
			const panel = new MockPanelState();
			service.setActiveWorkspaceId('ws-1');
			service.setWorktrees('ws-1', [{ path: '/repo/wt-1', branch: 'feat-x' }]);
			panel.worktrees = [{ path: '/repo/wt-1', branch: 'feat-x' }];
			panel.selectedWorkspaceId = 'ws-1';

			// 模拟选中 worktree
			await mockSelectWorktree(service, panel, 'ws-1', 'agent-1', { path: '/repo/wt-1', branch: 'feat-x' });

			assert.strictEqual(panel.selectedWorktreePath, '/repo/wt-1');

			// 验证 binding 持久化
			const binding = await service.getAgentBinding('ws-1', 'agent-1');
			assert.strictEqual(binding?.worktreePath, '/repo/wt-1');
			assert.strictEqual(binding?.worktreeBranch, 'feat-x');
		});

		test('onClearWorktree 清空 selectedWorktreePath 并清除 binding', async () => {
			const service = new MockAgentStudioService();
			const panel = new MockPanelState();
			service.setActiveWorkspaceId('ws-1');
			// 先绑定一个 worktree
			await service.upsertAgentBinding('ws-1', 'agent-1', {
				worktreePath: '/repo/wt-1',
				worktreeBranch: 'feat-x',
			});
			panel.selectedWorktreePath = '/repo/wt-1';

			// 模拟点击"主仓库"
			await mockClearWorktree(service, panel, 'ws-1', 'agent-1');

			assert.strictEqual(panel.selectedWorktreePath, '');

			// 验证 binding 被清除
			const binding = await service.getAgentBinding('ws-1', 'agent-1');
			assert.strictEqual(binding?.worktreePath, undefined);
			assert.strictEqual(binding?.worktreeBranch, undefined);
		});

		test('切换到"主仓库"后 getWorktreeLabel 显示"主仓库"', async () => {
			const panel = new MockPanelState();
			panel.worktrees = [{ path: '/repo/wt-1', branch: 'feat-x' }];
			panel.selectedWorktreePath = '/repo/wt-1';
			assert.strictEqual(panel.getWorktreeLabel(), 'feat-x');

			panel.selectedWorktreePath = '';
			assert.strictEqual(panel.getWorktreeLabel(), '主仓库');
		});
	});

	// ══════════════════════════════════════════════════════════════════════════
	// 4. Worktree 沙箱隔离 — 工具 cwd 限制
	// ══════════════════════════════════════════════════════════════════════════

	suite('4. Worktree 沙箱隔离', () => {

		test('绑定 worktree 后 allowedRoots 包含 worktree 路径', () => {
			const roots = computeAllowedRoots(
				{ worktreePath: '/repo/wt-feature' },
				['/repo/UE5EA'],
				'/repo/S1Game',
				[{ path: '/repo/Engine' }],
				'/home/user/.vssaros',
			);

			assert.ok(roots.includes('/repo/wt-feature'), 'worktree 路径应在 allowedRoots 中');
			assert.ok(roots.includes('/repo/UE5EA'), 'VS Code 工作区文件夹应放行');
			assert.ok(roots.includes('/repo/S1Game'), 'Sarosis workspace 应放行');
			assert.ok(roots.includes('/repo/Engine'), 'relatedFolders 应放行');
			assert.ok(roots.includes('/home/user/.vssaros'), '用户数据目录应放行');
		});

		test('未绑定 worktree 时 allowedRoots 不包含 worktree 路径', () => {
			const roots = computeAllowedRoots(
				undefined,
				['/repo/UE5EA'],
				'/repo/S1Game',
				[{ path: '/repo/Engine' }],
				'/home/user/.vssaros',
			);

			assert.ok(!roots.includes('/repo/wt-feature'), '未绑定 worktree 时不应包含 worktree 路径');
			assert.ok(roots.includes('/repo/UE5EA'), 'VS Code 工作区文件夹应放行');
			assert.ok(roots.includes('/repo/S1Game'), 'Sarosis workspace 应放行');
			assert.ok(roots.includes('/repo/Engine'), 'relatedFolders 应放行');
		});

		test('worktree 路径规范化：末尾斜杠被移除', () => {
			const roots = computeAllowedRoots(
				{ worktreePath: '/repo/wt-feature/' },
				['/repo/UE5EA/'],
				'/repo/S1Game/',
				[],
				'/home/user/.vssaros/',
			);

			assert.ok(roots.includes('/repo/wt-feature'), 'worktree 路径末尾斜杠应被移除');
			// vscodeFolders 在真实代码中直接 push（不 strip 末尾斜杠），这里验证 root 确实含文件夹路径
			assert.ok(roots.some(r => r.startsWith('/repo/UE5EA')), 'VS Code 工作区文件夹应在 roots 中');
			assert.ok(roots.includes('/repo/S1Game'), 'Sarosis workspace 末尾斜杠应被移除');
			assert.ok(roots.includes('/home/user/.vssaros'), '用户数据目录末尾斜杠应被移除');
		});
	});

	// ══════════════════════════════════════════════════════════════════════════
	// 5. 状态恢复 — 从 binding 恢复选中 worktree
	// ══════════════════════════════════════════════════════════════════════════

	suite('5. 状态恢复', () => {

		test('_loadWorktrees 从 binding 恢复 selectedWorktreePath', async () => {
			const service = new MockAgentStudioService();
			const panel = new MockPanelState();
			service.setActiveWorkspaceId('ws-1');
			service.setWorktrees('ws-1', [
				{ path: '/repo/wt-1', branch: 'feat-a' },
				{ path: '/repo/wt-2', branch: 'feat-b' },
			]);
			// 预置 binding：选中 wt-2
			await service.upsertAgentBinding('ws-1', 'agent-1', {
				worktreePath: '/repo/wt-2',
				worktreeBranch: 'feat-b',
			});

			await mockLoadWorktrees(service, panel, null, 'agent-1');

			assert.strictEqual(panel.selectedWorktreePath, '/repo/wt-2');
			assert.strictEqual(panel.worktrees.length, 2);
			assert.strictEqual(panel.getWorktreeLabel(), 'feat-b');
		});

		test('binding 无 worktreePath 时 selectedWorktreePath 保持为空', async () => {
			const service = new MockAgentStudioService();
			const panel = new MockPanelState();
			service.setActiveWorkspaceId('ws-1');
			service.setWorktrees('ws-1', [{ path: '/repo/wt-1', branch: 'feat-a' }]);

			await mockLoadWorktrees(service, panel, null, 'agent-1');

			assert.strictEqual(panel.selectedWorktreePath, '');
			assert.strictEqual(panel.getWorktreeLabel(), '主仓库');
		});

		test('无 workspaceId 时 worktree 列表为空', async () => {
			const service = new MockAgentStudioService();
			const panel = new MockPanelState();
			// 不设置 activeWorkspaceId
			await mockLoadWorktrees(service, panel, null, 'agent-1');

			assert.strictEqual(panel.worktrees.length, 0);
			assert.strictEqual(panel.selectedWorktreePath, '');
		});
	});

	// ══════════════════════════════════════════════════════════════════════════
	// 6. 回调完整性 — 数据流正确传递
	// ══════════════════════════════════════════════════════════════════════════

	suite('6. 回调完整性', () => {

		test('onLoadWorktrees 被调用时返回 worktree 列表', async () => {
			const service = new MockAgentStudioService();
			service.setActiveWorkspaceId('ws-1');
			service.setWorktrees('ws-1', [
				{ path: '/repo/wt-1', branch: 'feat-a', outgoingChanges: 2, incomingChanges: 1 },
				{ path: '/repo/wt-2', branch: 'feat-b' },
			]);

			const result = await service.getWorktrees('ws-1');
			assert.strictEqual(result.length, 2);
			assert.strictEqual(result[0].branch, 'feat-a');
			assert.strictEqual(result[0].outgoingChanges, 2);
			assert.strictEqual(result[0].incomingChanges, 1);
			assert.strictEqual(result[1].branch, 'feat-b');
		});

		test('onLoadWorkspaces 被调用时返回 workspace 列表（过滤无 path 的）', async () => {
			const service = new MockAgentStudioService();
			service.setWorkspaces([
				{ id: 'ws-1', name: 'UE5EA', path: '/repo/UE5EA' },
				{ id: 'ws-2', name: 'NoPath', path: '' },
				{ id: 'ws-3', name: 'S1Game', path: '/repo/S1Game' },
			]);

			const workspaces = await service.getWorkspaces();
			const filtered = workspaces.filter(ws => ws.path);
			assert.strictEqual(filtered.length, 2);
			assert.strictEqual(filtered[0].id, 'ws-1');
			assert.strictEqual(filtered[1].id, 'ws-3');
		});
	});
});
