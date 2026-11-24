/* @generated-workbench-directory:file hash=8cb59bb5077f */
export const TOOLS_WORKBENCHES = [
	{ name: '主页', desc: '会话遥测 / 用量与编排', route: '/x/dashboard/', provider: 'vssaros-dashboard' },
	{ name: '看板', desc: '看板存储与卡片工具', route: '/x/kanban/', provider: 'vssaros-kanban', offline: true },
	{ name: '知识库', desc: '知识库索引与检索', route: '/x/kb/', provider: 'vssaros-kb' },
	{ name: '代码库', desc: '代码图谱与符号检索', route: '/x/codebase/', provider: 'vssaros-codebase' },
	{ name: '历史会话', desc: '会话分组 / 人格标记 / 指示灯', route: '/x/sessions/', provider: 'vssaros-sessions' },
	{ name: '媒体库', desc: '只读 media.db 页面', route: '/x/media/', provider: 'vssaros-media' },
	{ name: '工具', desc: '技能 / 连接器 / 工作流 / Agent（本页）', route: '/x/skills/', provider: 'vssaros-skills', offline: true },
	{ name: 'MCP', desc: 'MCP 服务器与工具', route: '/x/mcp/', provider: 'vssaros-mcp' },
	{ name: '流程', desc: '工作流引擎与画布', route: '/x/workflow/', provider: 'vssaros-workflow', offline: true },
	{ name: 'Agent', desc: '.agent.md → dsh preset', route: '/x/agents/', provider: 'vssaros-agents' },
	{ name: '商城', desc: '技能 / 工作台 / 工作流的安装与发布', route: '/x/marketplace/', provider: 'vssaros-marketplace' },
];

export const VISIBLE_TOOLS_WORKBENCHES = TOOLS_WORKBENCHES.filter(w => !w.offline);
