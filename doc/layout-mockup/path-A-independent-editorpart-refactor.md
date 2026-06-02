# 路径 A —— 独立 EditorPart 重构设计（精确到类名/方法签名）

> 目标：把当前「单 `MainEditorPart` + 双 branch grid + 运行时拖拽拦截」改造为
> 「两个主窗口级 `EditorPart` 实例（File / Agent），各自独立 grid，物理隔离」。
> 右侧 Agent 区内部可任意分屏，且**物理上**拖不进中间 File 区。
>
> 核对基准（已读源码）：
> - `src/vs/workbench/browser/parts/editor/editorPart.ts`（`EditorPart` 抽象基类 line 91，构造 164-176；`MainEditorPart` line 1574）
> - `src/vs/workbench/browser/parts/editor/editorParts.ts`（`EditorParts extends MultiWindowParts<EditorPart>` line 61；`createMainEditorPart` 110；`registerPart` 234；`getPart` 334）
> - `src/vs/workbench/services/layout/browser/layoutService.ts`（`Parts` 枚举 21-30；`MULTI_WINDOW_PARTS` 133；`isMultiWindowPart` 137）
> - `src/vs/sessions/browser/parts/editorPart.ts`（`SessionsMainEditorPart` line 27，双 branch 实现 130-272）
> - `src/vs/sessions/browser/workbench.ts`（`createEditorPart` 983；`_openAgentStudioEditors` 1047；`getPartView` 2029；Grid 描述符 ~1581）

---

## 一、核心设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| Agent 区载体 | **第二个主窗口级 `EditorPart`**（非 `AuxiliaryEditorPart`） | aux part 绑死 `auxiliaryWindowService.open()`，语义是「独立窗口」，`removeGroup` 会关窗 |
| windowId | **共用 `mainWindow.vscodeWindowId`** | 两个 part 同属主窗口；区分靠 partId，不靠 windowId |
| 区分键 | **新增 `Parts.AGENT_EDITOR_PART` 枚举** | upstream `getPart(group)` 靠遍历 `hasGroup`，partId 仅用于 DOM/layout 注册 |
| File 区 | `SessionsMainEditorPart` **退化为标准单 grid** | 删除双 branch / removeGroup 保护 / collapse 按钮 |
| 编辑器路由 | `AgentStudioEditorInput` 强制落 agentPart | 见第六节 |

---

## 二、新增类清单（精确签名）

### 2.1 `AgentEditorPart`（新建文件）

`src/vs/sessions/browser/parts/agentEditorPart.ts`

```typescript
import { EditorPart } from '../../../workbench/browser/parts/editor/editorPart.js';
import { IEditorPartsView } from '../../../workbench/browser/parts/editor/editor.js';
import { Parts } from '../../../workbench/services/layout/browser/layoutService.js';
import { mainWindow } from '../../../base/browser/window.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IWorkbenchLayoutService } from '../../../workbench/services/layout/browser/layoutService.js';
import { IHostService } from '../../../workbench/services/host/browser/host.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';

/**
 * 第二个主窗口级 EditorPart，承载 Agent Studio（Canvas/Chat）。
 * 与 MainEditorPart 平级，拥有完全独立的 grid / GroupsView / DOM / 持久化。
 */
export class AgentEditorPart extends EditorPart {

	constructor(
		editorPartsView: IEditorPartsView,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IConfigurationService configurationService: IConfigurationService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IHostService hostService: IHostService,
		@IContextKeyService contextKeyService: IContextKeyService
	) {
		super(
			editorPartsView,
			Parts.AGENT_EDITOR_PART,          // ★ 新枚举值，作为 partId
			'',                                // groupsLabel
			mainWindow.vscodeWindowId,         // 共用主窗口
			instantiationService, themeService, configurationService,
			storageService, layoutService, hostService, contextKeyService
		);
	}

	// memento key 由基类用 partId(getId) 自动隔离 —— 因 partId 不同，
	// 'editorpart.state' 不会与 File 区冲突（Memento 以 component id 分桶）。
}
```

