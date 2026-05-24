/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Todo List Card Component
 *
 *  Displays a checklist of tasks with completion tracking
 *  Mirrors VS Code's chatTodoListWidget.ts pattern
 *--------------------------------------------------------------------------------------------*/

import React, { memo, useState } from 'react';

export interface TodoItem {
	id: string;
	label: string;
	completed: boolean;
	description?: string;
	assignee?: string;
}

interface TodoListCardProps {
	todos: TodoItem[];
	title?: string;
	onToggle?: (id: string, completed: boolean) => void;
	onAdd?: (label: string) => void;
	readonly?: boolean;
}

export const TodoListCard = memo(function TodoListCard({
	todos,
	title = '任务清单',
	onToggle,
	onAdd,
	readonly = false,
}: TodoListCardProps): React.ReactElement {
	const [isExpanded, setIsExpanded] = useState(true);
	const [newTodo, setNewTodo] = useState('');

	const completedCount = todos.filter(t => t.completed).length;
	const totalCount = todos.length;

	const handleToggle = (id: string) => {
		const todo = todos.find(t => t.id === id);
		if (todo && onToggle) {
			onToggle(id, !todo.completed);
		}
	};

	const handleAdd = () => {
		if (newTodo.trim() && onAdd) {
			onAdd(newTodo.trim());
			setNewTodo('');
		}
	};

	if (totalCount === 0 && readonly) { return <></>; }

	return (
		<div className="todo-list-card">
			<div
				className="todo-header"
				onClick={() => setIsExpanded(!isExpanded)}
				role="button"
				aria-expanded={isExpanded}
			>
				<span className="todo-icon">☑️</span>
				<span className="todo-title">{title}</span>
				<span className="todo-progress">
					{completedCount}/{totalCount}
				</span>
				<span className={`todo-toggle ${isExpanded ? '' : 'collapsed'}`}>
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
						<polyline points="6 9 12 15 18 9" />
					</svg>
				</span>
			</div>
			{isExpanded && (
				<div className="todo-body">
					<div className="todo-list">
						{todos.map((todo) => (
							<div key={todo.id} className={`todo-item ${todo.completed ? 'completed' : ''}`}>
								<label className="todo-checkbox-label">
									<input
										type="checkbox"
										checked={todo.completed}
										onChange={() => handleToggle(todo.id)}
										disabled={readonly}
										className="todo-checkbox"
									/>
									<span className="todo-label">{todo.label}</span>
								</label>
								{todo.description && (
									<span className="todo-description">{todo.description}</span>
								)}
								{todo.assignee && (
									<span className="todo-assignee">👤 {todo.assignee}</span>
								)}
							</div>
						))}
					</div>
					{!readonly && (
						<div className="todo-add">
							<input
								type="text"
								value={newTodo}
								onChange={(e) => setNewTodo(e.target.value)}
								onKeyDown={(e) => { if (e.key === 'Enter') { handleAdd(); } }}
								placeholder="添加新任务..."
								className="todo-add-input"
							/>
							<button
								className="todo-add-btn"
								onClick={handleAdd}
								disabled={!newTodo.trim()}
							>
								+
							</button>
						</div>
					)}
				</div>
			)}
		</div>
	);
});
