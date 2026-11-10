/**
 * vssaros-memory — 多根工作区记忆作用域（P0 只读可见性，2026-11-10）。
 *
 * 设计纪律（对齐 @vssaros/dsh-foundation/lib/workspaceContext.js）：
 *   · 根集**只**从 foundation 的 `workspaceRoots()` 读（它已做主根去重/保序/带名），
 *     绝不自己拼 `[workspaceRoot, ...relatedRoots]`（老载荷 relatedRoots 全量含主根）。
 *   · foundation 缺席 / 从未推过上下文 ⇒ 返回 null（不猜、不回落旧 config）。
 *   · 物理分区键不变：项目记忆仍按会话 cwd 上溯 git 根的 hash（store.projectDirOf）。
 *     本模块只提供**展示与归属**信息，不写入路径、不改存储。
 *
 * 纯函数：无 I/O、无 cordis 依赖 ⇒ 守卫/单测可直接 import 造夹具 ✓。
 * @module vssaros-memory/workspace-scope
 */

/** Windows 下统一大小写与分隔符，便于路径包含判定。 */
function normPath(p) {
  const s = String(p ?? '').replace(/\//g, '\\')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/**
 * 判断 cwd 是否落在某个根内（含根本身），用路径分隔符边界避免 `/repo` 命中 `/repo2`。
 * @param {string} cwd
 * @param {string} root
 */
export function cwdUnderRoot(cwd, root) {
  const c = normPath(cwd).replace(/[\\/]+$/, '')
  const r = normPath(root).replace(/[\\/]+$/, '')
  if (!c || !r) return false
  return c === r || c.startsWith(r + '\\') || c.startsWith(r + '/')
}

/**
 * 从 foundation 服务派生当前会话的记忆作用域。
 * @param {object | undefined} foundation - cordis 服务 `vssarosFoundation`（可缺席）。
 * @param {string | undefined} cwd - 会话工作目录。
 * @param {{ workspaceKeyOf?: (cwd: string) => string }} [options]
 * @returns {{ workspaceId: string | null, roots: Array<{path:string,name:string,isPrimary:boolean}>,
 *             current: string | null, ambiguous: boolean, workspaceKey: string | null } | null}
 *   null ⇒ 没有运行期上下文（UI 降级为单根视图）。
 */
export function deriveMemoryScope(foundation, cwd, options = {}) {
  if (!foundation || typeof foundation !== 'object') return null
  let context
  let roots
  try {
    context = typeof foundation.workspaceContext === 'function' ? foundation.workspaceContext() : undefined
    roots = typeof foundation.workspaceRoots === 'function' ? foundation.workspaceRoots() : []
  } catch {
    return null // 服务未绑 / 探针假 ctx 抛错 ⇒ 降级，不让「读一眼根集」拖垮页面
  }
  if (!context) return null
  if (!Array.isArray(roots)) roots = []
  const normalized = roots
    .filter(r => r && typeof r.path === 'string' && r.path.trim())
    .map(r => ({ path: r.path, name: String(r.name || '').trim() || r.path.split(/[\\/]/).filter(Boolean).pop() || r.path, isPrimary: r.isPrimary === true }))
  const current = cwd ? (normalized.find(r => cwdUnderRoot(cwd, r.path))?.path ?? null) : null
  let workspaceKey = null
  try {
    const base = current ?? cwd
    if (base && typeof options.workspaceKeyOf === 'function') workspaceKey = options.workspaceKeyOf(base)
  } catch { /* 键计算失败不影响展示 */ }
  return {
    workspaceId: typeof context.workspaceId === 'string' ? context.workspaceId : null,
    roots: normalized,
    current,
    ambiguous: normalized.length > 1 && current === null,
    workspaceKey,
  }
}