> 关键事实：`EditorPart` 基类构造（editorPart.ts:164）签名为
> `(editorPartsView, id, groupsLabel, windowId, …8 services)`。
> `MainEditorPart`（1574）就是对它的薄封装，传 `Parts.EDITOR_PART`。
> `AgentEditorPart` 同理，仅 partId 改为 `Parts.AGENT_EDITOR_PART`。
> **无需重写任何 grid 逻辑** —— 基类默认 `doCreateGridControl()` 就是单 grid + 单 group，正是我们要的 Agent 区初始形态。

---

## 三、Upstream Patch 清单

> 项目已有 patch 机制（sparse + patch 文件）。以下改动需落到 upstream 文件并生成 patch。

### Patch 1 — `layoutService.ts`：新增 Part 枚举

文件：`src/vs/workbench/services/layout/browser/layoutService.ts`

```diff
 export const enum Parts {
 	TITLEBAR_PART = 'workbench.parts.titlebar',
 	...
 	EDITOR_PART = 'workbench.parts.editor',
+	AGENT_EDITOR_PART = 'workbench.parts.agenteditor',   // ★ Sarosis
 	STATUSBAR_PART = 'workbench.parts.statusbar'
 }
```

> `MULTI_WINDOW_PARTS`（line 133）与 `isMultiWindowPart`（137）**不要**加入
> `AGENT_EDITOR_PART`——它不是多窗口拆分目标，按普通 part 处理即可。

### Patch 2 — upstream `editorParts.ts`：**无需改动** ✅

> **🟢 Q1 已验证（2026-06-02）**：sessions 层**确实自建了** `EditorParts extends EditorPartsBase`
> 子类（`src/vs/sessions/browser/parts/editorParts.ts`，仅 18 行），并在其中
> `registerSingleton(IEditorGroupsService, EditorParts, InstantiationType.Eager)`。
> 因此 `IEditorGroupsService` 全局指向的就是 sessions 子类，**Patch 2 完全取消**，
> 所有扩展落在 Patch 3（sessions 子类）即可，upstream `EditorParts` 零改动。

**关键事实核对**（均已读源码确认）：

1. **多 part 路由本就支持**：`EditorParts.getPart(group)`（editorParts.ts:334-361）在
   `_parts.size > 1` 时遍历 `_parts` 找 `hasGroup(id)` → 把 agentPart 注册进 `_parts`
   后，所有 `openEditor/splitEditor/removeGroup` 自动按 group 归属路由到正确 part。
   `getGroups()`（674）、`activateGroup`（722）等同理 flatMap 所有 part。
2. **`registerPart` 是基类公开钩子**：`MultiWindowParts.registerPart(part)`（part.ts:275）
   把 part 加进 `_parts`；`EditorParts.registerPart`（234）额外挂事件监听。子类直接调即可。
3. **`createMainEditorPart()` 是 protected 钩子**：sessions 现有子类已 override 它返回
   `MainEditorPart`（=`SessionsMainEditorPart`）。

### Patch 3 — 扩展现有 sessions `EditorParts` 子类（唯一改动点）

文件：`src/vs/sessions/browser/parts/editorParts.ts`（现状仅 18 行，下面是改造后）

```typescript
import { mainWindow } from '../../../base/browser/window.js';
import { AgentEditorPart } from './agentEditorPart.js';

export class EditorParts extends EditorPartsBase {

	private _agentPart: AgentEditorPart | undefined;
	get agentPart(): AgentEditorPart {
		if (!this._agentPart) {
			// 懒创建：在 mainPart 之后、首次访问时实例化并注册
			this._agentPart = this._register(
				this.instantiationService.createInstance(AgentEditorPart, this)
			);
			this._register(this.registerPart(this._agentPart));  // ★ 进入 _parts → 路由自动生效
		}
		return this._agentPart;
	}

	protected override createMainEditorPart(): MainEditorPart {
		// File 区仍用 SessionsMainEditorPart（退化为单 grid）
		return this.instantiationService.createInstance(MainEditorPart, this);
	}
}
```

