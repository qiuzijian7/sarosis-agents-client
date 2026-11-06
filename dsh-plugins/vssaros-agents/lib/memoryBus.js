// @vssaros/dsh-agents — 进程内的记忆总线（2026-11-04，superagent v2 P4）
//
// ── 为什么要它 ──────────────────────────────────────────────────────────────
// superagent 的团队工单里，每个步骤由一个 bot 完成。步骤结束后要把「执行证据」交给记忆系统沉淀：
// bot 记忆在本插件里（lib/memory.js），所以由本插件提供。superagent 只交证据、不写文件。
//
// ── 形状（跨插件契约，只增不改；新增方法时**换新 version**，见下）──────────────
//   globalThis[Symbol.for('vssaros.memory')] = {
//     version: 1,
//     available()                       → 本插件是否已提供实现
//     rememberStep(evidence)            → Promise<RememberResult>   见 lib/stepMemory.js
//     decideSkillDraft(name, decision)  → Promise<{name, state}>    'approve' 把草稿转正，'reject' 删除草稿
//     provide(impl)                     → 只给本插件自己用
//   }
//   与 teamBus.js 同一做法：挂在 globalThis，消费者不依赖本包，HMR 重载不丢。
//   注意：已存在的总线对象会被复用（version 相同就不重建），所以**新方法不会出现在旧对象上**；
//   要加方法就新开 version 2 的对象，并保留 version 1 的方法。

const KEY = Symbol.for('vssaros.memory');

/** 取（或建）进程内记忆总线。`root` 只给单测注入。 */
export function memoryBus(root = globalThis) {
	const cur = root[KEY];
	if (cur && cur.version === 1) { return cur; }
	let impl = null;
	const need = () => {
		if (!impl) { throw new Error('VsSaros 记忆系统还没就绪（Host 正在启动，或没装 @vssaros/dsh-agents）'); }
		return impl;
	};
	const bus = {
		version: 1,
		available: () => !!impl,
		provide(next) {
			if (!next || typeof next.rememberStep !== 'function') { return () => undefined; }
			impl = next;
			return () => { if (impl === next) { impl = null; } };
		},
		rememberStep: async (evidence) => need().rememberStep(evidence),
		decideSkillDraft: async (name, decision) => need().decideSkillDraft(name, decision),
	};
	Object.defineProperty(root, KEY, { value: bus, configurable: true, enumerable: false, writable: false });
	return bus;
}
