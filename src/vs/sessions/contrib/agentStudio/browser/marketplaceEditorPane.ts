/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { clearNode } from '../../../../base/browser/dom.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { MarketplaceEditorInput } from './marketplaceEditorInput.js';
import { IMarketplaceService, PackageKind, IMarketplacePackage, IMarketplacePackageDetail } from '../common/marketplace.js';
import { ICodebaseMemoryMcpService } from './codebaseMemoryMcpService.js';

const KIND_LABEL: Record<PackageKind, string> = {
	skill: 'Skill',
	agent: 'Agent',
	mcp: 'MCP',
	knowledge: '知识库',
};

const KIND_ICON: Record<PackageKind, string> = {
	skill: '\u{1F4C4}',
	agent: '\u{1F916}',
	mcp: '\u{1F50C}',
	knowledge: '\u{1F4DA}',
};

/** Inline CSS — matches mockup integration-marketplace-mockup.html */
const CSS_TEXT = `
.mp-page{height:100%;display:flex;flex-direction:column;background:var(--vscode-editor-background,#1e1e1e);color:var(--vscode-editor-foreground,#ccc);font-size:13px;font-family:'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;}
.mp-header{padding:14px 24px 12px;border-bottom:1px solid var(--vscode-panel-border,#3c3c3c);background:var(--vscode-sideBar-background,#252526);flex-shrink:0;}
.mp-title-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}
.mp-title-row h1{font-size:17px;font-weight:600;margin:0;display:flex;align-items:center;gap:8px;}
.mp-user{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--vscode-descriptionForeground,#9d9d9d);}
.mp-user .avatar{width:24px;height:24px;border-radius:50%;background:var(--vscode-button-background,#007acc);display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:600;}
.mp-toolbar{display:flex;gap:8px;align-items:center;}
.mp-search{flex:1;display:flex;align-items:center;gap:8px;background:var(--vscode-input-background,#1e1e1e);border:1px solid var(--vscode-input-border,#3c3c3c);border-radius:4px;padding:5px 10px;}
.mp-search:focus-within{border-color:var(--vscode-focusBorder,#007acc);}
.mp-search input{flex:1;background:none;border:none;outline:none;color:var(--vscode-input-foreground,#ccc);font-size:13px;}
.mp-search input::placeholder{color:var(--vscode-input-placeholderForeground,#6e6e6e);}
.mp-cats{display:flex;gap:4px;flex-wrap:wrap;}
.mp-cat{padding:4px 12px;border:1px solid var(--vscode-panel-border,#3c3c3c);border-radius:14px;font-size:12px;cursor:pointer;color:var(--vscode-descriptionForeground,#9d9d9d);background:var(--vscode-editor-background,#1e1e1e);transition:.15s;}
.mp-cat:hover{border-color:var(--vscode-button-background,#007acc);color:var(--vscode-editor-foreground,#ccc);}
.mp-cat.active{background:var(--vscode-button-background,#007acc);color:var(--vscode-button-foreground,#fff);border-color:var(--vscode-button-background,#007acc);}
.mp-grid-scroll{flex:1;overflow-y:auto;}
.mp-grid-scroll::-webkit-scrollbar{width:8px;}
.mp-grid-scroll::-webkit-scrollbar-track{background:var(--vscode-editor-background,#1e1e1e);}
.mp-grid-scroll::-webkit-scrollbar-thumb{background:var(--vscode-panel-border,#3c3c3c);border-radius:4px;}
.mp-grid{padding:16px 24px;}
.mp-section-title{font-size:13px;font-weight:600;color:var(--vscode-editor-foreground,#ccc);margin-bottom:10px;display:flex;align-items:center;gap:6px;}
.mp-section-title .count{font-size:11px;color:var(--vscode-descriptionForeground,#9d9d9d);font-weight:400;}
.mp-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;}
.mp-card{background:var(--vscode-sideBar-background,#252526);border:1px solid var(--vscode-panel-border,#3c3c3c);border-radius:6px;padding:14px;transition:.15s;cursor:pointer;}
.mp-card:hover{border-color:var(--vscode-button-background,#007acc);background:var(--vscode-list-hoverBackground,#2a2d2e);transform:translateY(-1px);}
.card-top{display:flex;align-items:flex-start;gap:10px;margin-bottom:6px;}
.card-icon{font-size:24px;flex-shrink:0;}
.card-info{flex:1;min-width:0;}
.card-name{font-size:13px;font-weight:600;color:var(--vscode-editor-foreground,#ccc);margin-bottom:2px;}
.card-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap;}
.card-ver{font-size:10px;color:var(--vscode-textLink-foreground,#569cd6);font-family:monospace;}
.card-author{font-size:10px;color:var(--vscode-descriptionForeground,#9d9d9d);}
.card-desc{font-size:12px;color:var(--vscode-descriptionForeground,#9d9d9d);line-height:1.5;margin-bottom:10px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
.card-footer{display:flex;align-items:center;justify-content:space-between;}
.card-stats{font-size:10px;color:var(--vscode-descriptionForeground,#9d9d9d);display:flex;gap:8px;}
.card-badge{font-size:9px;padding:2px 7px;border-radius:3px;font-weight:600;}
.badge-skill{background:rgba(86,156,214,.2);color:var(--vscode-textLink-foreground,#569cd6);}
.badge-agent{background:rgba(78,201,176,.15);color:#4ec9b0;}
.badge-mcp{background:rgba(206,145,120,.15);color:#ce9178;}
.badge-kb{background:rgba(197,134,192,.15);color:#c586c0;}
.install-btn{padding:4px 14px;background:var(--vscode-button-background,#007acc);color:var(--vscode-button-foreground,#fff);border:none;border-radius:3px;cursor:pointer;font-size:12px;font-weight:500;transition:.15s;}
.install-btn:hover{background:var(--vscode-button-hoverBackground,#1f8ad2);}
.install-btn.installed{background:#4ec9b0;cursor:default;}
.mp-pagination{display:flex;justify-content:center;gap:6px;padding:14px 0;border-top:1px solid var(--vscode-panel-border,#3c3c3c);margin-top:12px;}
.mp-page-btn{padding:4px 12px;border:1px solid var(--vscode-panel-border,#3c3c3c);background:var(--vscode-sideBar-background,#252526);color:var(--vscode-descriptionForeground,#9d9d9d);border-radius:3px;cursor:pointer;font-size:12px;}
.mp-page-btn:hover{border-color:var(--vscode-button-background,#007acc);color:var(--vscode-editor-foreground,#ccc);}
.mp-page-btn.active{background:var(--vscode-button-background,#007acc);color:var(--vscode-button-foreground,#fff);border-color:var(--vscode-button-background,#007acc);}
.mp-page-btn:disabled{opacity:.4;cursor:default;}
.mp-detail{display:none;position:absolute;inset:0;background:var(--vscode-editor-background,#1e1e1e);z-index:100;flex-direction:column;}
.mp-detail.show{display:flex;}
.md-back{padding:10px 24px;border-bottom:1px solid var(--vscode-panel-border,#3c3c3c);display:flex;align-items:center;gap:8px;cursor:pointer;color:var(--vscode-descriptionForeground,#9d9d9d);font-size:13px;flex-shrink:0;}
.md-back:hover{color:var(--vscode-editor-foreground,#ccc);}
.md-content{flex:1;overflow-y:auto;padding:20px 24px;}
.md-content h2{font-size:18px;margin-bottom:6px;display:flex;align-items:center;gap:8px;}
.md-meta{display:flex;gap:10px;font-size:12px;color:var(--vscode-descriptionForeground,#9d9d9d);margin-bottom:14px;flex-wrap:wrap;align-items:center;}
.md-desc{font-size:13px;color:var(--vscode-descriptionForeground,#9d9d9d);line-height:1.7;margin-bottom:16px;padding:14px;background:var(--vscode-sideBar-background,#252526);border-radius:6px;border:1px solid var(--vscode-panel-border,#3c3c3c);}
.md-versions{margin-bottom:16px;}
.md-versions h3{font-size:13px;margin-bottom:6px;}
.ver-item{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border:1px solid var(--vscode-panel-border,#3c3c3c);border-radius:4px;margin-bottom:5px;}
.ver-item.latest{border-color:#4ec9b0;}
.md-install-bar{padding:14px 0;border-top:1px solid var(--vscode-panel-border,#3c3c3c);display:flex;gap:8px;align-items:center;}
.install-overlay{display:none;position:absolute;inset:0;background:rgba(0,0,0,.5);z-index:200;align-items:center;justify-content:center;}
.install-overlay.show{display:flex;}
.install-dialog{background:var(--vscode-sideBar-background,#252526);border:1px solid var(--vscode-panel-border,#3c3c3c);border-radius:8px;width:400px;max-width:90%;box-shadow:0 8px 32px rgba(0,0,0,.4);overflow:hidden;}
.id-head{padding:12px 18px;border-bottom:1px solid var(--vscode-panel-border,#3c3c3c);font-weight:600;font-size:14px;display:flex;align-items:center;justify-content:space-between;}
.id-body{padding:16px 18px;}
.id-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(60,60,60,.3);}
.id-row:last-child{border-bottom:none;}
.id-label{font-size:12px;color:var(--vscode-descriptionForeground,#9d9d9d);}
.id-val{font-size:13px;color:var(--vscode-editor-foreground,#ccc);}
.id-progress{margin:14px 0;}
.id-bar{height:5px;background:var(--vscode-editorWidget-background,#2d2d2d);border-radius:3px;overflow:hidden;}
.id-fill{height:100%;background:var(--vscode-button-background,#007acc);border-radius:3px;transition:width .5s;width:0;}
.id-steps{font-size:11px;color:var(--vscode-descriptionForeground,#9d9d9d);margin-top:6px;}
.id-step{padding:2px 0;display:flex;align-items:center;gap:5px;}
.id-step.done{color:#4ec9b0;}
.id-step.done::before{content:'\u2713';color:#4ec9b0;}
.id-step.pending::before{content:'\u25CB';color:var(--vscode-descriptionForeground,#9d9d9d);}
.id-step.active::before{content:'\u25CF';color:var(--vscode-button-background,#007acc);}
.id-actions{padding:12px 18px;border-top:1px solid var(--vscode-panel-border,#3c3c3c);display:flex;justify-content:flex-end;gap:8px;}
.id-btn{padding:5px 14px;border-radius:4px;cursor:pointer;font-size:13px;border:1px solid var(--vscode-panel-border,#3c3c3c);background:var(--vscode-editorWidget-background,#2d2d2d);color:var(--vscode-descriptionForeground,#9d9d9d);}
.id-btn:hover{border-color:var(--vscode-button-background,#007acc);}
.id-btn.primary{background:var(--vscode-button-background,#007acc);color:var(--vscode-button-foreground,#fff);border-color:var(--vscode-button-background,#007acc);}
.mp-empty{text-align:center;padding:40px;color:var(--vscode-descriptionForeground,#9d9d9d);}
`;

