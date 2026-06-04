/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Create Task Modal
 *  A lightweight form dialog for manually creating a board task (lands in the
 *  "待执行" / todo column). Triggered by the + button on the todo column header.
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useRef, useState } from 'react';

export interface CreateTaskFormData {
	title: string;
	description?: string;
	assigneeId?: string;
	assigneeName?: string;
	priority?: 'low' | 'medium' | 'high';
	/** Ids of tasks this task depends on (must complete first). */
	dependencies?: string[];
}

interface CreateTaskModalProps {
	isOpen: boolean;
	onClose: () => void;
	onCreate: (data: CreateTaskFormData) => void;
	/** Employee options for the assignee dropdown (id + name only are used). */
	employees: { id: string; name: string }[];
	/** All existing tasks, used to populate the dependency dropdown. */
	tasks: { id: string; title: string }[];
}

export function CreateTaskModal({ isOpen, onClose, onCreate, employees, tasks }: CreateTaskModalProps): React.ReactElement | null {
	const [title, setTitle] = useState('');
	const [description, setDescription] = useState('');
	const [assigneeId, setAssigneeId] = useState('');
	const [priority, setPriority] = useState<'low' | 'medium' | 'high'>('medium');
	const [dependencies, setDependencies] = useState<string[]>([]);
	const titleInputRef = useRef<HTMLInputElement>(null);

	// Reset form + focus the title field each time the modal opens.
	useEffect(() => {
		if (isOpen) {
			setTitle('');
			setDescription('');
			setAssigneeId('');
			setPriority('medium');
			setDependencies([]);
			// Defer focus until after the modal paints.
			setTimeout(() => titleInputRef.current?.focus(), 50);
		}
	}, [isOpen]);

	if (!isOpen) { return null; }

	const canSubmit = title.trim().length > 0;

	// Tasks not yet selected as a dependency (avoid duplicate selection).
	const availableDepTasks = tasks.filter(t => !dependencies.includes(t.id));
	const titleById = (id: string) => tasks.find(t => t.id === id)?.title ?? '';

	const addDependency = (id: string) => {
		if (id && !dependencies.includes(id)) {
			setDependencies(prev => [...prev, id]);
		}
	};
	const removeDependency = (id: string) => {
		setDependencies(prev => prev.filter(d => d !== id));
	};

	const submit = () => {
		if (!canSubmit) { return; }
		const emp = employees.find(e => e.id === assigneeId);
		onCreate({
			title: title.trim(),
			description: description.trim() || undefined,
			assigneeId: assigneeId || undefined,
			assigneeName: emp?.name || undefined,
			priority,
			dependencies: dependencies.length > 0 ? dependencies : undefined,
		});
		onClose();
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		// Cmd/Ctrl+Enter submits; Esc closes.
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			submit();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
		}
	};

	return (
		<div className="orch-modal-overlay" onClick={onClose}>
			<div
				className="create-task-modal"
				onClick={(e) => e.stopPropagation()}
				onKeyDown={handleKeyDown}
			>
				<div className="create-task-modal-header">
					<span className="create-task-modal-title">📋 创建任务</span>
					<button className="create-task-modal-close" onClick={onClose} title="关闭">✕</button>
				</div>

				<div className="create-task-modal-body">
					<label className="create-task-field">
						<span className="create-task-field-label">任务标题<span className="create-task-required">*</span></span>
						<input
							ref={titleInputRef}
							className="create-task-input"
							value={title}
							onChange={e => setTitle(e.target.value)}
							placeholder="简要描述这个任务"
						/>
					</label>

					<label className="create-task-field">
						<span className="create-task-field-label">任务描述</span>
						<textarea
							className="create-task-textarea"
							value={description}
							onChange={e => setDescription(e.target.value)}
							placeholder="补充细节、验收标准等（可选）"
							rows={4}
						/>
					</label>

					<div className="create-task-field-row">
						<label className="create-task-field">
							<span className="create-task-field-label">负责员工</span>
							<select
								className="create-task-select"
								value={assigneeId}
								onChange={e => setAssigneeId(e.target.value)}
							>
								<option value="">未指派</option>
								{employees.map(emp => (
									<option key={emp.id} value={emp.id}>{emp.name}</option>
								))}
							</select>
						</label>

						<label className="create-task-field">
							<span className="create-task-field-label">优先级</span>
							<select
								className="create-task-select"
								value={priority}
								onChange={e => setPriority(e.target.value as 'low' | 'medium' | 'high')}
							>
								<option value="low">低</option>
								<option value="medium">中</option>
								<option value="high">高</option>
							</select>
						</label>
					</div>

					<label className="create-task-field">
						<span className="create-task-field-label">依赖任务</span>
						<select
							className="create-task-select"
							value=""
							onChange={e => { addDependency(e.target.value); e.target.value = ''; }}
						>
							<option value="">{availableDepTasks.length > 0 ? '选择需要先完成的任务…' : '无可选任务'}</option>
							{availableDepTasks.map(t => (
								<option key={t.id} value={t.id}>
									{t.title ? `${t.title}（${t.id}）` : t.id}
								</option>
							))}
						</select>
						{dependencies.length > 0 && (
							<div className="create-task-dep-chips">
								{dependencies.map(id => (
									<span key={id} className="create-task-dep-chip" title={id}>
										<span className="create-task-dep-chip-label">{titleById(id) || id}</span>
										<button
											type="button"
											className="create-task-dep-chip-remove"
											onClick={() => removeDependency(id)}
											title="移除依赖"
										>
											✕
										</button>
									</span>
								))}
							</div>
						)}
					</label>
				</div>

				<div className="create-task-modal-footer">
					<button className="create-task-btn-cancel" onClick={onClose}>取消</button>
					<button className="create-task-btn-submit" onClick={submit} disabled={!canSubmit}>
						创建
					</button>
				</div>
			</div>
		</div>
	);
}
