/**
 * nodeDefinition - 节点定义自包含框架（2026-09-07）。
 *
 * ## 解决什么问题
 * 新增一个节点此前要改 8 处：registry 注册 NodeSpec、执行器文件 + runNodeOrStage
 * 分发链、NodeEditorPopup 的专用 RPC 分支、nodeCard 的引擎豁免等节点特定逻辑、
 * stageCardRegistry 卡片接管、LiteGraphCanvas 刷新、E2E 沙箱场景……任何一处遗漏
 * 都表现为「按钮没反应 / 走错执行路径 / 卡片不渲染」。
 *
 * ## 框架契约
 * 新增节点 = 1 个 definition 文件（spec + 执行器 + 声明式元数据一体）+ 在
 * nodes/index.ts 加一行 import（副作用注册）。各接缝（runNodeOrStage 分发 /
 * popup 通道 / 卡片豁免）改为查表，未命中走既有硬编码路径——存量节点零迁移，
 * 可渐进收编。
 */
import type { NodeSpec } from './registry.js';
import { registerNodeSpec } from './registry.js';
import type { NodeExecutionInput } from './workflowRunShared.js';
import type { SingleNodeRunResult } from './nodeExecutor.js';

/**
 * 双击弹窗（NodeEditorPopup）的专用 RPC 通道：
 *  - 'videoGen'   -> 注入 sendVideoGen（videogen.generate，600s）
 *  - 'imageGen'   -> 注入 sendImageGen（imagegen.generate，180s）
 *  - 'model3DGen' -> 注入 sendModel3DGen（modelgen.generate，600s）
 * 缺省 = 无专用通道，popup 走通用 runner.invoke 路径。
 */
export type PopupChannel = 'videoGen' | 'imageGen' | 'model3DGen';

export interface NodeDefinition {
	/** 全量形态：spec+run 同文件（注册进 registry）。 */
	spec?: NodeSpec;
	/** 轻量形态：节点 type（spec 仍在 registry 注册文件中）。 */
	type?: string;
	/**
	 * 执行器：runNodeOrStage 分发首位查表命中即调（优先于一切硬编码分支）。
	 * 能力注入语义与旧执行器完全一致（sendVideoGen/sendImageGen 等
	 * 仍由宿主按通道注入 NodeExecutionInput）。
	 */
	run: (input: NodeExecutionInput) => Promise<SingleNodeRunResult>;
	/**
	 * Provider 后端豁免：true = 该节点 values.backend==='provider' 时卡片不显示
	 * 「未连接引擎」、调度层不注入 ComfyUI runner（纯 RPC 通道，无 ComfyUI 依赖）。
	 */
	providerBackendExempt?: boolean;
	/** popup 双击运行的专用 RPC 通道（见 PopupChannel）。 */
	popupChannel?: PopupChannel;
}

const definitions = new Map<string, NodeDefinition>();

/** 注册节点定义（defineNode 内部调用；重复 type 以最后一次为准）。 */
export function registerNodeDefinition(def: NodeDefinition): void {
	definitions.set(def.type ?? def.spec?.type ?? "", def);
}

/** 全量形态：spec+run 同文件（新增节点的首选入口）。spec 同步注册进 registry。 */
export function defineNode(def: NodeDefinition): NodeDefinition {
	registerNodeDefinition(def);
	if (def.spec) { registerNodeSpec(def.spec); }
	return def;
}

/** 轻量形态：spec 留在 registry 注册文件，本定义只声明执行行为（存量收编）。 */
export interface RuntimeNodeDefinition {
	type: string;
	run: NodeDefinition["run"];
	popupChannel?: PopupChannel;
	providerBackendExempt?: boolean;
}

export function defineNodeRuntime(def: RuntimeNodeDefinition): RuntimeNodeDefinition {
	registerNodeDefinition({ ...def, spec: undefined } as NodeDefinition);
	return def;
}

/** 按节点 type 查定义（未注册返回 undefined -> 调用方走既有硬编码路径）。 */
export function getNodeDefinition(type: string): NodeDefinition | undefined {
	return definitions.get(type);
}

/** 已注册的全部定义（调试/测试用）。 */
export function getAllNodeDefinitions(): NodeDefinition[] {
	return [...definitions.values()];
}

/** 已注册定义的 type 列表（护栏校验用）。 */
export function getRegisteredDefinitionTypes(): string[] {
	return [...definitions.keys()];
}

/**
 * 必须具备执行分发的编排/控制流节点 —— 防「注册 type 拼错/漏注册」漂移的护栏。
 *
 * 由来（2026-09-09）：`gateNode.ts` 曾把 type 写成不存在的 `'Saros.Gate'`
 * （真名是 `Saros.IfElse` / `Saros.Switch`），`loopNode.ts` 漏了
 * `Saros.Parallel` —— 查表精确匹配，未命中就**静默**掉到 `runSingleNode`
 * 拿 ComfyUI runner 执行编排节点（runner 为 null 时崩、非 null 时报
 * node-not-found）。这类错误编译期无感、只在真跑控制流时炸，必须由护栏兜住。
 *
 * ⚠ 新增编排/控制流节点时，type 要同时出现在这里与 nodes/ 的 definition 文件。
 * 不含 `Saros.Start` / `Saros.Group` / `Saros.Subflow`：
 *  - Start 无副作用（args 契约由调度器直读，无需执行器）
 *  - Group 是纯布局容器
 *  - Subflow 在执行前被 flattenSubflows 展开，不会走单节点分发
 */
export const REQUIRED_RUNTIME_NODE_TYPES: readonly string[] = [
	'Saros.End', 'Saros.Task', 'Saros.Prompt', 'Saros.Agent', 'Saros.Skill', 'Saros.Tool',
	'Saros.IfElse', 'Saros.Switch', 'Saros.Merge', 'Saros.Loop', 'Saros.Parallel', 'Saros.AskUser',
];

/**
 * 校验 REQUIRED_RUNTIME_NODE_TYPES 全部已注册执行器。返回缺失的 type 列表
 * （空数组 = 健康）。Pure —— 供单测与画布初始化自检共用。
 */
export function findMissingRuntimeDefinitions(): string[] {
	return REQUIRED_RUNTIME_NODE_TYPES.filter(t => !definitions.has(t));
}
