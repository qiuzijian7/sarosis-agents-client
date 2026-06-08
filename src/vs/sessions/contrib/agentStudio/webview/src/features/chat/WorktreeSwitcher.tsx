/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Worktree Switcher
 *  Dropdown in chat header to switch worktree for current agent.
 *--------------------------------------------------------------------------------------------*/

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useAgentStore } from '../../store/useAgentStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { sendRequest } from '../../bridge/messageClient';

interface WorktreeInfo {
	path: string;
	branch: string;
}

export function WorktreeSwitcher(): React.ReactElement | null {
	const { selectedAgentId: activeAgentId, agents, updateAgent } = useAgentStore();
	const { activeWorkspaceId } = useWorkspaceStore();

	const [isOpen, setIsOpen] = useState(false);
	const [worktreeList, setWorktreeList] = useState<WorktreeInfo[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const dropdownRef = useRef<HTMLDivElement>(null);

	const activeAgent = agents.find(e => e.id === activeAgentId);
	const currentWorktreePath = activeAgent?.worktreePath;
	const currentWorktreeBranch = activeAgent?.worktreeBranch;

	// Load worktree list when dropdown opens
	const fetchWorktrees = useCallback(() => {
		if (!activeWorkspaceId) { return; }

		setIsLoading(true);
		sendRequest<{ workspaceId: string }, WorktreeInfo[]>('worktree.list', { workspaceId: activeWorkspaceId })
			.then(worktrees => {
				setWorktreeList(worktrees || []);
			})
			.catch(err => {
				console.error('[WorktreeSwitcher] Failed to load worktrees:', err);
				setWorktreeList([]);
			})
			.finally(() => {
				setIsLoading(false);
			});
	}, [activeWorkspaceId]);

	useEffect(() => {
		if (!isOpen) { return; }
		fetchWorktrees();
	}, [isOpen, fetchWorktrees]);

	// Refresh the worktree list when a worktree is created/removed elsewhere
	// (e.g. via the EmployeeNode card or worktree view), even if the dropdown
	// is currently open.
	useEffect(() => {
		const handler = () => {
			// Only re-fetch when the dropdown is open; otherwise it will fetch
			// fresh data the next time it opens.
			if (isOpen) {
				fetchWorktrees();
			}
		};
		window.addEventListener('agentStudio:worktree-changed', handler);
		return () => window.removeEventListener('agentStudio:worktree-changed', handler);
	}, [isOpen, fetchWorktrees]);

	// Close dropdown when clicking outside
	useEffect(() => {
		const handler = (e: MouseEvent) => {
			if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
				setIsOpen(false);
			}
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, []);

	const handleSelectWorktree = async (path: string) => {
		if (!activeAgentId) { return; }
		const selectedWt = worktreeList.find(wt => wt.path === path);
		await updateAgent(activeAgentId, {
			worktreePath: path || undefined,
			worktreeBranch: selectedWt?.branch,
		});
		setIsOpen(false);
	};

	const handleClearWorktree = async () => {
		if (!activeAgentId) { return; }
		await updateAgent(activeAgentId, {
			worktreePath: undefined,
			worktreeBranch: undefined,
		});
		setIsOpen(false);
	};

	// Label display
	const label = currentWorktreeBranch
		? `🌿 ${currentWorktreeBranch}`
		: currentWorktreePath
			? `📁 ${currentWorktreePath.split('/').pop() || currentWorktreePath}`
			: '📁 主仓库';

	if (!activeAgent) { return null; }

	return (
		<div className="worktree-switcher" ref={dropdownRef}>
			<button
				className="worktree-switcher-trigger"
				onClick={() => setIsOpen(!isOpen)}
				title="切换 Worktree"
			>
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
					<path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
				</svg>
				<span className="worktree-switcher-label">{label}</span>
				<svg className="worktree-switcher-arrow" viewBox="0 0 12 12" width="8" height="8">
					<path d="M3 5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
				</svg>
			</button>

			{isOpen && (
				<div className="worktree-switcher-dropdown">
					{isLoading ? (
						<div className="worktree-switcher-loading">加载中...</div>
					) : (
						<>
							<div
								className={`worktree-switcher-item ${!currentWorktreePath ? 'active' : ''}`}
								onClick={() => handleClearWorktree()}
							>
								<span className="worktree-switcher-item-icon">📁</span>
								<span className="worktree-switcher-item-name">主仓库</span>
								{!currentWorktreePath && <span className="worktree-switcher-item-check">✓</span>}
							</div>

							{worktreeList.length > 0 && <div className="worktree-switcher-divider" />}

							{worktreeList.map((wt) => (
								<div
									key={wt.path}
									className={`worktree-switcher-item ${currentWorktreePath === wt.path ? 'active' : ''}`}
									onClick={() => handleSelectWorktree(wt.path)}
									title={wt.path}
								>
									<span className="worktree-switcher-item-icon">🌿</span>
									<span className="worktree-switcher-item-name">{wt.branch}</span>
									<span className="worktree-switcher-item-path">{wt.path}</span>
									{currentWorktreePath === wt.path && <span className="worktree-switcher-item-check">✓</span>}
								</div>
							))}

							{worktreeList.length === 0 && !isLoading && (
								<div className="worktree-switcher-empty">暂无其他 worktree</div>
							)}
						</>
					)}
				</div>
			)}
		</div>
	);
}
