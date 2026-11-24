/* @generated-workbench-directory:file hash=8cb59bb5077f */
export const OFFLINE_WORKBENCH_ROUTES = ['/x/kanban/', '/x/workflow/', '/x/imagegen/', '/x/skills/'];

export const WORKBENCH_MODULES = [
	{ route: '/x/dashboard/', name: '主页', desc: '会话遥测 / 用量与编排', icon: '🏠', alwaysPinned: true },
	{ route: '/x/kanban/', name: '看板', desc: '看板存储与卡片工具', icon: '🗂', offline: true },
	{ route: '/x/kb/', name: '知识库', desc: '知识库索引与检索', icon: '📚' },
	{ route: '/x/memory/', name: '记忆', desc: '分层记忆 / 待确认建议 / 工作区作用域（会话页记忆 Tab 同源）', icon: '🧠' },
	{ route: '/x/codebase/', name: '代码库', desc: '代码图谱与符号检索', icon: '🕸' },
	{ route: '/x/media/', name: '媒体库', desc: '只读 media.db 页面', icon: '🎬' },
	{ route: '/x/imagegen/', name: '生图', desc: '生图工作台 / 最近出图画廊', icon: '🎨', offline: true },
	{ route: '/x/skills/', name: '工具', desc: '技能、工具、mcp、agent、工作流、工作台', icon: '🧩', offline: true },
	{ route: '/x/workflow/', name: '流程', desc: '工作流引擎与画布', icon: '⚙', offline: true },
	{ route: '/x/marketplace/', name: '商城', desc: 'Agent / Skill / 工作台 / 工作流的安装与发布', icon: '🛒' },
	{ route: '/x/sessions/', name: '历史会话', desc: '会话分组 / 人格标记 / 指示灯', icon: '🕘' },
	{ route: '/x/scheduler/', name: '自动化任务', desc: '按计划自动运行 Agent；原生任务页（搜索 / 筛选 / 详情 / 投递历史）', icon: '⏰' },
];

export const VISIBLE_WORKBENCH_MODULES = WORKBENCH_MODULES.filter(m => !m.offline);
