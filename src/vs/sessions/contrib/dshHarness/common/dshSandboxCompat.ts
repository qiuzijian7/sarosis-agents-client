/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * dsh 沙箱的**环境兼容**判据（纯函数；真正跑探针的 I/O 在 `electron-main/dshSandboxProbe.ts`）。
 * ⚠ 例外：`SANDBOX_FALLBACK_ROOT` 读一次 `os.homedir()`（唯一的"非纯"处 —— 它必须与 supervisor 的
 * `spawn(..., { cwd: homedir() })` 逐字同源，所以刻意**不**做成参数 ✗）。
 *
 * ## 为什么要有这套东西（2026-10-13 用户报障）
 *
 * dsh 默认把权限 preset 定成 `sandbox: workspace-write`（`@deepseek-ai/dsh-base/cordis.patch.yml:232`
 * 的 `sandbox-policy` 行），而它在 Windows 上映射到 `windows-acl` 档（`dsh-sandbox-local`：
 * `win32: ["windows-acl"]`）—— **每一次命令调用**都要先给工作区根写一次
 * `SetNamedSecurityInfoW(path, SE_FILE_OBJECT, 20 /* DACL | LABEL *\/, …, mergedAcl, labelAcl)`，
 * 即**同时**改 DACL 和 **Low 完整性标签**。
 *
 * 这台机器（安全策略/EDR）**禁止写完整性标签**：实测连自己新建、自己是所有者的目录，
 * `icacls <dir> /setintegritylevel Low` 都是 `Access is denied`（而写 DACL 是成功的）⇒ dsh 那次
 * 合并调用被整体拒绝 ⇒ 每个工具都报
 * `SetNamedSecurityInfoW failed (Win32 5): grantWrite(<workspace>)` ✗✗。
 * 更麻烦的是 runner 的设计是 **"The child is NEVER spawned unrestricted."** ⇒ 它**不会降级**，
 * 工具直接失败（用户看到的是一排报错，而 IDE 日志里连痕迹都没有 ✗）。
 *
 * ⚠ 而且这限制是**按路径**的（2026-10-13 实测）：`C:\Users\…\Temp` 下能写标签 ✓，
 * `G:\SarosWorkspace\…`（工作区所在卷/目录树）下**一律被拒** ✗（两个卷都是 NTFS、都是固定盘
 * ⇒ 差异不在文件系统类型）⇒ 探针**必须在真实工作区路径上跑**，否则给出"一切正常"的假阳性 ✗✗
 * （探针建在 `os.tmpdir()` 上时就是这样，实测抓到的 ✓）。
 *
 * ⇒ 启动时自己探一次（`probeLabelWriteOnce`），探不通就把沙箱模式降到
 * {@link SANDBOX_FALLBACK_MODE}（`danger-full-access`：文件沙箱不再限制，也就不再需要 ACL grant ✓）。
 *
 * ⚠ **只降沙箱、不动审批**：`approval` 行（`cordis.patch.yml:245`）读的是 `DSH_PERMISSION_MODE`
 * 环境变量，默认 `workspace-write` ⇒ `ask`。我们**不改那个环境变量** —— 一改，`approval` 会一起变成
 * `never` ✗✗（等于顺手把审批闸也拆了）。降级只经覆盖层打 `sandbox-policy` 这一行 ✓。
 */

import { homedir } from 'os';

/** `dsh-sandbox-policy` 的面板取值（`SANDBOX_MODES`，三选一）。 */
export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;

/** 探针探不通时的降级目标：不再需要 ACL grant（`dsh-sandbox-local` 只在 `workspace-write` 下发 grant ✓）。 */
export const SANDBOX_FALLBACK_MODE = 'danger-full-access';

/**
 * 探针要跑的 `icacls` 参数：在**临时目录**上试着打 Low 完整性标签。
 *
 * 为什么探"标签"而不是"整体"：dsh 是一次调用同时写 DACL + 标签 ⇒ 只要标签这半被拒，整步就失败 ✓。
 * 而写 DACL 在本机是**允许**的（实测）⇒ 探 DACL 会给出"能用"的假阳性 ✗。所以必须探**标签**这半 ✓。
 */
export function labelProbeArgs(dir: string): string[] {
	return [dir, '/setintegritylevel', 'Low'];
}

/**
 * 探针结果判读（纯，便于单测）：**非零退出 = 本机写不了完整性标签 ⇒ 沙箱不可用**。
 *
 * 口径取"宽"（任何失败都当作不可用）：沙箱不可用的代价是每个工具都报错 ✗✗，而降级过头的代价
 * 只是"本机本来也用不起来的沙箱没启用" ✗ —— 两者不对称，所以**宁可降级** ✓。
 * `detail` 会带 stderr（截断）写进日志，便于事后审计"到底为什么探不通" ✓。
 */
export function labelProbeVerdict(code: number | null, stderr: string): { ok: boolean; detail: string } {
	const err = String(stderr ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
	if (code === 0) {
		return { ok: true, detail: 'label write allowed' };
	}
	return { ok: false, detail: `icacls /setintegritylevel 失败（exit=${code === null ? 'null' : code}${err ? `, ${err}` : ''}）` };
}

/** 探针临时目录名前缀（建在系统临时目录下，用完即删；`mkdtemp` 会自动补随机后缀）。 */
export const LABEL_PROBE_DIR_PREFIX = 'vssaros-sandbox-probe-';

/**
 * 没有打开工作区文件夹时，**降级覆盖层**该写哪个根（2026-10-13 补的缺口）。
 *
 * 为什么会缺：`renderSandboxOverlay` 必须**同时**写 `mode` **和** `workspaceRoot`（`sandbox-policy`
 * 那行的 `config` 是**整体替换** ⇒ 只写 `mode` 会把 `workspaceRoot` 擦掉 ✗），所以渲染侧要求二者齐备；
 * 而主进程探针用的是 `workspaceRoot ?? process.cwd()` ⇒ **没工作区时"探针说要降级、覆盖层却什么都不发"** ✗✗
 * ⇒ 降级**静默失效** ⇒ 每条 `pwsh` 都被问一次"escalate sandbox"（用户报障的现场）。
 *
 * 取值依据：dsh 那行的默认 `workspaceRoot` 就是 **Host 进程的 `process.cwd()`**，而本壳起 Host 用的
 * `cwd` 是 `homedir()`（`dshHostSupervisor` 的 `spawn(..., { cwd: homedir() })`）⇒ 两者对齐取 `homedir()` ✓
 * ⇒ **探针路径 == 覆盖层写入的根** ✓（探针必须探"真实目标路径"，否则就是本文件开头记的那次假阳性 ✗）。
 *
 * ⚠ 只用于**沙箱降级**这一条（`config.sandboxMode` 存在时）：绝不能用它去顶 `config.workspaceRoot` ✗
 * —— 那个字段同时喂给**代码图谱**那行，顶上去会让图谱去读 `~/.codebase-memory`（空着且不报错 ✗✗）。
 */
export const SANDBOX_FALLBACK_ROOT = homedir();
