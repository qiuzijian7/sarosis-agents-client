// @vssaros/dsh-foundation — P0-3（2026-11-10）：把文件沙箱的**写根**从单根扩到工作区多根。
//
// ## 为什么是包装实例方法，而不是替换 provider
// 官方 `SandboxedFileSystem.checkedTarget(target, policy)`（dsh-fs-sandbox/lib/index.js:153）
// 是全部 mutation 的唯一围栏：writeText(:125) / editText(:139) 都只经它一道；它内部用
// `writableRoots(policy)` + 未导出的 `isPathUnder()` 做 canonical containment（含 Windows 8.3
// 与大小写身份回退）。`writableRoots(policy)` 只读 `policy.workspaceRoot`（dsh-sandbox/lib/index.js:166），
// 而 `SandboxPolicyService.resolve()` 返回的是**普通对象** `{mode, workspaceRoot, sessionId?}`。
//
// ⇒ 最安全的做法不是自己写 containment，也不是改 config（官方 Config 的 workspaceRoot 是 z.string()，
//   塞不下数组），而是：对每个显式声明的根，用**改写过 workspaceRoot 的 policy** 再调一次
//   官方原方法。全部拒绝时重抛**原始** FsError，保住 `FS_SANDBOX_DENIED` 与升级提示语义 ✓。
// ⇒ 用 `ctx.inject(['fs'], …)` 包住已注册服务实例（服务名 "fs"，dsh-fs/lib/index.js:60），
//   不改 cordis.patch.yml 的 `fs-sandbox` 行、不改插件加载顺序、可随插件卸载恢复 ✓。
//
// ## 不放宽的情形（fail-closed）
//   · `read-only` / `danger-full-access`：前者绝不放宽，后者原方法本就直接放行；
//   · foundation 没有根集 / 服务缺席 / 赋值不生效：完全回落官方单根行为；
//   · 目标不在任何**显式声明的根**里：重抛官方错（不引入父目录、不做词法近似）。
// ⚠ 本机沙箱已降级为 `danger-full-access`（dshSandboxCompat.ts）⇒ 真机看不出差别，
//   验收走**夹具 + in-process 断言**（见 check-host-config.mjs 的 A5 段），别指望真机现象。

/** 词法同根判据（只用于跳过重复尝试，不作安全边界；真正的判定永远在官方 checkedTarget 里 ✓）。 */
function sameRootPath(a, b) {
	const norm = p => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
	return norm(a) === norm(b);
}

/**
 * 把官方 `checkedTarget` 包成"多根逐个试"的版本。
 *
 * @param {Function} original 官方原方法（原型方法或自有方法均可，调用时 `this` 仍是 fs 实例）
 * @param {Function} getRoots 每次调用时取当前有序根集（`[{path,name,isPrimary}]`）——**不能快照**
 * @returns {Function} 替换用的 checkedTarget
 */
export function withMultiRootCheckedTarget(original, getRoots) {
	return async function checkedTarget(target, sandboxPolicy) {
		let primaryError;
		try {
			return await original.call(this, target, sandboxPolicy);
		} catch (e) {
			primaryError = e;
		}
		// 只在工作区写模式下放宽；拿不到 policy（假 ctx / 服务缺席）⇒ 一律重抛原始错 ✓
		let policy = sandboxPolicy;
		if (!policy) {
			try { policy = this?.ctx?.sandboxPolicy?.resolve?.(); } catch { policy = undefined; }
		}
		let roots = [];
		try { roots = typeof getRoots === 'function' ? getRoots() : []; } catch { roots = []; }
		if (!policy || policy.mode !== 'workspace-write' || !Array.isArray(roots) || roots.length === 0) {
			throw primaryError;
		}
		// ★ 每个根都交给**官方** containment 判定（resolve/realpath/8.3 回退一个不少）。
		//   跳过"与本次 policy.workspaceRoot 相同"的根 —— 它已在最上面用原始 policy 试过，再试只会
		//   多一次 realpath I/O；判据比的是 policy.root（= 会话 cwd / 配置根），不是 roots[0] ⇒
		//   会话 cwd 与工作区主根不同时不会误跳 ✓
		const primaryRoot = policy.workspaceRoot;
		for (const root of roots) {
			if (!root || typeof root.path !== 'string' || !root.path.trim()) { continue; }
			if (sameRootPath(root.path, primaryRoot)) { continue; }
			try {
				return await original.call(this, target, { ...policy, workspaceRoot: root.path });
			} catch {
				// 换下一个根；失败原因不吞掉主错误（全拒时仍抛官方那条 ✓）
			}
		}
		throw primaryError;
	};
}

/**
 * 把多根写围栏挂到 Host 的 `fs` 服务上。
 *
 * @returns {boolean} 是否发起了注入（真实生效还要看服务是否就绪、属性是否可写；守卫用假 ctx 断言）
 */
export function installMultiRootFs(ctx, service) {
	if (!ctx || typeof ctx.inject !== 'function' || !service || typeof service.workspaceRoots !== 'function') {
		return false;
	}
	try {
		ctx.inject(['fs'], child => child.effect(() => {
			const fs = child.fs ?? child.get?.('fs') ?? child.reflect?.get?.('fs', false);
			if (!fs || typeof fs.checkedTarget !== 'function') {
				console.warn('[vssaros-foundation] fs service unavailable, keep single-root sandbox');
				return () => { };
			}
			const original = fs.checkedTarget;
			const own = Object.prototype.hasOwnProperty.call(fs, 'checkedTarget');
			const patched = withMultiRootCheckedTarget(original, () => {
				try { return service.workspaceRoots(); } catch { return []; }
			});
			try {
				fs.checkedTarget = patched;
			} catch {
				return () => { }; // frozen / Proxy ⇒ 回落官方单根，不谎报成功 ✓
			}
			if (fs.checkedTarget !== patched) {
				return () => { }; // 赋值被吞掉（只读视图）⇒ 同上
			}
			return () => {
				if (fs.checkedTarget !== patched) { return; }
				if (own) { fs.checkedTarget = original; } else { delete fs.checkedTarget; }
			};
		}));
		return true;
	} catch {
		// 老 Host / 假 ctx 没有 inject ⇒ 与"这条能力不存在"完全一致 ✓
		return false;
	}
}