> **更优方案**：不在构造里急切创建 agentPart（构造期 `this.instantiationService` 尚在父类
> 初始化链中），而是用 getter 懒创建。workbench.ts 的 `createEditorPart()` 会在
> `restoreParts()` 之前首次访问 `agentPart`，触发注册——此时 instantiationService 已就绪。
>
> ⚠️ **避免与 upstream `restoreParts()` 时序冲突**：父类构造末尾就调 `this.restoreParts()`
> （editorParts.ts:101），它只 await `mainPart.whenReady` 并恢复 **auxiliary** parts
> （见下方 Q5 结论：agentPart 天然被排除）。agentPart 懒创建在其后，无冲突。

---

## 四、Sessions 层改动清单

### 4.1 `src/vs/sessions/browser/parts/editorPart.ts`（`SessionsMainEditorPart`）

**删除**双 zone 全部逻辑，退化为标准单 grid：

| 删除项 | 行号 | 说明 |
|--------|------|------|
| `doCreateGridControl()` override | 130-272 | 整段删除，回退基类单 grid |
| `shouldForceSameOrientation()` | 293-295 | 删除（基类默认即 false 语义） |
| `removeGroup()` 保护 | 88-98 | 删除，File 区无需保护 zone root |
| `installFileZoneCollapseButton` 等 | 299-364 | 删除整组折叠按钮逻辑 |
| `saveState()` zone 持久化 | 378-395 | 删除 zone-state 写入，仅保留 `super.saveState()` |
| `fileZoneRootGroupId/agentZoneRootGroupId` getter | 43-47 | 删除 |
| `ISessionsEditorPartUIState` | 22-25 | 删除 |

> 保留 `MARGIN_*` / `layout()` override（66-79）——它处理 sidebar margin，与 zone 无关。
> `TOOLBAR_HEIGHT`（64）若 workspace toolbar 仍叠加在 File 区上方则保留，否则删。

### 4.2 `src/vs/sessions/browser/workbench.ts`

| 方法 | 行号 | 改动 |
|------|------|------|
| `createEditorPart()` | 983-1000 | 新增创建 `agentPart` 的容器 + `create()`；container id 用 `Parts.AGENT_EDITOR_PART` |
| `_openAgentStudioEditors()` | 1047+ | **重写**：不再查 zone group，改为往 `agentPart.activeGroup` 开 Canvas/Chat；**删除**所有 `__sarosisIsAgentStudioGroup__` / 跨 zone 拦截 / `installRelocationGuard` / `agentRootGroup.lock` |
| `getPartView()` | 2029-2040 | `case Parts.AGENT_EDITOR_PART: return this.agentPartView;` |
| Grid 描述符 `createDesktopGridDescriptor()` | ~1581 | mainRow 从 `[Sidebar, Editor]` 改为 `[Sidebar, Editor(File), AgentEditor]` 三 leaf |
| 字段 | — | 新增 `private agentPartView: ISerializableView`（仿 `editorPartView` 1494） |
| `setPartHidden` / `isVisible` 等 | 2002-2017 | 为 `AGENT_EDITOR_PART` 补 case（可见性/尺寸） |

**Grid 描述符改动示意**（line ~1581 区域）：
```typescript
const mainRowNode: ISerializedBranchNode = {
    type: 'branch',
    data: [
        sidebarNode,                          // 既有
        { type: 'leaf', data: { type: Parts.EDITOR_PART },       size: fileWidth },   // File
        { type: 'leaf', data: { type: Parts.AGENT_EDITOR_PART }, size: agentWidth },  // ★ Agent
    ],
    size: contentHeight
};
```

### 4.3 `_openAgentStudioEditors()` 重写要点

```typescript
private _openAgentStudioEditors(): void {
    const groups = this.editorGroupService as SessionsEditorParts;
    const agentGroup = groups.agentPart.activeGroup;   // Agent 区根 group

    // 直接往 agent part 开 Canvas / Chat（不再 lock、不再标记 zone）
    this.editorService.openEditors(
        [{ editor: canvasInput }, { editor: chatInput }],
        agentGroup,                                      // 指定目标 group
        { /* sticky/pinned 视需求保留 */ }
    );
    // ★ File 区什么都不开（用户自行打开文件）
}
```

