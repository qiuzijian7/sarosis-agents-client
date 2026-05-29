/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Worktree Switcher
 *  Dropdown in chat header to switch worktree for current agent.
 *--------------------------------------------------------------------------------------------*/

import React, { useState, useRef, useEffect } from 'react';
import { useEmployeeStore } from '../../store/useEmployeeStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { sendRequest } from '../../bridge/messageClient';

interface WorktreeInfo {
	path: string;
	branch: string;
}

export function WorktreeSwitcher(): React.ReactElement | null {
	const { activeEmployeeId, employees, updateEmployee } = useEmployeeStore();
	const { activeWorkspaceId } = useWorkspaceStore();

	const [isOpen, setIsOpen] = useState(false);
	const [worktreeList, setWorktreeList] = useState<WorktreeInfo[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const dropdownRef = useRef<HTMLDivElement>(null);

	const activeEmployee = employees.find(e => e.id === activeEmployeeId);
	const currentWorktreePath = activeEmployee?.worktreePath;
	const currentWorktreeBranch = activeEmployee?.worktreeBranch;

	// Load worktree list when dropdown opens
	useEffect(() => {
		if (!isOpen || !activeWorkspaceId) { return; }

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
	}, [isOpen, activeWorkspaceId]);

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
		if (!activeEmployeeId) { return; }
		const selectedWt = worktreeList.find(wt => wt.path === path);
		await updateEmployee(activeEmployeeId, {
			worktreePath: path || undefined,
			worktreeBranch: selectedWt?.branch,
		});
		setIsOpen(false);
	};

	const handleClearWorktree = async () => {
		if (!activeEmployeeId) { return; }
		await updateEmployee(activeEmployeeId, {
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

	if (!activeEmployee) { return null; }

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