/** Mock data — used as fallback when marketplace API is unreachable. Matches mockup. */
const MOCK_PACKAGES: IMarketplacePackage[] = [
	{ id: '1', kind: 'skill', slug: 'pdf-skill', name: 'PDF Skill', icon: '\u{1F4C4}', description: '\u5904\u7406 PDF \u6587\u4EF6\u7684\u6280\u80FD\u3002\u652F\u6301\u63D0\u53D6\u6587\u672C\u3001\u8868\u683C\u3001\u56FE\u7247\uFF0C\u4EE5\u53CA PDF \u8F6C Markdown\u3002', visibility: 'public', tags: ['pdf', 'document'], latestVersion: '1.0.0', downloads: 128 },
	{ id: '2', kind: 'skill', slug: 'code-review', name: 'Code Review', icon: '\u{1F50D}', description: '\u4EE3\u7801\u5BA1\u67E5\u6280\u80FD\uFF0C\u81EA\u52A8\u68C0\u67E5\u4EE3\u7801\u8D28\u91CF\u3001\u5B89\u5168\u6F0F\u6D1E\u3001\u6700\u4F73\u5B9E\u8DF5\u3002', visibility: 'public', tags: ['review', 'code'], latestVersion: '1.0.0', downloads: 96 },
	{ id: '3', kind: 'agent', slug: 'deep-researcher', name: 'Deep Researcher', icon: '\u{1F916}', description: '\u6DF1\u5EA6\u7814\u7A76 Agent\uFF0C\u652F\u6301\u7F51\u7EDC\u641C\u7D22\u3001\u4FE1\u606F\u6574\u5408\u3001\u62A5\u544A\u751F\u6210\u3002', visibility: 'public', tags: ['research', 'search'], latestVersion: '1.1.0', downloads: 256 },
	{ id: '4', kind: 'agent', slug: 'code-architect', name: 'Code Architect', icon: '\u{1F3D7}\uFE0F', description: '\u4EE3\u7801\u67B6\u6784\u5E08 Agent\uFF0C\u8F85\u52A9\u7CFB\u7EDF\u8BBE\u8BA1\u3001\u67B6\u6784\u51B3\u7B56\u3001\u6280\u672F\u9009\u578B\u3002', visibility: 'public', tags: ['architecture'], latestVersion: '1.0.0', downloads: 88 },
	{ id: '5', kind: 'mcp', slug: 'filesystem-mcp', name: 'Filesystem MCP', icon: '\u{1F4C1}', description: '\u6587\u4EF6\u7CFB\u7EDF\u8BBF\u95EE MCP \u670D\u52A1\u5668\uFF0C\u63D0\u4F9B\u6587\u4EF6\u8BFB\u5199\u3001\u76EE\u5F55\u904D\u5386\u529F\u80FD\u3002', visibility: 'public', tags: ['filesystem'], latestVersion: '0.5.0', downloads: 64 },
	{ id: '6', kind: 'mcp', slug: 'fetch-mcp', name: 'Fetch MCP', icon: '\u{1F310}', description: '\u7F51\u7EDC\u8BF7\u6C42 MCP \u670D\u52A1\u5668\uFF0C\u652F\u6301 HTTP/HTTPS \u8BF7\u6C42\u3001\u7F51\u9875\u6293\u53D6\u3002', visibility: 'public', tags: ['fetch', 'http'], latestVersion: '0.4.0', downloads: 42 },
	{ id: '9', kind: 'mcp', slug: 'codebase-memory-mcp', name: 'Codebase Memory', icon: '\u{1F9E0}', description: '\u4EE3\u7801\u667A\u80FD\u5F15\u64CE\uFF1A\u5C06\u4ED3\u5E93\u7D22\u5F15\u4E3A\u51FD\u6570/\u7C7B/\u8C03\u7528\u94FE/\u8DE8\u670D\u52A1\u94FE\u63A5\u7684\u77E5\u8BC6\u56FE\u8C31\uFF0C\u63D0\u4F9B 14 \u4E2A\u7ED3\u6784\u5316\u67E5\u8BE2 MCP \u5DE5\u5177\u3002', visibility: 'public', tags: ['code', 'graph'], latestVersion: '1.0.0', downloads: 156 },
	{ id: '10', kind: 'mcp', slug: 'github-mcp', name: 'GitHub MCP', icon: '\u{1F4C4}', description: 'GitHub API \u670D\u52A1\u5668\uFF0C\u63D0\u4F9B\u4ED3\u5E93\u3001Issue\u3001PR\u3001Action \u7B49 GitHub \u8D44\u6E90\u8BBF\u95EE\u80FD\u529B\u3002', visibility: 'public', tags: ['github', 'git'], latestVersion: '1.0.0', downloads: 320 },
	{ id: '11', kind: 'mcp', slug: 'gitlab-mcp', name: 'GitLab MCP', icon: '\u{1F98A}', description: 'GitLab API \u670D\u52A1\u5668\uFF0C\u63D0\u4F9B\u9879\u76EE\u3001Issue\u3001MR \u7B49 GitLab \u8D44\u6E90\u8BBF\u95EE\u80FD\u529B\u3002', visibility: 'public', tags: ['gitlab', 'git'], latestVersion: '1.0.0', downloads: 88 },
	{ id: '12', kind: 'mcp', slug: 'postgres-mcp', name: 'PostgreSQL MCP', icon: '\u{1F4BE}', description: 'PostgreSQL \u6570\u636E\u5E93\u670D\u52A1\u5668\uFF0C\u63D0\u4F9B\u53EA\u8BFB\u67E5\u8BE2\u4E0E Schema \u68C0\u67E5\u80FD\u529B\u3002', visibility: 'public', tags: ['database', 'postgres'], latestVersion: '1.0.0', downloads: 72 },
	{ id: '13', kind: 'mcp', slug: 'sqlite-mcp', name: 'SQLite MCP', icon: '\u{1F5C3}\uFE0F', description: 'SQLite \u6570\u636E\u5E93\u670D\u52A1\u5668\uFF0C\u63D0\u4F9B\u67E5\u8BE2\u4E0E Schema \u68C0\u67E5\u80FD\u529B\u3002', visibility: 'public', tags: ['database', 'sqlite'], latestVersion: '1.0.0', downloads: 54 },
	{ id: '14', kind: 'mcp', slug: 'brave-search-mcp', name: 'Brave Search MCP', icon: '\u{1F50E}', description: 'Brave Search API \u670D\u52A1\u5668\uFF0C\u63D0\u4F9B\u7F51\u9875\u641C\u7D22\u80FD\u529B\u3002', visibility: 'public', tags: ['search', 'web'], latestVersion: '1.0.0', downloads: 110 },
	{ id: '15', kind: 'mcp', slug: 'puppeteer-mcp', name: 'Puppeteer MCP', icon: '\u{1F5BC}\uFE0F', description: 'Puppeteer \u6D4F\u89C8\u5668\u81EA\u52A8\u5316\u670D\u52A1\u5668\uFF0C\u63D0\u4F9B\u7F51\u9875\u6293\u53D6\u3001\u8868\u5355\u586B\u5199\u3001\u622A\u56FE\u7B49\u80FD\u529B\u3002', visibility: 'public', tags: ['browser', 'automation'], latestVersion: '1.0.0', downloads: 198 },
	{ id: '16', kind: 'mcp', slug: 'memory-mcp', name: 'Memory MCP', icon: '\u{1F4DD}', description: '\u57FA\u4E8E\u77E5\u8BC6\u56FE\u8C31\u7684\u6301\u4E45\u5316\u8BB0\u5FC6\u7CFB\u7EDF\uFF0C\u5141\u8BB8 Agent \u5B58\u50A8\u548C\u68C0\u7D22\u7ED3\u6784\u5316\u8BB0\u5FC6\u3002', visibility: 'public', tags: ['memory', 'ai'], latestVersion: '1.0.0', downloads: 142 },
	{ id: '17', kind: 'mcp', slug: 'sequential-thinking-mcp', name: 'Sequential Thinking MCP', icon: '\u{1F9E9}', description: '\u7ED3\u6784\u5316\u601D\u7EF4\u670D\u52A1\u5668\uFF0C\u901A\u8FC7\u6B65\u9AA4\u5316\u601D\u8003\u8FC7\u7A0B\u89E3\u51B3\u590D\u6742\u95EE\u9898\u3002', visibility: 'public', tags: ['thinking', 'ai'], latestVersion: '1.0.0', downloads: 76 },
	{ id: '18', kind: 'mcp', slug: 'time-mcp', name: 'Time MCP', icon: '\u{23F1}\uFE0F', description: '\u65F6\u95F4\u4E0E\u65F6\u533A\u8F6C\u6362\u5DE5\u5177\u670D\u52A1\u5668\uFF0C\u63D0\u4F9B\u65F6\u95F4\u67E5\u8BE2\u4E0E\u65F6\u533A\u8F6C\u6362\u80FD\u529B\u3002', visibility: 'public', tags: ['time', 'timezone'], latestVersion: '1.0.0', downloads: 38 },
	{ id: '19', kind: 'mcp', slug: 'notion-mcp', name: 'Notion MCP', icon: '\u{1F4D1}', description: 'Notion \u5DE5\u4F5C\u533A\u670D\u52A1\u5668\uFF0C\u63D0\u4F9B\u9875\u9762\u3001\u6570\u636E\u5E93\u3001\u5185\u5BB9\u8BBF\u95EE\u80FD\u529B\u3002', visibility: 'public', tags: ['notion', 'productivity'], latestVersion: '1.0.0', downloads: 164 },
	{ id: '20', kind: 'mcp', slug: 'slack-mcp', name: 'Slack MCP', icon: '\u{1F4AC}', description: 'Slack \u5DE5\u4F5C\u533A\u670D\u52A1\u5668\uFF0C\u63D0\u4F9B\u9891\u9053\u3001\u6D88\u606F\u3001\u7528\u6237\u8BBF\u95EE\u80FD\u529B\u3002', visibility: 'public', tags: ['slack', 'productivity'], latestVersion: '1.0.0', downloads: 92 },
	{ id: '21', kind: 'mcp', slug: 'google-drive-mcp', name: 'Google Drive MCP', icon: '\u{1F4C2}', description: 'Google Drive \u670D\u52A1\u5668\uFF0C\u63D0\u4F9B\u6587\u4EF6\u8BBF\u95EE\u4E0E\u641C\u7D22\u80FD\u529B\u3002', visibility: 'public', tags: ['gdrive', 'productivity'], latestVersion: '1.0.0', downloads: 58 },
	{ id: '22', kind: 'mcp', slug: 'codex-mcp', name: 'Codex MCP', icon: '\u{1F4BB}', description: 'OpenAI Codex \u670D\u52A1\u5668\uFF0C\u63D0\u4F9B\u4EE3\u7801\u751F\u6210\u80FD\u529B\u3002', visibility: 'public', tags: ['codex', 'ai'], latestVersion: '1.0.0', downloads: 104 },
	{ id: '23', kind: 'mcp', slug: 'mcp-everything', name: 'MCP Everything', icon: '\u{1F9F0}', description: 'MCP \u6D4B\u8BD5\u670D\u52A1\u5668\uFF0C\u5305\u542B\u6240\u6709 MCP \u529F\u80FD\uFF08\u5DE5\u5177\u3001\u8D44\u6E90\u3001\u63D0\u793A\u3001\u91C7\u6837\uFF09\uFF0C\u7528\u4E8E\u6D4B\u8BD5\u4E0E\u6F14\u793A\u3002', visibility: 'public', tags: ['test', 'demo'], latestVersion: '1.0.0', downloads: 24 },
	{ id: '7', kind: 'knowledge', slug: 'sarosis-handbook', name: 'Sarosis \u4F7F\u7528\u624B\u518C', icon: '\u{1F4DA}', description: 'vsSarosis \u5B8C\u6574\u4F7F\u7528\u624B\u518C\uFF0C\u542B\u914D\u7F6E\u6307\u5357\u3001\u6700\u4F73\u5B9E\u8DF5\u3001FAQ\u3002', visibility: 'public', tags: ['docs', 'guide'], latestVersion: '2026.06', downloads: 32 },
	{ id: '8', kind: 'knowledge', slug: 'vscode-dev', name: 'VSCode \u6269\u5C55\u5F00\u53D1\u6307\u5357', icon: '\u{1F4D6}', description: 'VSCode \u6269\u5C55 API \u53C2\u8003\u3001\u8C03\u8BD5\u6280\u5DE7\u3001\u53D1\u5E03\u6D41\u7A0B\u3002', visibility: 'public', tags: ['vscode', 'dev'], latestVersion: '1.0.0', downloads: 28 },
];

