// 守卫：**Agent 的生命周期必须寄生在 VsSaros app 上**（2026-10-28）。
//
//   node dsh-plugins/vssaros-relay/test/run-node-agent-lifecycle-check.mjs
//
// 需求（用户原话）：「Agent 客户端 要求启动 vssaros app 时才启动，关闭 app 时，
// 同时 关闭 agent 客户端」。
//
// 四条判据：
//   ① 主进程里有 Agent 宿主（`nodeAgentHost.ts`），且 main.ts 在**启动**与
//      **退出**两处都挂了它 ⇒ app 启则 Agent 启、app 关则 Agent 关 ✓；
//   ② **dsh Host 侧默认不起 Agent**（`agentEnabled: false`）
//      —— 因为 Host 是 keepAlive 的（活过 app 退出）⇒ 放在那里违背需求 ✗；
//   ③ 独立启动器**默认一次性**（不常驻）⇒ 不留「与 app 无关的常驻进程」；
//   ④ 实测：启动器跑完 `--seconds` 会**自己退出**（真行为，不是文本匹配）。

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); };

// ① 主进程侧
const hostPath = join(REPO, 'src', 'vs', 'sessions', 'contrib', 'dshHarness', 'electron-main', 'nodeAgentHost.ts');
check('主进程有 Agent 宿主模块', existsSync(hostPath), hostPath);
const hostCode = existsSync(hostPath) ? readFileSync(hostPath, 'utf8') : '';
check('宿主实现了 dispose（退出即停）', /dispose\(\)\s*\{/.test(hostCode) && /agent\?\.stop/.test(hostCode), '');
check('宿主复用插件那份 Agent 实现（不复制第二份）', /dsh-plugins.*vssaros-relay.*agent\.js/.test(hostCode), '');

const mainCode = readFileSync(join(REPO, 'src', 'vs', 'code', 'electron-main', 'main.ts'), 'utf8');
check('main.ts 在启动时起了 Agent', /nodeAgentHost\.start\(\)/.test(mainCode), '');
check('main.ts 在退出时停了 Agent', /onWillShutdown[\s\S]{0,600}nodeAgentHost\?\.dispose\(\)/.test(mainCode), '');

// ② Host 侧默认不起 Agent
const relayIndex = join(REPO, 'dsh-plugins', 'vssaros-relay', 'lib', 'index.js');
const relayCode = existsSync(relayIndex) ? readFileSync(relayIndex, 'utf8') : '';
check('插件默认不在 Host 里起 Agent（agentEnabled=false）', /agentEnabled:\s*false/.test(relayCode), '');
check('插件保留开关（可回退）', /agentEnabled/.test(relayCode), '');
check('插件的状态以中转站为准（channelConnected）', /channelConnected/.test(relayCode), '');

// ③ 独立启动器默认一次性
const launcher = join(REPO, 'scripts', 'run-node-agent.mjs');
const launcherCode = existsSync(launcher) ? readFileSync(launcher, 'utf8') : '';
check('启动器默认不常驻（--keep 才常驻）', /KEEP\s*=\s*args\.includes\('--keep'\)/.test(launcherCode), '');

// ④ 实测：跑一次启动器（--seconds 6）⇒ 它应当**自己退出**
let exited = false;
let output = '';
try {
	const run = spawnSync(process.execPath, [launcher, '--seconds', '6'], {
		cwd: REPO,
		encoding: 'utf8',
		timeout: 40_000,
	});
	exited = run.status === 0;
	output = `${run.stdout || ''}${run.stderr || ''}`;
} catch (error) {
	output = String(error);
}
check('启动器跑完会自己退出（不留常驻）', exited, output.slice(-200));

// 汇总
const failed = results.filter((r) => !r.ok);
for (const r of results) {
	console.log(`  ${r.ok ? '✓' : '✗'}  ${r.name}${r.ok ? '' : `  —— ${r.detail}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