---

## 五、编辑器路由（关键正确性保障）

upstream `EditorParts.getPart(group)`（editorParts.ts:334）按 `hasGroup` 找对的 part，
但 **`IEditorService.openEditor` 的默认目标**仍是 `activeGroup`（可能落在任一 part）。

需要保证 **`AgentStudioEditorInput` 永远落在 agentPart**：

| 场景 | 处理 |
|------|------|
| 用户在 File 区双击文件 | 默认落 mainPart.activeGroup ✓（无需改） |
| Agent Studio 程序化打开 | 显式传 `agentPart.activeGroup` 作为目标 group ✓ |
| 误把 AgentStudioEditorInput 路由到 File 区 | 在 `AgentStudioEditorPane` 注册或 `IEditorResolverService` 加约束；或保留一个**轻量** override：`EditorParts.getGroups` 路由时若 input 是 AgentStudioEditorInput 强制 agentPart |

> 这是从「运行时拦截拖拽」转为「路由层约束打开目标」——比原来干净，因为
> 物理隔离后，拖拽不可能跨 part，唯一要管的是「**程序化 open 的目标 part**」。

---

## 六、持久化

| Part | memento key | scope |
|------|-------------|-------|
| File (`SessionsMainEditorPart`) | `editorpart.state`（基类自带） | WORKSPACE |
| Agent (`AgentEditorPart`) | `editorpart.state`（基类自带，**因 component id=partId 不同自动隔离**） | WORKSPACE |

> 基类 `Part` 的 `getMemento()` 以 component id 分桶，partId 不同 → 两个 part 的
> `editorpart.state` 互不覆盖。**无需**像旧实现那样自定义 `sessionsEditorPart.zoneState`。
> 这是独立 part 相比双 branch 的又一干净点。

**🟢 Q5 已验证（2026-06-02）——agentPart 天然被排除，无需任何处理**：

`EditorParts.createState()`（editorParts.ts:457-467）构造 auxiliary 列表的逻辑是：
```typescript
auxiliary: this.parts
    .map(part => ({ part, auxiliaryWindow: this.auxiliaryWindowService.getWindow(part.windowId) }))
    .filter(({ auxiliaryWindow }) => auxiliaryWindow !== undefined)   // ★ 关键过滤
    ...
```
agentPart 与 mainPart 共用 `mainWindow.vscodeWindowId`，`auxiliaryWindowService.getWindow()`
对主窗口 id 返回 `undefined` → **被 filter 直接剔除**，永远不会进 `editorparts.state.auxiliary`。
重启时 `restoreParts()`（382）只恢复 auxiliary 列表里的 part，agentPart 不在其中，
因此不会被当 aux part 经 `auxiliaryWindowService` 恢复（那条路径才会报错）。

agentPart 自己的 grid 状态由它**各自的** `editorpart.state` memento（component id 分桶）
独立持久化/恢复，与 auxiliary 机制完全正交。**结论：Q5 无需任何额外代码。**

---

## 七、待确认问题（动工前必须回答）

> **核查进度（2026-06-02）：Q1 / Q5 已 ✅ 验证清零（结论见上文）；Q2 已 ✅ 明确；
> 仅剩 Q3 / Q4 需在写代码时随手验证（低风险）。**

