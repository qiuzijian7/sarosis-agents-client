// @vssaros/dsh-kb — 「上次打开的文档」纯逻辑（2026-11-11）
//
// 用户要求：初次打开知识库默认总览；下次启动 app 打开知识库时，自动恢复上次关闭时
// 打开的文档。落点在 `<kbRoot>/.kb-settings.json` 的 `lastDoc`（非机密，跨重启）。
//
// ⚠ 纯函数：不 import fs / 宿主服务，便于守卫直测。
// ⚠ 只记**文档**，总览 / 设置 / 图谱不是文档；记录失效（被删、改名、换库）由视图侧
//   校验树后清空，这里只负责把脏值挡在盘外。

/** 把任意输入收敛成合法的 `{ path, title, vaultId? }` 或 `null`。 */
export function sanitizeLastDoc(raw) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return null; }
	const path = String(raw.path ?? '').trim().slice(0, 500);
	// 拒 `..`（不允许把记录当路径穿越载体）、拒控制字符
	if (!path || path.includes('..') || /[\u0000-\u001f]/.test(path)) { return null; }
	const out = {
		path,
		title: String(raw.title ?? '').trim().slice(0, 200),
	};
	const vaultId = String(raw.vaultId ?? '').trim().slice(0, 100);
	if (vaultId && !vaultId.includes('..')) { out.vaultId = vaultId; }
	return out;
}
