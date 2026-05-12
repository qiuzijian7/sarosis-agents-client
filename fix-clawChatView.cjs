const fs = require('fs');
const path = require('path');

const filePath = 'g:/CustomWorkspaces/AIProjects/sarosis-agents-client/src/vs/sessions/contrib/agentStudio/browser/views/clawChatView.ts';

let content = fs.readFileSync(filePath, 'utf8');

// 替换变量声明和使用
content = content.replace(/this\.providerLabel\b/g, 'this._providerLabel');
content = content.replace(/this\.modelLabel\b/g, 'this._modelLabel');

// 替换变量声明（private 属性）
content = content.replace(/private providerLabel\b/g, 'private _providerLabel');
content = content.replace(/private modelLabel\b/g, 'private _modelLabel');

fs.writeFileSync(filePath, content, 'utf8');
console.log('Fixed clawChatView.ts');
