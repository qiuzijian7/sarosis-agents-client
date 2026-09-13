/**
 * 节点定义（2026-09-07 框架化收编）：执行器/弹窗通道/引擎豁免声明式注册。
 * spec 注册仍在 registry（历史位置）；新节点请用 defineNode 全量形态（spec+run 同文件）。
 *
 * ★ 缺陷修复（2026-09-09 W7）：此前这里只注册了一个**不存在的类型**
 *   `'Saros.Gate'` —— registry 里的 gate 节点实际叫 `Saros.IfElse` /
 *   `Saros.Switch`（见 registrySaros.ts）。于是 `getNodeDefinition('Saros.IfElse')`
 *   永远查不到，`runNodeOrStage` 掉到末尾的 `runSingleNode` → 拿 runner 发
 *   ComfyUI 单节点请求 → `Cannot read properties of null (reading 'invoke')`。
 *   后果：**画布上的分支/多路控制流完全无法执行**（If/Else、Switch 必失败）。
 *   一个执行器对应多个 type 时必须逐个注册（查表是精确匹配，不做前缀/家族推断）。
 */
import { defineNodeRuntime } from '../nodeDefinition.js';
import { runGateNodeExecutor } from '../graphNodeExecutors.js';

/** `Saros.IfElse` — 二分支判定（true/false 端口路由）。 */
export const ifElseNode = defineNodeRuntime({
	type: 'Saros.IfElse',
	run: runGateNodeExecutor,
});

/** `Saros.Switch` — 多 case 判定（case-1..4 / default 端口路由）。 */
export const switchNode = defineNodeRuntime({
	type: 'Saros.Switch',
	run: runGateNodeExecutor,
});
