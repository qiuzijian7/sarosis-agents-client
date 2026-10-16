/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * dsh 沙箱的环境兼容判据 + **启动期探针的接线**（2026-10-13 用户报障后新增）。
 *
 * 现场：这台机器禁止写 Low 完整性标签（连自己新建的目录 `icacls /setintegritylevel Low` 都
 * `Access is denied`），而 dsh 默认的 `workspace-write` 在 Windows 上走 `windows-acl` 档 ——
 * **每次工具调用**都要 `setNamedSecurityInfoW(path, 1, 20, …)` 同时写 DACL + 标签 ⇒ 整步失败 ⇒
 * 一排 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(<workspace>)` ✗✗（runner 不降级）。
 * 修法：启动时探一次，探不通就把沙箱模式降成 `danger-full-access`（**只降沙箱、不动审批**）。
 *
 * 这里钉住：判据（含"口径取宽"的理由）、探针跑的是哪一半、以及**接线不被漂移**（探了必须用上）。
 */

import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { join } from '../../../../../base/common/path.js';
import { SANDBOX_FALLBACK_MODE, SANDBOX_FALLBACK_ROOT, SANDBOX_MODES, labelProbeArgs, labelProbeVerdict } from '../../common/dshSandboxCompat.js';
import { homedir } from 'os';

const SUP_REL = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts';
const HOST_CFG_REL = 'src/vs/sessions/contrib/dshHarness/common/dshHostConfig.ts';

function read(rel: string): string {
	const abs = join(process.cwd(), rel);
	assert.ok(existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
	return readFileSync(abs, 'utf8');
}

suite('dsh 沙箱兼容（启动期探针 + 降级）', () => {

	suite('判据（纯）', () => {
		test('非零退出 / 超时（code=null）= 写不了标签 ⇒ 沙箱不可用；exit=0 才可用', () => {
			assert.strictEqual(labelProbeVerdict(0, '').ok, true);
			const bad = labelProbeVerdict(1, 'G:\\x: Access is denied.\n');
			assert.strictEqual(bad.ok, false);
			assert.match(bad.detail, /Access is denied/, 'stderr 必须带进 detail（事后审计"为什么探不通"）');
			assert.strictEqual(labelProbeVerdict(null, '').ok, false, '被杀/超时（code=null）也按不可用 —— 口径取宽');
		});

		test('探针探的是"写 Low 完整性标签"这一半（探 DACL 会给假阳性）', () => {
			// 本机实测：写 DACL 成功、写标签被拒 ⇒ 只探 DACL 会判"可用"，而 dsh 的合并调用照样失败 ✗
			assert.deepStrictEqual(labelProbeArgs('C:\\tmp\\x'), ['C:\\tmp\\x', '/setintegritylevel', 'Low']);
		});

		test('降级目标是 danger-full-access（且确实是 dsh 的合法模式之一）', () => {
			assert.ok((SANDBOX_MODES as readonly string[]).includes(SANDBOX_FALLBACK_MODE), '必须是 dsh-sandbox-policy 认识的值');
			assert.strictEqual(SANDBOX_FALLBACK_MODE, 'danger-full-access', '只有它不再需要 ACL grant（workspace-write 才发 grant）');
		});
	});

	suite('接线守卫（源码级）', () => {
		test('★ 启动路径必须探一次，且结论必须接进覆盖层（探了不用 = 白探）', () => {
			const sup = read(SUP_REL);
			// ⚠ 参数**必须是真实工作区路径**：首版探在 `os.tmpdir()` 上 ⇒ 本机返回 ok=true（假阳性）✗✗，
			// 而 dsh 要写的是工作区路径、那里写标签被拒 ⇒ 探了等于没探（实测抓到 ✓）。
			assert.match(sup, /const sandboxProbeRoot = workspaceRoot \?\? SANDBOX_FALLBACK_ROOT;[\s\S]{0,200}?await probeLabelWriteOnce\(sandboxProbeRoot\)/,
				'`_doStart` 里要探一次，且探的是**真实目标路径**（缓存由探针模块按路径负责）');
			// ⚠ 2026-10-13 起这段是**多行**的（降级时要顺带给"沙箱专用根"，见下一条测试 ✓）
			// ⇒ 正则必须容得下换行；旧写法是单行的 `sandboxFallback ? { sandboxMode: … }` ✗
			//（改动当天它当场变红 ⇒ 这条守卫是活的 ✓）。
			assert.match(sup, /sandboxFallback \? \{[\s\S]{0,240}?sandboxMode: SANDBOX_FALLBACK_MODE/,
				'结论必须进 hostConfig');
			assert.match(sup, /case 'sandbox': this\._sandboxOverlayFile = file; break;/, '覆盖层要登记，否则 run 目录里留垃圾');
			assert.match(sup, /this\._sandboxProbeLogged = true;/, '失败说明只 warn 一次（Host 会被反复重启）');
		});

		test('★ 降级必须带上"沙箱行的根"，且**探针与覆盖层同源**（静默失效＝本次报障现场）', () => {
			const cfg = read(HOST_CFG_REL);
			// 本用例要用 supervisor 源码：上面那条用例里的 `sup` 是**它自己的**局部变量 ✗
			// （漏了这一行 ⇒ `Cannot find name 'sup'`，整份 tsgo 红 ✗ —— 2026-10-13 补上）
			const sup = read(SUP_REL);
			// ① 渲染侧：优先**沙箱专用根**，其次 workspaceRoot；**绝不允许只写 `mode`** ✗
			//    （`sandbox-policy` 那行的 config 是**整体替换** ⇒ 只写 mode 会把 workspaceRoot 擦掉 ✗）
			assert.match(cfg, /const sandboxRoot = trimmed\(config\.sandboxWorkspaceRoot\) \?\? workspaceRoot;/,
				'沙箱行取根的先后：sandboxWorkspaceRoot ⇒ workspaceRoot');
			assert.match(cfg, /if \(sandboxMode && sandboxRoot\) \{/, '有沙箱模式 + 有任一根 ⇒ 才渲染（不许只写 mode ✗）');
			assert.match(cfg, /kind: 'sandbox'/, '覆盖层种类要接上（否则文件名/日志都对不上）');
			// ② 主进程：没有工作区时，探针与覆盖层**必须同源** ✓
			//    （不同源 ⇒ 探的是 A、dsh 要写的是 B ⇒ 假阳性/假阴性都可能 ✗ —— 首版探 `os.tmpdir()` 就是这么栽的 ✓）
			assert.match(sup, /sandboxFallback \? \{[\s\S]{0,200}?sandboxWorkspaceRoot: SANDBOX_FALLBACK_ROOT/,
				'降级时要补沙箱专用根，否则渲染侧条件不成立 ⇒ 降级静默失效 ✗✗');
			// ③ 反向断言：**不许**拿兜底根去顶 `config.workspaceRoot` ✗
			//    那个字段同时喂给代码图谱那行 ⇒ 顶上去会让图谱去读 `~/.codebase-memory`（空着且不报错 ✗✗）
			assert.ok(!/workspaceRoot: SANDBOX_FALLBACK_ROOT/.test(sup),
				'兜底根只能进 sandboxWorkspaceRoot，绝不能顶 workspaceRoot（图谱会去读 ~ ✗）');
		});

		test('兜底根 = `os.homedir()`（与 supervisor 的 `spawn(..., { cwd: homedir() })` 逐字同源）', () => {
			// 为什么钉这条：dsh 那行的默认 `workspaceRoot` 就是 **Host 进程的 `process.cwd()`**，
			// 而本壳起 Host 的 cwd 是 `homedir()` ⇒ 兜底根必须取同一个值，否则"探的路径 ≠ 要写的路径" ✗。
			assert.strictEqual(SANDBOX_FALLBACK_ROOT, homedir());
			assert.match(read(SUP_REL), /cwd: homedir\(\)/, 'supervisor 起 Host 的 cwd 变了 ⇒ 兜底根要跟着改');
		});
	});
});