/**
 * EditorPane that renders the VsSaros Marketplace page inside the editor area.
 * Uses native DOM with CSS classes matching the mockup design.
 */
export class MarketplaceEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.marketplace';

	private _container!: HTMLElement;
	private _gridEl!: HTMLElement;
	private _searchInput!: HTMLInputElement;
	private _userEl!: HTMLElement;
	private _resultCountEl!: HTMLElement;
	private _detailEl!: HTMLElement;
	private _detailContentEl!: HTMLElement;
	private _overlayEl!: HTMLElement;

	private _packages: IMarketplacePackage[] = [];
	private _loading = false;
	private _activeCategory: PackageKind | 'all' | 'graph' = 'all';
	private _searchQuery = '';
	private _installingIds: Set<string> = new Set();

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@IMarketplaceService private readonly marketplaceService: IMarketplaceService,
		@ICodebaseMemoryMcpService private readonly cbmService: ICodebaseMemoryMcpService,
	) {
		super(MarketplaceEditorPane.ID, group, telemetryService, themeService, storageService);

		// 监听商城登录状态变化 → 更新用户信息 + 重新加载资源列表
		this._register(this.marketplaceService.onDidChangeLogin(() => {
			this._refreshUserDisplay();
			this._loadPackages().catch(() => { /* ignore */ });
		}));
	}

	/** 刷新用户信息显示区域 */
	private _refreshUserDisplay(): void {
		if (!this._userEl) { return; }
		clearNode(this._userEl); // 不用 innerHTML（TrustedHTML CSP 拦截）
		const user = this.marketplaceService.getCurrentUser();
		console.log('[MarketplaceEditorPane] _refreshUserDisplay: user=', user ? user.username : 'null', 'isLoggedIn=', this.marketplaceService.isLoggedIn());
		if (user) {
			const avatar = document.createElement('div');
			avatar.className = 'avatar';
			avatar.textContent = (user.username || '?').charAt(0).toUpperCase();
			this._userEl.appendChild(avatar);
			const nameSpan = document.createElement('span');
			nameSpan.textContent = user.username;
			this._userEl.appendChild(nameSpan);
			const sep = document.createElement('span');
			sep.style.color = 'var(--vscode-descriptionForeground,#9d9d9d)';
			sep.textContent = '|';
			this._userEl.appendChild(sep);
			const status = document.createElement('span');
			status.style.color = '#4ec9b0';
			status.textContent = '\u25CF \u5DF2\u8FDE\u63A5'; // ● 已连接
			this._userEl.appendChild(status);
		} else {
			this._userEl.textContent = '\u26A0 \u672A\u767B\u5F55'; // ⚠ 未登录
		}
	}

	protected createEditor(parent: HTMLElement): void {
		// Inject CSS once
		const styleEl = document.createElement('style');
		styleEl.textContent = CSS_TEXT;
		document.head.appendChild(styleEl);
		this._register({ dispose: () => styleEl.remove() });

		this._container = document.createElement('div');
		this._container.className = 'mp-page';
		this._container.style.cssText = 'width:100%;height:100%;overflow:hidden;position:relative;';

		// ── Header ──────────────────────────────────────
		const header = document.createElement('div');
		header.className = 'mp-header';

		const titleRow = document.createElement('div');
		titleRow.className = 'mp-title-row';
		const h1 = document.createElement('h1');
		h1.textContent = '\u{1F6D2} VsSaros \u5546\u57CE'; // 🛒 VsSaros 商城
		titleRow.appendChild(h1);

		const userEl = document.createElement('div');
		userEl.className = 'mp-user';
		this._userEl = userEl;
		this._refreshUserDisplay(); // 使用统一方法填充内容
		titleRow.appendChild(userEl);
		header.appendChild(titleRow);

		// Toolbar: search + categories
		const toolbar = document.createElement('div');
		toolbar.className = 'mp-toolbar';
		const searchBox = document.createElement('div');
		searchBox.className = 'mp-search';
		const searchIcon = document.createElement('span');
		searchIcon.textContent = '\u{1F50D}';
		searchBox.appendChild(searchIcon);
		this._searchInput = document.createElement('input');
		this._searchInput.placeholder = '\u641C\u7D22\u8D44\u6E90\u540D\u79F0\u3001\u63CF\u8FF0\u3001\u6807\u7B7E...'; // 搜索资源名称、描述、标签...
		this._searchInput.oninput = () => {
			this._searchQuery = this._searchInput.value.trim().toLowerCase();
			this._renderGrid();
		};
		searchBox.appendChild(this._searchInput);
		toolbar.appendChild(searchBox);

		const cats = document.createElement('div');
		cats.className = 'mp-cats';
		const catOptions: { id: PackageKind | 'all' | 'graph'; label: string }[] = [
			{ id: 'all', label: '\u5168\u90E8' }, // 全部
			{ id: 'skill', label: '\u{1F4C4} \u6280\u80FD' }, // 📄 技能
			{ id: 'agent', label: '\u{1F916} Agent' },
			{ id: 'mcp', label: '\u{1F50C} MCP' },
			{ id: 'knowledge', label: '\u{1F4DA} \u77E5\u8BC6\u5E93' }, // 📚 知识库
			{ id: 'graph', label: '\u{1F9E0} Graph' }, // 🧠 Graph
		];
		for (const opt of catOptions) {
			const chip = document.createElement('div');
			chip.className = 'mp-cat' + (opt.id === 'all' ? ' active' : '');
			chip.textContent = opt.label;
			chip.onclick = () => {
				this._activeCategory = opt.id;
				cats.querySelectorAll('.mp-cat').forEach(c => c.classList.remove('active'));
				chip.classList.add('active');
				this._renderGrid();
			};
			cats.appendChild(chip);
		}
		toolbar.appendChild(cats);
		header.appendChild(toolbar);
		this._container.appendChild(header);

		// ── Grid scroll area ────────────────────────────
		const gridScroll = document.createElement('div');
		gridScroll.className = 'mp-grid-scroll';
		const grid = document.createElement('div');
		grid.className = 'mp-grid';

		const sectionTitle = document.createElement('div');
		sectionTitle.className = 'mp-section-title';
		sectionTitle.textContent = '\u{1F4E6} \u5546\u57CE\u8D44\u6E90 '; // 📦 商城资源
		this._resultCountEl = document.createElement('span');
		this._resultCountEl.className = 'count';
		sectionTitle.appendChild(this._resultCountEl);
		grid.appendChild(sectionTitle);

		this._gridEl = document.createElement('div');
		this._gridEl.className = 'mp-cards';
		grid.appendChild(this._gridEl);

		// Pagination (static, matching mockup)
		const pagination = document.createElement('div');
		pagination.className = 'mp-pagination';
		const prevBtn = document.createElement('div');
		prevBtn.className = 'mp-page-btn';
		prevBtn.textContent = '\u2039 \u4E0A\u4E00\u9875'; // ‹ 上一页
		(prevBtn as HTMLDivElement).style.opacity = '0.4';
		(prevBtn as HTMLDivElement).style.cursor = 'default';
		pagination.appendChild(prevBtn);
		const page1 = document.createElement('div');
		page1.className = 'mp-page-btn active';
		page1.textContent = '1';
		pagination.appendChild(page1);
		const page2 = document.createElement('div');
		page2.className = 'mp-page-btn';
		page2.textContent = '2';
		pagination.appendChild(page2);
		const nextBtn = document.createElement('div');
		nextBtn.className = 'mp-page-btn';
		nextBtn.textContent = '\u4E0B\u4E00\u9875 \u203A'; // 下一页 ›
		pagination.appendChild(nextBtn);
		grid.appendChild(pagination);

		gridScroll.appendChild(grid);
		this._container.appendChild(gridScroll);

		// ── Detail panel (hidden) ───────────────────────
		this._detailEl = document.createElement('div');
		this._detailEl.className = 'mp-detail';
		const back = document.createElement('div');
		back.className = 'md-back';
		back.textContent = '\u2190 \u8FD4\u56DE\u5546\u57CE\u5217\u8868'; // ← 返回商城列表
		back.onclick = () => { this._detailEl.classList.remove('show'); };
		this._detailEl.appendChild(back);
		this._detailContentEl = document.createElement('div');
		this._detailContentEl.className = 'md-content';
		this._detailEl.appendChild(this._detailContentEl);
		this._container.appendChild(this._detailEl);

		// ── Install overlay (hidden) ────────────────────
		this._overlayEl = document.createElement('div');
		this._overlayEl.className = 'install-overlay';
		this._container.appendChild(this._overlayEl);

		parent.appendChild(this._container);

		// Immediately load packages (also re-triggered via setInput)
		this._loadPackages();
	}

	override async setInput(
		input: EditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!(input instanceof MarketplaceEditorInput)) { return; }
		await this._loadPackages();
	}

	/** Helper: show an empty-state message in the grid (avoids innerHTML / TrustedHTML CSP) */
	private _showEmptyMessage(msg: string): void {
		clearNode(this._gridEl);
		const el = document.createElement('div');
		el.className = 'mp-empty';
		el.textContent = msg;
		this._gridEl.appendChild(el);
	}

	private async _loadPackages(): Promise<void> {
		if (this._loading) { return; }
		this._loading = true;
		this._showEmptyMessage('\u52A0\u8F7D\u4E2D...'); // 加载中...
		try {
			const result = await this.marketplaceService.listPackages({ pageSize: 100 });
			this._packages = [...result.items];
			if (!this._packages || this._packages.length === 0) {
				// Fallback to mock data if server returns empty
				console.log('[Marketplace] Server returned empty, using mock data');
				this._packages = MOCK_PACKAGES;
			}
			this._renderGrid();
		} catch (err) {
			// Fallback to mock data if API is unreachable
			console.error('[Marketplace] API error:', err);
			this._packages = MOCK_PACKAGES;
			this._renderGrid();
		} finally {
			this._loading = false;
		}
	}

	private _renderGrid(): void {
		if (!this._gridEl) { return; }
		clearNode(this._gridEl);

		// Graph tab — special rendering (fetches from Git remote)
		if (this._activeCategory === 'graph') {
			this._renderGraphGrid();
			return;
		}

		let filtered = this._packages;
		if (!filtered || filtered.length === 0) {
			this._showEmptyMessage('\u6CA1\u6709\u53EF\u7528\u7684\u8D44\u6E90'); // 没有可用的资源
			this._resultCountEl.textContent = '0 \u4E2A\u8D44\u6E90';
			return;
		}
		if (this._activeCategory !== 'all') {
			filtered = filtered.filter(p => p.kind === this._activeCategory);
		}
		if (this._searchQuery) {
			filtered = filtered.filter(p =>
				p.name.toLowerCase().includes(this._searchQuery) ||
				((p.description ?? '').toLowerCase().includes(this._searchQuery)) ||
				(p.tags && p.tags.some(t => t.toLowerCase().includes(this._searchQuery)))
			);
		}
		this._resultCountEl.textContent = `${filtered.length} \u4E2A\u8D44\u6E90`; // X 个资源

		if (filtered.length === 0) {
			this._showEmptyMessage('\u6CA1\u6709\u5339\u914D\u7684\u8D44\u6E90'); // 没有匹配的资源
			return;
		}

		for (const pkg of filtered) {
			this._gridEl.appendChild(this._createCard(pkg));
		}
	}

	// ── Graph tab: fetch from remote Git repo ──────────────────────────────

	private static readonly GRAPH_REMOTE = 'https://git.woa.com/zijianqiu/vssaros-codebase-memory.git';

	private async _renderGraphGrid(): Promise<void> {
		if (!this._gridEl) { return; }
		this._resultCountEl.textContent = '加载中...';
		this._gridEl.innerHTML = '<div style="padding:40px;text-align:center;color:var(--vscode-descriptionForeground,#9d9d9d);">⏳ 正在从远程仓库获取 Graph 列表...</div>';

		const cp = (globalThis as any).require?.('child_process');
		if (!cp) {
			this._gridEl.innerHTML = '<div style="padding:40px;text-align:center;color:#f48771;">✗ 无法访问文件系统</div>';
			this._resultCountEl.textContent = '0 个 Graph';
			return;
		}

		let branches: { name: string; hash: string }[] = [];
		try {
			const output = cp.execSync(`git ls-remote --heads ${MarketplaceEditorPane.GRAPH_REMOTE}`, {
				encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'],
			}).trim();
			branches = output.split('\n').filter((l: string) => l.trim()).map((line: string) => {
				const [hash, ref] = line.split('\t');
				return { name: ref.replace('refs/heads/', ''), hash };
			});
		} catch (err: any) {
			this._gridEl.innerHTML = `<div style="padding:40px;text-align:center;color:#f48771;">✗ 获取失败: ${err?.message || err}<br><br>请确保远程仓库存在且网络可达。</div>`;
			this._resultCountEl.textContent = '0 个 Graph';
			return;
		}

		if (branches.length === 0) {
			this._gridEl.innerHTML = '<div style="padding:40px;text-align:center;color:var(--vscode-descriptionForeground,#9d9d9d);">📦 远程仓库中暂无 Graph 数据<br><br>先在 Codebase Memory 中索引项目并"同步到团队"。</div>';
			this._resultCountEl.textContent = '0 个 Graph';
			return;
		}

		this._resultCountEl.textContent = `${branches.length} 个 Graph`;
		for (const b of branches) {
			this._gridEl.appendChild(this._createGraphCard(b.name, b.hash));
		}
	}

	private _createGraphCard(projectName: string, hash: string): HTMLElement {
		const card = document.createElement('div');
		card.className = 'mp-card';
		card.style.cursor = 'default';

		const top = document.createElement('div');
		top.className = 'card-top';
		const icon = document.createElement('div');
		icon.className = 'card-icon';
		icon.textContent = '\u{1F9E0}'; // 🧠
		top.appendChild(icon);
		const info = document.createElement('div');
		info.className = 'card-info';
		const nameEl = document.createElement('div');
		nameEl.className = 'card-name';
		nameEl.textContent = projectName;
		info.appendChild(nameEl);
		const meta = document.createElement('div');
		meta.className = 'card-meta';
		const badge = document.createElement('span');
		badge.className = 'card-badge';
		badge.style.cssText = 'background:rgba(197,134,192,.15);color:#c586c0;font-size:9px;padding:2px 7px;border-radius:3px;font-weight:600;';
		badge.textContent = 'Graph';
		meta.appendChild(badge);
		const ver = document.createElement('span');
		ver.className = 'card-ver';
		ver.textContent = hash.substring(0, 7);
		meta.appendChild(ver);
		info.appendChild(meta);
		top.appendChild(info);
		card.appendChild(top);

		const desc = document.createElement('div');
		desc.className = 'card-desc';
		desc.textContent = `\u56E2\u961F\u5171\u4EAB\u7684\u4EE3\u7801\u5E93\u77E5\u8BC6\u56FE\u8C31\u3002\u9879\u76EE: ${projectName}`;
		card.appendChild(desc);

		const footer = document.createElement('div');
		footer.className = 'card-footer';
		const stats = document.createElement('div');
		stats.className = 'card-stats';
		stats.textContent = '\u{1F4E6} graph.db.zst';
		footer.appendChild(stats);

		const btn = document.createElement('button');
		btn.className = 'install-btn';
		btn.textContent = '\u2B07 \u4E0B\u8F7D'; // ⬇ 下载
		btn.onclick = async (e: Event) => {
			e.stopPropagation();
			btn.disabled = true;
			btn.textContent = '\u23F3 \u4E0B\u8F7D\u4E2D...'; // ⏳ 下载中...
			try {
				const result = await this.cbmService.syncGraph();
				if (result.success) {
					btn.textContent = '\u2713 \u5DF2\u540C\u6B65'; // ✓ 已同步
					btn.classList.add('installed');
					this.notificationService.info(result.message);
				} else {
					btn.textContent = '\u2B07 \u4E0B\u8F7D';
					btn.disabled = false;
					this.notificationService.warn(result.message);
				}
			} catch (err: any) {
				btn.textContent = '\u2B07 \u4E0B\u8F7D';
				btn.disabled = false;
				this.notificationService.error(`\u4E0B\u8F7D\u5931\u8D25: ${err?.message || err}`);
			}
		};
		footer.appendChild(btn);
		card.appendChild(footer);

		return card;
	}

	private _createCard(pkg: IMarketplacePackage): HTMLElement {
		const card = document.createElement('div');
		card.className = 'mp-card';
		card.onclick = () => this._openDetail(pkg);

		// Top: icon + name + meta
		const top = document.createElement('div');
		top.className = 'card-top';
		const icon = document.createElement('div');
		icon.className = 'card-icon';
		icon.textContent = pkg.icon ?? KIND_ICON[pkg.kind];
		top.appendChild(icon);
		const info = document.createElement('div');
		info.className = 'card-info';
		const name = document.createElement('div');
		name.className = 'card-name';
		name.textContent = pkg.name;
		info.appendChild(name);
		const meta = document.createElement('div');
		meta.className = 'card-meta';
		const badge = document.createElement('span');
		badge.className = 'card-badge ' + this._kindBadgeClass(pkg.kind);
		badge.textContent = KIND_LABEL[pkg.kind];
		meta.appendChild(badge);
		if (pkg.latestVersion) {
			const ver = document.createElement('span');
			ver.className = 'card-ver';
			ver.textContent = `v${pkg.latestVersion}`;
			meta.appendChild(ver);
		}
		info.appendChild(meta);
		top.appendChild(info);
		card.appendChild(top);

		// Description
		const desc = document.createElement('div');
		desc.className = 'card-desc';
		desc.textContent = pkg.description ?? '\u65E0\u63CF\u8FF0'; // 无描述
		card.appendChild(desc);

		// Footer: stats + install button
		const footer = document.createElement('div');
		footer.className = 'card-footer';
		const stats = document.createElement('div');
		stats.className = 'card-stats';
		if (pkg.downloads !== undefined) {
			stats.textContent = `\u2B07 ${pkg.downloads}`;
		}
		footer.appendChild(stats);
		const installBtn = document.createElement('button');
		installBtn.className = 'install-btn';
		installBtn.textContent = '\u5B89\u88C5'; // 安装
		installBtn.onclick = (e) => { e.stopPropagation(); this._startInstall(pkg); };
		footer.appendChild(installBtn);
		card.appendChild(footer);

		return card;
	}

	private _kindBadgeClass(kind: PackageKind): string {
		switch (kind) {
			case 'skill': return 'badge-skill';
			case 'agent': return 'badge-agent';
			case 'mcp': return 'badge-mcp';
			case 'knowledge': return 'badge-kb';
		}
	}

	private async _openDetail(pkg: IMarketplacePackage): Promise<void> {
		clearNode(this._detailContentEl);
		this._detailEl.classList.add('show');

		// Basic info first
		const h2 = document.createElement('h2');
		h2.textContent = `${pkg.icon ?? KIND_ICON[pkg.kind]} ${pkg.name} `;
		if (pkg.latestVersion) {
			const ver = document.createElement('span');
			ver.style.cssText = 'font-size:14px;color:var(--vscode-textLink-foreground,#569cd6);font-family:monospace;';
			ver.textContent = `v${pkg.latestVersion}`;
			h2.appendChild(ver);
		}
		this._detailContentEl.appendChild(h2);

		const meta = document.createElement('div');
		meta.className = 'md-meta';
		const badge = document.createElement('span');
		badge.className = 'card-badge ' + this._kindBadgeClass(pkg.kind);
		badge.textContent = KIND_LABEL[pkg.kind];
		meta.appendChild(badge);
		if (pkg.downloads !== undefined) {
			meta.appendChild(document.createTextNode(`\u2B07 ${pkg.downloads} \u6B21\u4E0B\u8F7D`)); // ⬇ X 次下载
		}
		if (pkg.tags.length > 0) {
			meta.appendChild(document.createTextNode(`\u6807\u7B7E: ${pkg.tags.map(t => '#' + t).join(' ')}`)); // 标签:
		}
		this._detailContentEl.appendChild(meta);

		const descBox = document.createElement('div');
		descBox.className = 'md-desc';
		descBox.textContent = pkg.description ?? '\u65E0\u63CF\u8FF0'; // 无描述
		this._detailContentEl.appendChild(descBox);

		// Version history (fetch detail)
		const versionsSection = document.createElement('div');
		versionsSection.className = 'md-versions';
		const versionsTitle = document.createElement('h3');
		versionsTitle.textContent = '\u{1F4DC} \u7248\u672C\u5386\u53F2'; // 📜 版本历史
		versionsSection.appendChild(versionsTitle);
		const loadingVer = document.createElement('div');
		loadingVer.style.cssText = 'font-size:12px;color:var(--vscode-descriptionForeground,#9d9d9d);';
		loadingVer.textContent = '\u52A0\u8F7D\u4E2D...';
		versionsSection.appendChild(loadingVer);
		this._detailContentEl.appendChild(versionsSection);

		// Install bar
		const installBar = document.createElement('div');
		installBar.className = 'md-install-bar';
		const installBtn = document.createElement('button');
		installBtn.className = 'install-btn';
		installBtn.style.cssText = 'font-size:13px;padding:7px 20px;';
		installBtn.textContent = '\u2B07 \u4E0B\u8F7D\u5E76\u5B89\u88C5'; // ⬇ 下载并安装
		installBtn.onclick = () => this._startInstall(pkg);
		installBar.appendChild(installBtn);
		const hint = document.createElement('span');
		hint.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground,#9d9d9d);';
		hint.textContent = '\u5B89\u88C5\u5230 ~/.saros/ \u76EE\u5F55\uFF0C\u81EA\u52A8\u542F\u7528'; // 安装到 ~/.saros/ 目录，自动启用
		installBar.appendChild(hint);
		this._detailContentEl.appendChild(installBar);

		// Fetch version history
		try {
			const detail: IMarketplacePackageDetail = await this.marketplaceService.getPackage(pkg.slug);
			loadingVer.remove();
			for (const ver of detail.versions) {
				const verItem = document.createElement('div');
				verItem.className = 'ver-item' + (ver.isLatest ? ' latest' : '');
				const left = document.createElement('div');
				const verLabel = document.createElement('strong');
				verLabel.textContent = `v${ver.version}`;
				left.appendChild(verLabel);
				if (ver.isLatest) {
					const latestTag = document.createElement('span');
					latestTag.style.cssText = 'color:#4ec9b0;font-size:12px;margin-left:8px;';
					latestTag.textContent = '(\u6700\u65B0)'; // (最新)
					left.appendChild(latestTag);
				}
				const verMeta = document.createElement('div');
				verMeta.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground,#9d9d9d);margin-top:3px;';
				const date = new Date(ver.createdAt);
				verMeta.textContent = `${date.toISOString().split('T')[0]} \u00B7 ${this._formatSize(ver.size)}`;
				left.appendChild(verMeta);
				verItem.appendChild(left);

				if (ver.isLatest) {
					const verInstallBtn = document.createElement('button');
					verInstallBtn.className = 'install-btn';
					verInstallBtn.textContent = '\u5B89\u88C5'; // 安装
					verInstallBtn.onclick = () => this._startInstall(pkg);
					verItem.appendChild(verInstallBtn);
				}
				versionsSection.appendChild(verItem);
			}
		} catch {
			loadingVer.textContent = '\u7248\u672C\u5386\u53F2\u52A0\u8F7D\u5931\u8D25'; // 版本历史加载失败
		}
	}

	private _formatSize(bytes: number): string {
		if (bytes < 1024) { return `${bytes} B`; }
		if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	private async _startInstall(pkg: IMarketplacePackage): Promise<void> {
		if (this._installingIds.has(pkg.id)) { return; }
		if (!pkg.latestVersion) {
			this.notificationService.warn(`\u8D44\u6E90 "${pkg.name}" \u6CA1\u6709\u53EF\u7528\u7248\u672C\u3002`);
			return;
		}
		if (!this.marketplaceService.isLoggedIn()) {
			this.notificationService.info('\u8BF7\u5148\u767B\u5F55\u5546\u57CE\u3002');
			return;
		}

		this._installingIds.add(pkg.id);
		this._showInstallOverlay(pkg);

		try {
			const result = await this.marketplaceService.download(pkg.slug, pkg.latestVersion, pkg.kind);
			this._showInstallSuccess(pkg, result.version);
			this.notificationService.info(`\u2705 ${pkg.name} v${result.version} \u5B89\u88C5\u6210\u529F\u3002`);
		} catch (err) {
			this._showInstallError(pkg, err instanceof Error ? err.message : String(err));
			this.notificationService.error(`\u5B89\u88C5\u5931\u8D25: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this._installingIds.delete(pkg.id);
		}
	}

	private _showInstallOverlay(pkg: IMarketplacePackage): void {
		clearNode(this._overlayEl);
		this._overlayEl.classList.add('show');

		const dialog = document.createElement('div');
		dialog.className = 'install-dialog';

		// Head
		const head = document.createElement('div');
		head.className = 'id-head';
		const headTitle = document.createElement('span');
		headTitle.textContent = `\u5B89\u88C5 ${pkg.name}`; // 安装 X
		head.appendChild(headTitle);
		const closeX = document.createElement('span');
		closeX.style.cssText = 'cursor:pointer;color:var(--vscode-descriptionForeground,#9d9d9d);font-size:18px;';
		closeX.textContent = '\u2715';
		closeX.onclick = () => { this._overlayEl.classList.remove('show'); };
		head.appendChild(closeX);
		dialog.appendChild(head);

		// Body
		const body = document.createElement('div');
		body.className = 'id-body';

		const rows: [string, string][] = [
			['\u540D\u79F0', `${pkg.icon ?? KIND_ICON[pkg.kind]} ${pkg.name}`], // 名称
			['\u7248\u672C', `v${pkg.latestVersion}`], // 版本
			['\u7C7B\u578B', KIND_LABEL[pkg.kind]], // 类型
			['\u5B89\u88C5\u4F4D\u7F6E', `~/.saros/${pkg.kind === 'knowledge' ? 'knowledge-base' : pkg.kind === 'mcp' ? 'mcp-servers' : pkg.kind === 'agent' ? 'agents/custom' : 'skills-library'}/${pkg.slug}/`], // 安装位置
		];
		for (const [label, val] of rows) {
			const row = document.createElement('div');
			row.className = 'id-row';
			const l = document.createElement('span');
			l.className = 'id-label';
			l.textContent = label;
			const v = document.createElement('span');
			v.className = 'id-val';
			if (label === '\u7248\u672C') { v.style.color = 'var(--vscode-textLink-foreground,#569cd6)'; }
			if (label === '\u5B89\u88C5\u4F4D\u7F6E') { v.style.cssText = 'font-family:monospace;font-size:11px;'; }
			v.textContent = val;
			row.appendChild(l); row.appendChild(v);
			body.appendChild(row);
		}

		// Progress
		const progress = document.createElement('div');
		progress.className = 'id-progress';
		const bar = document.createElement('div');
		bar.className = 'id-bar';
		const fill = document.createElement('div');
		fill.className = 'id-fill';
		bar.appendChild(fill);
		progress.appendChild(bar);

		const stepsEl = document.createElement('div');
		stepsEl.className = 'id-steps';
		const stepLabels = [
			'\u4E0B\u8F7D\u8D44\u6E90\u5305', // 下载资源包
			'\u89E3\u538B\u6587\u4EF6', // 解压文件
			'\u5B89\u88C5\u5230\u672C\u5730\u76EE\u5F55', // 安装到本地目录
			'\u6CE8\u518C\u5E76\u91CD\u65B0\u52A0\u8F7D', // 注册并重新加载
		];
		const stepEls: HTMLElement[] = [];
		for (const label of stepLabels) {
			const step = document.createElement('div');
			step.className = 'id-step pending';
			step.textContent = label;
			stepsEl.appendChild(step);
			stepEls.push(step);
		}
		progress.appendChild(stepsEl);
		body.appendChild(progress);
		dialog.appendChild(body);

		// Actions
		const actions = document.createElement('div');
		actions.className = 'id-actions';
		const cancelBtn = document.createElement('button');
		cancelBtn.className = 'id-btn';
		cancelBtn.textContent = '\u53D6\u6D88'; // 取消
		cancelBtn.onclick = () => { this._overlayEl.classList.remove('show'); };
		actions.appendChild(cancelBtn);
		dialog.appendChild(actions);

		this._overlayEl.appendChild(dialog);

		// Animate progress steps
		let step = 0;
		const tick = () => {
			if (step < stepEls.length && this._overlayEl.classList.contains('show')) {
				stepEls[step].classList.remove('pending');
				stepEls[step].classList.add('active');
				fill.style.width = `${((step + 1) / stepEls.length) * 100}%`;
				setTimeout(() => {
					if (!this._overlayEl.classList.contains('show')) { return; }
					stepEls[step].classList.remove('active');
					stepEls[step].classList.add('done');
					stepEls[step].textContent = `\u2713 ${stepEls[step].textContent}`;
					step++;
					tick();
				}, 700);
			}
		};
		setTimeout(tick, 400);
	}

	private _showInstallSuccess(pkg: IMarketplacePackage, version: string): void {
		clearNode(this._overlayEl);
		this._overlayEl.classList.add('show');

		const dialog = document.createElement('div');
		dialog.className = 'install-dialog';

		const body = document.createElement('div');
		body.className = 'id-body';
		body.style.textAlign = 'center';
		body.style.padding = '20px 18px';

		const icon = document.createElement('div');
		icon.style.cssText = 'font-size:40px;margin-bottom:8px;';
		icon.textContent = '\u2705';
		body.appendChild(icon);

		const title = document.createElement('div');
		title.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:6px;';
		title.textContent = `${pkg.name} \u5B89\u88C5\u6210\u529F\uFF01`; // X 安装成功！
		body.appendChild(title);

		const ver = document.createElement('div');
		ver.style.cssText = 'font-size:12px;color:var(--vscode-descriptionForeground,#9d9d9d);';
		ver.textContent = `\u7248\u672C v${version} \u00B7 \u5DF2\u5B89\u88C5\u5230\u672C\u5730`; // 版本 vX · 已安装到本地
		body.appendChild(ver);

		const hint = document.createElement('div');
		hint.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground,#9d9d9d);margin-top:6px;';
		hint.textContent = '\u8D44\u6E90\u5DF2\u81EA\u52A8\u542F\u7528\uFF0C\u53EF\u5728 Integration \u9762\u677F\u4E2D\u4F7F\u7528'; // 资源已自动启用，可在 Integration 面板中使用
		body.appendChild(hint);

		dialog.appendChild(body);

		const actions = document.createElement('div');
		actions.className = 'id-actions';
		const doneBtn = document.createElement('button');
		doneBtn.className = 'id-btn';
		doneBtn.textContent = '\u5B8C\u6210'; // 完成
		doneBtn.onclick = () => { this._overlayEl.classList.remove('show'); this._detailEl.classList.remove('show'); this._renderGrid(); };
		actions.appendChild(doneBtn);
		const okBtn = document.createElement('button');
		okBtn.className = 'id-btn primary';
		okBtn.textContent = '\u6253\u5F00\u8D44\u6E90'; // 打开资源
		okBtn.onclick = () => { this._overlayEl.classList.remove('show'); this._detailEl.classList.remove('show'); this._renderGrid(); };
		actions.appendChild(okBtn);
		dialog.appendChild(actions);

		this._overlayEl.appendChild(dialog);
	}

	private _showInstallError(pkg: IMarketplacePackage, errorMsg: string): void {
		clearNode(this._overlayEl);
		this._overlayEl.classList.add('show');

		const dialog = document.createElement('div');
		dialog.className = 'install-dialog';
		dialog.style.borderColor = 'var(--vscode-errorForeground,#f48771)';

		const body = document.createElement('div');
		body.className = 'id-body';
		body.style.textAlign = 'center';
		body.style.padding = '20px 18px';

		const icon = document.createElement('div');
		icon.style.cssText = 'font-size:40px;margin-bottom:8px;';
		icon.textContent = '\u274C';
		body.appendChild(icon);

		const title = document.createElement('div');
		title.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:6px;color:var(--vscode-errorForeground,#f48771);';
		title.textContent = '\u5B89\u88C5\u5931\u8D25'; // 安装失败
		body.appendChild(title);

		const msg = document.createElement('div');
		msg.style.cssText = 'font-size:12px;color:var(--vscode-descriptionForeground,#9d9d9d);';
		msg.textContent = errorMsg;
		body.appendChild(msg);
		dialog.appendChild(body);

		const actions = document.createElement('div');
		actions.className = 'id-actions';
		const closeBtn = document.createElement('button');
		closeBtn.className = 'id-btn primary';
		closeBtn.textContent = '\u5173\u95ED'; // 关闭
		closeBtn.onclick = () => { this._overlayEl.classList.remove('show'); };
		actions.appendChild(closeBtn);
		dialog.appendChild(actions);

		this._overlayEl.appendChild(dialog);
	}

	override layout(_dimension: Dimension): void {
		// Container uses flex, auto-fills.
	}

	override clearInput(): void {
		this._detailEl.classList.remove('show');
		this._overlayEl.classList.remove('show');
		super.clearInput();
	}
}
