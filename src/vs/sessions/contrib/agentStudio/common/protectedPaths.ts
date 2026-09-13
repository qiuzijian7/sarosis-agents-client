/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 受保护路径 —— **单一真源**（2026-09-13 从 `browser/toolExecutionGuard.ts` 抽到 `common/`）。
 *
 * ## 语义（fail-closed 重问，不是硬拒）
 *
 * 即便用户对某工具选过「始终允许 / 在工作区允许」，对这类路径的写入仍**一律重新弹审批** ——
 * 避免「一键放行」把仓库元数据（`.git`）或密钥 / 凭据的改写权也一并交出去。
 * 用户确实要改时点一次「允许」即可。
 *
 * ## 为什么抽到 `common/`
 *
 * 原判据只作用于**工具调用参数**里的路径（`getToolCallPathArg` 的 `path` / `file_path` / …），
 * 于是 **shell 命令字符串里的路径完全不在其中**：
 * 用户一旦「始终允许 terminal」，`echo x > .git/hooks/pre-commit` 就被静默放行
 * （下次 commit 执行任意代码）。要覆盖 shell 就必须让**纯函数侧**也能判定
 * （审批策略 `common/toolApprovalPolicy` 是纯模块），故抽到 `common/`。
 *
 * ## 为什么 `.vscode` 也在列
 *
 * 它是**安全相关**目录，三条独立理由：
 * 1. **历史上承载过本系统的授权表**（2026-09-13 已迁出）—— 当时「在工作区允许」经
 *    `ConfigurationTarget.WORKSPACE` 写进 `<workspace>/.vscode/settings.json`，
 *    不保护就能**被约束者改写约束**。该表现存 `~/.vssaros/tool-allow.json`
 *    （本项目数据一律放 `.vssaros/`，见 `sarosPaths`），但**本条保护保留** ——
 *    理由 ②③ 成立，且旧数据可能仍留在文件里。
 * 2. **承载安全开关** —— 同一文件里的 `chat.agent.sensitiveReadGuard` 可关闭读守卫
 *    （见 `sensitivePaths` 模块注释）。
 * 3. **可致代码执行** —— `.vscode/tasks.json` 能定义任意命令、在任务运行时装执行，
 *    与 `.git/hooks`（已在列）同一性质。
 */

/** 受保护的文件 / 目录**段名**（按路径段精确匹配）。 */
export const PROTECTED_EXACT_NAMES: ReadonlySet<string> = new Set<string>([
	'.git', '.env', '.npmrc', '.git-credentials', '.netrc',
	'id_rsa', 'id_ed25519', 'id_dsa', 'id_ecdsa', 'id_ecdsa_sk',
	'known_hosts', 'secrets', 'credentials',
	// `.vscode` 段 —— 安全相关目录，三条理由见模块头注释。
	'.vscode',
	// 本产品自己的数据目录 —— 与 `.vscode` 同级保护（2026-09-13「方案 C」）：
	// 二者承载**约束性数据**：`~/.vssaros/tool-allow.json`（工具授权表）、
	// `~/.vssaros/User/settings.json`、`<workspace>/.sarosworkspace/agents/*`（agent 定义）、
	// workflows、checkpoints、会话记录。模型能写它们就是「被约束者改写约束」——
	// 例如给自己加 terminal 授权、或改写 agent 的 systemPrompt。
	//
	// ⚠ 作用域说明：本判定只用于**模型发起的工具调用**（`toolExecutionGuard`），
	// 产品自身经 `IFileService` 读写这两个目录**不受影响**。代价是模型往
	// `<workspace>/.sarosworkspace/tmp/`（附件下载产物）写文件也会走审批 —— 这是有意的取舍：
	// 该目录整体是产品元数据，不做子目录例外，否则「保护名单」又会漂成两份。
	'.vssaros', '.sarosworkspace',
]);

/** 受保护的**文件名后缀**。 */
export const PROTECTED_SUFFIXES: readonly string[] = [
	'.pem', '.key', '.p12', '.keystore', '.jks', '.crt', '.cer',
	// `.code-workspace` 同样承载 settings，且可被「打开工作区」加载。
	'.code-workspace',
];

/**
 * 该路径是否命中受保护集合（按**路径段**精确匹配，规避 `.github` 误伤 `.git` 之类）。
 * 路径无法判定（空 / undefined）时返回 false —— 不误伤正常放行。
 */
export function isProtectedPath(p: string | undefined): boolean {
	if (!p) {
		return false;
	}
	const lower = p.toLowerCase().replace(/\\/g, '/');
	const segs = lower.split('/').filter(Boolean);
	for (const seg of segs) {
		if (PROTECTED_EXACT_NAMES.has(seg)) {
			return true;
		}
		if (PROTECTED_SUFFIXES.some(s => seg.endsWith(s))) {
			return true;
		}
		// .env.local / .env.production 等环境文件变体
		if (seg.startsWith('.env.') || seg === '.env') {
			return true;
		}
	}
	// 兜底：路径中任意处出现的 .git 目录（如 repo/.git/config）。
	// 注：与上面的段匹配语义上重叠（`.git/config` 的段 `.git` 已命中），保留是为了
	// **逐字保留**搬迁前的行为 —— 本次是纯搬迁，不夹带行为变更。
	return lower.includes('/.git/') || lower.endsWith('/.git') || lower === '.git';
}

/**
 * 从 shell 命令里取出**看起来像路径**的 token。
 *
 * 刻意只认「有路径形状」的 token（含分隔符 / 以 `.` `~` 开头 / 带受保护后缀），
 * 以免 `grep id_rsa src/` 这类**只提到名字**的命令被误判。
 *
 * ⚠ 已知取舍：`grep ~/.ssh/id_rsa` 这类**读**命令也会命中 → 多弹一次审批。
 * 这是**有意**的：`file_read` 对同一路径本就拒绝（读守卫），终端读同一路径理应同样受门控，
 * 而不是「换个工具就能读」。
 */
function commandPathTokens(command: string): string[] {
	// 按 shell 分隔符切分；引号只用于界定 token，不参与匹配。
	// **`=` 也要切** —— 否则选项式写法 `--git-dir=.git/config` 会成为一个 token，
	// 其路径段是 `--git-dir=.git`（不等于 `.git`）→ 漏判。
	// 刻意**不切 `:`** —— Windows 盘符 `C:\…` 会被切成两段。
	const raw = command.split(/[\s;|&()<>`"'=]+/).filter(Boolean);
	const out: string[] = [];
	for (const tok of raw) {
		const lower = tok.toLowerCase();
		if (
			tok.includes('/') || tok.includes('\\')
			|| tok.startsWith('.') || tok.startsWith('~')
			|| PROTECTED_SUFFIXES.some(s => lower.endsWith(s))
		) {
			out.push(tok);
		}
	}
	return out;
}

/**
 * shell 命令是否触及受保护路径。
 *
 * 用途：让 `ToolApprovalService` 的 `isProtected` 对 shell 工具也成立 ——
 * 否则「始终允许 terminal」会让写 `.git/hooks/*`、`.vscode/tasks.json` 的命令静默通过。
 */
export function commandTouchesProtectedPath(command: string | undefined): boolean {
	if (!command) { return false; }
	return commandPathTokens(command).some(t => isProtectedPath(t));
}
