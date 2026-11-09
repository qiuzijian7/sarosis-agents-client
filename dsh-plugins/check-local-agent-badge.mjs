#!/usr/bin/env node
// check-local-agent-badge.mjs — 引擎徽标三份映射的静态对账（2026-11-09）
//
// chunk realm 只允许 require("react") ⇒ client.settings.js / client.conversationViews.js
// 必须各内联一份映射。任何一处增删引擎忘了同步，徽标就会在不同位置显示不一致。
//   node dsh-plugins/check-local-agent-badge.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGINS = dirname(fileURLToPath(import.meta.url));
const text = (rel) => readFileSync(join(PLUGINS, rel), 'utf8');
const problems = [];
const check = (name, ok, detail = '') => {
	if (ok) console.log(`  ok   ${name}`);
	else { problems.push(`${name}${detail ? ` — ${detail}` : ''}`); console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const badge = await import(pathToFileURL(join(PLUGINS, 'vssaros-local-agents/lib/core/badge.js')).href);
const truth = badge.LOCAL_AGENT_BADGES;

/** 从 `const XXX = { "k": "v", ... };` 字面量里取键值对。 */
function mapFrom(source, varName) {
	const body = source.match(new RegExp(`(?:const|let|var)\\s+${varName}\\s*=\\s*\\{([\\s\\S]*?)\\}`))?.[1];
	if (!body) return undefined;
	const out = {};
	for (const match of body.matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g)) out[match[1]] = match[2];
	return out;
}

const settingsSrc = text('vssaros-chat-surface/lib/client.settings.js');
const detailsSrc = text('vssaros-chat-surface/lib/client.conversationViews.js');
const entrySrc = text('vssaros-chat-surface/lib/client.js');

const settingsMap = mapFrom(settingsSrc, 'LOCAL_AGENT_BADGES');
const detailsMap = mapFrom(detailsSrc, 'BADGES');
check('三处都能解析到映射表', !!settingsMap && !!detailsMap && Object.keys(truth).length >= 6);
check('会话头映射与真源逐项一致',
	JSON.stringify(settingsMap) === JSON.stringify(truth),
	`chunk=${JSON.stringify(settingsMap)}`);
check('Bot 详情映射与真源逐项一致',
	JSON.stringify(detailsMap) === JSON.stringify(truth),
	`chunk=${JSON.stringify(detailsMap)}`);
check('两处都渲染了 data-vssaros-local-agent-badge 徽标节点',
	settingsSrc.includes('"data-vssaros-local-agent-badge"') && detailsSrc.includes('"data-vssaros-local-agent-badge"'));
check('两处都对非本地 Agent 保持静默（不猜、不误标）',
	settingsSrc.includes('indexOf("vssaros-") !== 0') && detailsSrc.includes('indexOf("vssaros-") === 0'));
check('改了 client.*.js 后入口 CLIENT_BUILD_STAMP 已同步',
	entrySrc.includes('2026-11-09/本地Agent设置页入口与引擎徽标/47'));
check('设置页卡片存在且指向 SSR 页面',
	settingsSrc.includes('localAgentBadgeOf') && text('vssaros-chat-surface/lib/client.modelAccounts.js').includes('href: "/x/local-agents/"'));
check('footer 槽注册未被改动（vssaros-accounts / order 仍在）',
	/FOOTER_ID\s*=\s*"vssaros-accounts"/.test(text('vssaros-chat-surface/lib/client.modelAccounts.js'))
	&& /FOOTER_ORDER\s*=\s*\d+/.test(text('vssaros-chat-surface/lib/client.modelAccounts.js')));

if (problems.length) {
	console.error(`\n[check-local-agent-badge] ✗ ${problems.length} 处：`);
	for (const problem of problems) console.error(`  - ${problem}`);
	process.exit(1);
}
console.log('\n[check-local-agent-badge] ✓ 三份引擎映射一致、徽标节点齐备、入口 stamp 已同步');