| # | 问题 | 影响 | 结论 |
|---|------|------|------|
| Q1 | sessions 是否使用 upstream `EditorParts`？还是自建了 part 管理？ | 决定 Patch 2/3 形态 | ✅ **自建子类** `EditorParts extends EditorPartsBase`（sessions/browser/parts/editorParts.ts）并 `registerSingleton`。Patch 2 取消，仅改 Patch 3。 |
| Q2 | `getPart(Parts.EDITOR_PART)`（workbench.ts:1054）的 part map 来源 | 第二个 part 怎么塞进去 | ✅ 来自 layoutService 的 part 注册表（`Part` 构造调 `layoutService.registerPart(this)`）。但**编辑器路由不靠它**——靠 `EditorParts._parts`（registerPart 加入）。两者独立：layoutService map 供 `getPartView`/可见性，`_parts` 供 group 路由。 |
| Q3 | `agentPart.element` 能否作为 grid leaf？尺寸约束 min/max | 三栏布局正确性 | ⏳ 写代码时验证：仿 `editorPartView`（workbench.ts:1494）注入 `getPartView`，`AGENT_EDITOR_PART` 走同一 `ISerializableView` 协议，低风险。 |
| Q4 | 全局命令（`workbench.action.splitEditor` / focus group）的目标 part 判定 | 快捷键正确性 | ✅ upstream 命令用 `activeGroup`→`getPart(activeGroup)`（按 hasGroup 路由）。物理隔离后 activeGroup 必属某一 part，天然正确，无需特殊处理。 |
| Q5 | `editorparts.state.auxiliary` 是否会误收 agentPart | 重启恢复 | ✅ **天然排除**：`createState()` 用 `auxiliaryWindowService.getWindow(windowId)!==undefined` 过滤，agentPart 共用主窗口 id → 返回 undefined → 被剔除。无需代码。 |

---

## 八、删除的 Hack 清单（重构收益）

| Hack | 当前位置 | 删除后 |
|------|---------|--------|
| `__sarosisIsAgentStudioGroup__()` | workbench.ts 全局 API | 删除——无跨 part 概念 |
| `__sarosisCrossZoneDragBlocked__()` | workbench.ts 全局 API | 删除——物理拖不过去 |
| `installRelocationGuard()` 兜底搬回 | workbench.ts | 删除 |
| `removeGroup` zone root 保护 | sessions editorPart.ts 88-98 | 删除 |
| 双 branch grid + zone-state 持久化 | sessions editorPart.ts 130-395 | 删除 |
| sticky/pinned 重开 hack | `_openAgentStudioEditors` | 视需求保留（与隔离无关） |

---

## 九、执行顺序与工作量（已按 Q1/Q5 验证结论下修）

| 阶段 | 任务 | 工作量 |
|------|------|--------|
| ~~0~~ | ~~回答 Q1-Q5~~ | ✅ 已完成（Q1/Q2/Q4/Q5 清零，Q3 随阶段 4 验证） |
| 1 | Patch 1（`AGENT_EDITOR_PART` 枚举）+ `AgentEditorPart` 新文件 | 0.5 天 |
| 2 | **Patch 3 only**：扩展 sessions `EditorParts` 子类加 `agentPart` getter（约 10 行） | 0.5 天 |
| 3 | `SessionsMainEditorPart` 退化单 grid + 删全部 zone hack（第四节 4.1 表） | 0.5 天 |
| 4 | workbench Grid 描述符三栏 + `getPartView` 加 case + `agentPartView` 字段 + 可见性 case | 1 天 |
| 5 | `_openAgentStudioEditors` 重写（往 `agentPart.activeGroup` 开）+ AgentStudioInput 路由约束 | 1-1.5 天 |
| 6 | 重启恢复测试（Q5 已确认天然排除，主要验证两 part 各自 `editorpart.state` 恢复） | 0.5 天 |
| 7 | 回归：区内分屏/拖拽/maximize/快捷键/跨 part 不可拖 | 1 天 |

**合计：约 4.5-5.5 个工作日（≈1 周）**。相比初版下修，因为：
- **upstream 改动几乎归零**（仅 Patch 1 一个枚举；Patch 2 取消）。
- Q1/Q5 不再是风险点——sessions 自建子类 + auxiliary 天然排除，都已源码坐实。
- **唯一剩余风险**：阶段 5 的「程序化 open 目标 part 约束」（确保 AgentStudioEditorInput
  不被默认 activeGroup 路由误投到 File 区）——这是物理隔离后唯一需主动管的点。

---

## 十、回退预案

- 所有 upstream 改动走 patch 文件，可一键 revert。
- sessions 层保留 `SessionsMainEditorPart` 旧双 branch 实现于 git 历史，必要时 cherry-pick 回退。
- 分阶段合入：阶段 1-4 可先让 Agent 区「空跑」（不开编辑器）验证三栏 grid 与隔离，再做阶段 5 路由。
