const fs = require('fs');
const path = 'g:/CustomWorkspaces/AIProjects/sarosis-agents-client/src/vs/sessions/contrib/agentStudio/browser/providers/tool/kanbanTools.ts';
let content = fs.readFileSync(path, 'utf8');

// Replace this._resolveKanbanTaskId(taskId, agentId) → _resolveKanbanTaskId(ctx, taskId, agentId)
content = content.replace(/ctx\._resolveKanbanTaskId\(/g, '_resolveKanbanTaskId(ctx, ');

// Replace this._resolveKanbanWorkspaceId(agentId) → _resolveKanbanWorkspaceId(ctx, agentId)
content = content.replace(/ctx\._resolveKanbanWorkspaceId\(/g, '_resolveKanbanWorkspaceId(ctx, ');

// Fix source: this.id → 'saros.builtin-tools'
content = content.replace(/source:\s*ctx\.id/g, "source: 'saros.builtin-tools'");

// Fix args: Record<string, unknown>
content = content.replace(/handler:\s*async\s+args\s*=>/g, 'handler: async (args: Record<string, unknown>) =>');

fs.writeFileSync(path, content, 'utf8');
console.log('Fixed kanbanTools.ts references');
