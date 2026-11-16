// @vssaros/dsh-agents — 官方 Agent Teams × 队伍群聊 P1 兼容性门禁（只读）。
//   跑法：node dsh-plugins/vssaros-agents/test/official-team-compat.test.mjs
//
// 这道门禁不是「官方 Team 能不能用」的功能测试，而是防止把当前独立 Bot 影子会话
// 误当成官方 subagent 后代、在身份与权限未经运行时验证前直接迁移任务板。
// 运行时源码缺失（干净检出未安装 node_modules）⇒ 明确 skip，不假装通过。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const OFFICIAL = join(ROOT, 'dsh-runtime', '0.2.2-rc.2', 'node_modules', '@deepseek-ai');
const source = (...parts) => readFileSync(join(...parts), 'utf8');
const checks = [];
const failed = [];
function check(name, fn) {
	try { fn(); checks.push(name); console.log(`  ok   ${name}`); }
	catch (error) { failed.push(`${name}: ${error.message}`); console.error(`  FAIL ${name}: ${error.message}`); }
}

if (!existsSync(OFFICIAL)) {
	console.log('official-team-compat: skipped（随包 runtime 的 node_modules 不存在，无法做静态兼容性核对）');
	process.exit(0);
}

const presetSelection = source(OFFICIAL, 'dsh-tool-subagent', 'src', 'preset-selection.ts');
const subagentTool = source(OFFICIAL, 'dsh-tool-subagent', 'src', 'index.ts');
const basePatch = source(OFFICIAL, 'dsh-base', 'cordis.patch.yml');
const taskBoard = source(OFFICIAL, 'dsh-agent-team', 'src', 'task-board.ts');
const roomsSrc = source(ROOT, 'dsh-plugins', 'vssaros-agents', 'lib', 'rooms.js');
const adapterSrc = source(ROOT, 'dsh-plugins', 'vssaros-agents', 'lib', 'officialTeamAdapter.js');

check('subagent 的 agent_preset 只有配置 allowlist 才对模型可见', () => {
	assert.match(presetSelection, /allowedAgentPresets\?: string\[\] \| undefined/);
	assert.match(presetSelection, /get choices\(\)[\s\S]{0,160}return this\.config\.allowedAgentPresets/);
	assert.match(subagentTool, /agent_preset: \{[\s\S]{0,220}enum: \[\.\.\.presets\.choices\]/);
	assert.match(subagentTool, /presets\.resolve\(args as PresetSelectionRequest\)/);
});
check('随包 dsh-base 默认未开放 agent_preset：后代继承父 preset，而非按 Bot 名册选择', () => {
	assert.doesNotMatch(basePatch, /allowedAgentPresets|agentPreset:/);
	assert.match(basePatch, /- id: tool-subagent\n\s+name: '@deepseek-ai\/dsh-tool-subagent'\n\s+config:\n\s+provider: spawn\n\s+toolName: subagent/);
});
check('官方任务 owner 必须是 root 或可继续执行的 subagent 后代', () => {
	assert.match(taskBoard, /listDescendants\(root\.id, signal\)/);
	assert.match(taskBoard, /entry\.mode === 'continuable'/);
	assert.match(taskBoard, /is not a continuable descendant of this task board's root/);
});
check('现有群成员由 sessionController.create 创建独立会话，不是 subagent 后代', () => {
	assert.match(roomsSrc, /const created = await sc\.create\(\{ \.\.\.place, \.\.\.\(agentPreset \? \{ agentPreset \} : \{\}\) \}\);/);
	assert.doesNotMatch(roomsSrc, /startActivation\(|header\.parentSession\s*=/);
});
check('官方 Team 适配器只读投影外部 Bot，不写任务、不转发消息', () => {
	assert.match(adapterSrc, /onMessage: \(\) => \(\{ received: 'filtered' \}\)/);
	assert.match(adapterSrc, /registerExternalBot\(/);
	assert.doesNotMatch(adapterSrc, /createTask\(|updateTask\(|send_message\(/);
});

if (failed.length) {
	console.error(`official-team-compat: ${checks.length} passed, ${failed.length} failed`);
	process.exit(1);
}
console.log(`official-team-compat: ${checks.length} passed; P1 gate=BLOCKED（当前独立成员会话不能直接共享官方任务板）`);
