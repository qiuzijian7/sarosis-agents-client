/*---------------------------------------------------------------------------------------------
 *  TaskProgressPanel — 画布右上角任务进度面板（ComfyUI Queue 风格）。
 *
 *  悬浮按钮 + 展开式任务列表，统一展示三类长任务：
 *    - install   ComfyUI 安装 / 依赖准备
 *    - download  模型下载
 *    - generate  出图（单节点 / 全图）
 *
 *  数据源是 taskStore 单例（comfyHost/taskStore.ts），出图进度由执行管道实时写入，
 *  安装/下载进度由主进程执行 + webview 轮询（comfy.getTaskProgress）回填。
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { useTasks, useActiveTaskCount, taskTypeLabel, getTaskStore, type TaskItem, type TaskStatus, type TaskType } from './comfyHost/taskStore';

const TYPE_COLOR: Record<TaskType, string> = {
	install: '#3b82f6',
	download: '#eab308',
	generate: '#22c55e',
};

const STATUS_COLOR: Record<TaskStatus, string> = {
	queued: 'var(--vscode-descriptionForeground)',
	running: '#3b82f6',
	success: '#22c55e',
	error: '#ef4444',
};

const STATUS_LABEL: Record<TaskStatus, string> = {
	queued: '排队中',
	running: '进行中',
	success: '完成',
	error: '失败',
};

function progressText(t: TaskItem): string {
	if (t.status === 'success') { return '100%'; }
	if (t.progress < 0) { return '…'; }
	return `${Math.round(t.progress)}%`;
}

function TaskRow({ task }: { task: TaskItem }): React.JSX.Element {
	const color = TYPE_COLOR[task.type];
	const indeterminate = task.status === 'running' && task.progress < 0;
	return (
		<div style={{
			display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
			borderRadius: 6, fontSize: 11,
			background: 'var(--vscode-editor-background, transparent)',
		}}>
			<span style={{
				flexShrink: 0, padding: '0 5px', borderRadius: 3, fontSize: 9,
				border: `1px solid ${color}`, color,
				whiteSpace: 'nowrap', lineHeight: '16px',
			}}>
				{taskTypeLabel(task.type)}
			</span>
			<div style={{ flex: 1, minWidth: 0 }}>
				<div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
					<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.label}</span>
					<span style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
						<span style={{ fontSize: 10, color: STATUS_COLOR[task.status] }}>
							{STATUS_LABEL[task.status]} {progressText(task)}
						</span>
						{/* ★ 行内取消（2026-09-02）：运行中/排队中且关联了画布节点 →
						    调 abortNodeRun(nodeId) 中止运行（与卡片「取消」同链路：
						    controller.abort → executor signal 检查 → canceled）。
						    动态 import 避免与 WorkflowEditorPanel 循环依赖。 */}
						{(task.status === 'running' || task.status === 'queued') && task.nodeId && (
							<button
								type="button"
								title="取消此任务"
								onClick={() => {
									import('./WorkflowEditorPanel').then(({ abortNodeRun }) => {
										if (task.nodeId) { abortNodeRun(task.nodeId); }
									}).catch(() => { /* ignore */ });
								}}
								style={{
									flexShrink: 0, width: 16, height: 16, lineHeight: '14px',
									padding: 0, borderRadius: 4, cursor: 'pointer', fontSize: 10,
									border: '1px solid var(--vscode-panel-border)', background: 'transparent',
									color: 'var(--vscode-descriptionForeground)',
								}}
							>
								✕
							</button>
						)}
					</span>
				</div>
				{task.message && (
					<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
						{task.message}
					</div>
				)}
				<div style={{ height: 3, marginTop: 3, borderRadius: 2, background: 'var(--vscode-progressBar-background, rgba(255,255,255,.12))', overflow: 'hidden' }}>
					<div style={{
						height: '100%', width: indeterminate ? '40%' : `${Math.max(0, Math.min(100, task.progress < 0 ? 0 : task.progress))}%`,
						background: task.status === 'error' ? '#ef4444' : color,
						transition: 'width .3s ease',
						...(indeterminate ? { animation: 'saros-task-indeterminate 1.2s ease-in-out infinite' } : {}),
					}} />
				</div>
			</div>
		</div>
	);
}

