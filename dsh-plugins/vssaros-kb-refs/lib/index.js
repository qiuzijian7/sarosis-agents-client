// @vssaros/dsh-kb-refs — host half, intentionally inert.
//
// 全部工作都在浏览器半边（`./client`）：它把 `@知识库` 这个 source 注册进 dsh 的输入触发流水线
// （`ctx.inputTriggers.registerSource`），候选走**同源 HTTP** 打 kb 插件既有的只读路由。
// Host 侧不需要任何东西：本插件不注册工具、不开路由、不读数据根 ✓。
export const name = 'vssaros-kb-refs';

export function apply() {
	// no-op: 见文件头。为什么保留一个空 apply —— 与 chat-surface 同一约定：
	// loader 要求包有可挂载的入口，真正的行为在 client 半边 ✓。
}