export function TaskProgressPanel(): React.JSX.Element | null {
	const tasks = useTasks();
	const activeCount = useActiveTaskCount();
	const [open, setOpen] = React.useState(false);
	// 根容器同时包含悬浮按钮 + 展开列表，点击 rootRef 外即关闭（按钮本身在 rootRef 内，不受影响）
	const rootRef = React.useRef<HTMLDivElement>(null);

	// ★ 点击任务进度面板外部 → 自动关闭（对齐下拉菜单/浮层交互惯例）。
	React.useEffect(() => {
		if (!open) { return; }
		const onPointerDown = (ev: PointerEvent) => {
			const target = ev.target as Node | null;
			if (target && rootRef.current?.contains(target)) { return; }
			setOpen(false);
		};
		// ★ capture 阶段：画布/节点层的 pointerdown 会被 stopPropagation，bubble 阶段
		//   收不到 → 点击画布空白/节点不关闭。capture 阶段先于 LiteGraph 触发，必能收到。
		document.addEventListener('pointerdown', onPointerDown, true);
		return () => document.removeEventListener('pointerdown', onPointerDown, true);
	}, [open]);

	// 无任何任务时隐藏整个面板（不打扰）。
	if (tasks.length === 0) { return null; }

	return (
		<div ref={rootRef} style={{ position: 'relative', pointerEvents: 'auto' }}>
			{/* 悬浮按钮 */}
			<button
				type="button"
				onClick={() => setOpen(o => !o)}
				title="任务进度"
				style={{
					display: 'flex', alignItems: 'center', gap: 5, padding: '5px 9px',
					borderRadius: 6, fontSize: 11, cursor: 'pointer',
					border: '1px solid var(--vscode-panel-border)',
					background: 'var(--vscode-button-secondaryBackground, rgba(255,255,255,.08))',
					color: 'var(--vscode-foreground)',
				}}
			>
				<span style={{ fontSize: 12, lineHeight: 1 }}>{activeCount > 0 ? '◔' : '✓'}</span>
				<span>任务</span>
				{activeCount > 0 && (
					<span style={{
						minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8, fontSize: 10,
						background: '#3b82f6', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
					}}>
						{activeCount}
					</span>
				)}
			</button>

			{/* 展开列表 */}
			{open && (
				<div style={{
					position: 'absolute', top: 'calc(100% + 6px)', right: 0, width: 300, maxHeight: 360,
					overflowY: 'auto', borderRadius: 8, padding: 6,
					border: '1px solid var(--vscode-panel-border)',
					background: 'var(--vscode-editorWidget-background, var(--vscode-sideBar-background, #1e1e1e))',
					boxShadow: '0 8px 24px rgba(0,0,0,.4)',
					zIndex: 1000,
				}}>
					<div style={{
						display: 'flex', alignItems: 'center', justifyContent: 'space-between',
						padding: '4px 6px 6px', fontSize: 11, fontWeight: 600,
						color: 'var(--vscode-descriptionForeground)',
					}}>
						<span>任务进度</span>
						<button
							type="button"
							onClick={() => { getTaskStore().clearFinished(); }}
							title="清除已完成"
							style={{
								fontSize: 10, padding: '1px 6px', borderRadius: 4, cursor: 'pointer',
								border: '1px solid var(--vscode-panel-border)', background: 'transparent',
								color: 'var(--vscode-foreground)',
							}}
						>
							清除已完成
						</button>
					</div>
					<div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
						{tasks.map(t => <TaskRow key={t.id} task={t} />)}
					</div>
				</div>
			)}
		</div>
	);
}
