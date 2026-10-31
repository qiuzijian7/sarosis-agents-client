---
name: ue-blueprint-graph
description: 通过 Python + S1Editor 里的 C++ 桥操控 UE5 Blueprint 事件图/函数图。先用 unreal_dump 导出 CDO 全貌（json1 属性视图 + json2 序列化视图），再深入图节点操作。含能力地图、桥 API、Recipe、扩展方法。
displayName: "UE5 Blueprint Graph 操控技能"
---

# UE5 Blueprint Graph 操控技能

操控 UE5 Blueprint 的**图**（事件图 EventGraph、函数图）：节点、引脚、连线、变量读写节点。
一部分能力 Python 原生就能做；**图里的节点/引脚**这类 Python 反射够不到的，走一个已编译进
`S1Editor` 的 C++ 桥 `UBlueprintGraphBridge`（常用能力都已实现，见 §1/§3）。

---

## 0. 定位 & 与 `ue-blueprint-components` 的分工

一个 Blueprint = **组件树 (SCS)** + **图 (事件图/函数图)** + **变量** + **函数**。两个技能互补：

| 你要动的东西 | 用哪个 |
|-------------|--------|
| 组件树：加/配组件、Transform、ChildActor 组装 | **`ue-blueprint-components`** |
| 图里的节点 / 引脚 / 连线 / 变量读写节点 | **本技能**（Python 原生 + C++ 桥） |
| **了解 Blueprint 全貌**（CDO 属性、子对象、组件层级） | `unreal_dump` 工具（一步拿 json1 属性 + json2 序列化全貌，再决定深入哪些图节点） |
| 资产创建、变量声明、函数图增删、编译/保存 | Python 原生（`BlueprintEditorLibrary`），下文列出 |

> 需要 C++-only 接口而桥还没有？看 §5 —— 直接在 PyBridges 里扩展，别新建模块/插件
> （本工程 Live Coding 只认 S1Editor，详见 `ue-cpp-python-bridge`）。

---

## 1. 能力地图：Python 原生 vs C++ 桥

| 操作 | 方式 |
|------|------|
| 创建 Blueprint 资产 | 原生 `BlueprintEditorLibrary.create_blueprint_asset_with_parent` |
| 查/加/删函数图、事件图 | 原生 `find_event_graph` / `find_graph` / `add_function_graph` / `remove_function_graph` |
| 加成员变量 / 设变量属性 | 原生 `add_member_variable` / `set_blueprint_variable_instance_editable` 等 |
| 删未用节点 / 变量、替换变量引用 | 原生 `remove_unused_nodes` / `remove_unused_variables` / `replace_variable_references` |
| 遍历图中全部节点 | 原生 `ObjectIterator` + `isinstance(obj, unreal.EdGraphNode)` + `obj.get_outer()==graph` |
| 编译 / 保存 / 刷新编辑器 | 原生 `compile_blueprint` / `EditorAssetLibrary.save_loaded_asset` / `refresh_open_editors_for_blueprint` |
| **加函数调用节点** | 桥 `AddFunctionCallNode` |
| **加/查事件节点、读事件名** | 桥 `AddDefaultEventNode` / `FindEventNode` / `GetEventNodeFunctionName` |
| **连引脚 / 断某引脚连线** | 桥 `ConnectGraphPins` / `BreakPinLinks` |
| **设引脚字面量默认值** | 桥 `SetPinDefaultValue` |
| **加变量读/写节点** | 桥 `AddVariableGetNode` / `AddVariableSetNode` |
| **删单个节点** | 桥 `RemoveNode` |
| **读函数调用节点信息**（调了什么函数/所属类/是否纯函数） | 桥 `GetCallFunctionInfo` |
| **读变量读节点信息**（读了哪个变量/父类） | 桥 `GetVariableGetInfo` |
| **读变量写节点信息**（写了哪个变量/父类） | 桥 `GetVariableSetInfo` |
| **读节点所有引脚列表**（名称 + Input/Output 方向） | 桥 `GetNodePins` |
| **了解 Blueprint 全貌**：dump CDO 拿 json1 属性视图 + json2 序列化视图（属性/子对象/组件层级，含 protected 图节点） | `unreal_dump` 工具（先做这个再看图） |

**为什么图节点必须走桥**：`K2Node_*` 的 `SetFromFunction`/`CreatePin`/`GetSchema()->TryCreateConnection`
不是 `UFUNCTION`，`function_reference`/`node_pos_x`/pin 也不是 `UPROPERTY` —— Python 的
`call_method`/`get_editor_property` 直接报 "Failed to find function/property"。

⚠️ **尤其注意：`K2Node_CallFunction.FunctionReference` 和 `K2Node_VariableGet.VariableReference` 是 `FMemberReference` 类型
（不是 `UPROPERTY`），Python 反射**完全读不到**——`get_editor_property` 会抛异常，没有任何 workaround。
**必须用桥的 `GetCallFunctionInfo` / `GetVariableGetInfo` / `GetVariableSetInfo` 来读。**

桥把这些包成 `UFUNCTION` 暴露出来。桥源码：`S1Game/Source/S1Editor/{Public,Private}/PyBridges/BlueprintGraphBridge.*`。

---

## 2. 加载桥

```python
import unreal
cls = unreal.load_class(None, '/Script/S1Editor.BlueprintGraphBridge')
cdo = unreal.get_default_object(cls)
```

> `load_class` 返回 None = 当前运行的编辑器里没这个桥（或你刚加的新 `UFUNCTION` 还没生效）。
> 桥方法都是具名 `UFUNCTION`，**新增方法必须全量 rebuild + 重启编辑器**才注册进来（`unreal_build`
> 只能热重载已存在函数的**函数体**）。见 §5 与 `ue-cpp-python-bridge`。

---

## 3. 桥 API 速查

| 方法 | 签名（Python `call_method` 的 args 顺序） | 返回 |
|------|------|------|
| `AddFunctionCallNode` | `(graph, func_class, 'FuncName', x, y)` | K2Node_CallFunction / None |
| `ConnectGraphPins` | `(src_node, 'srcPin', dst_node, 'dstPin')` | bool |
| `AddDefaultEventNode` | `(bp, graph, 'EventName', event_class, x, y)` | K2Node_Event / None |
| `FindEventNode` | `(graph, 'EventName')` | K2Node_Event / None |
| `GetEventNodeFunctionName` | `(event_node,)` | FName |
| `SetPinDefaultValue` | `(node, 'inputPin', 'value')` | bool |
| `BreakPinLinks` | `(node, 'pin')` | bool |
| `RemoveNode` | `(graph, node)` | bool |
| `AddVariableGetNode` | `(graph, 'VarName', x, y)` | K2Node_VariableGet / None |
| `AddVariableSetNode` | `(graph, 'VarName', x, y)` | K2Node_VariableSet / None |
| `GetCallFunctionInfo` | `(call_function_node,)` | FString (JSON) — `{ok, function_name, class_name, class_path, is_pure}` |
| `GetVariableGetInfo` | `(variable_get_node,)` | FString (JSON) — `{ok, variable_name, parent_class}` |
| `GetVariableSetInfo` | `(variable_set_node,)` | FString (JSON) — `{ok, variable_name, parent_class}` |
| `GetNodePins` | `(ed_graph_node,)` | FString (JSON) — `{ok, pins: [{name, direction}]}` |
| `ExportToT3D` | `(object, 'output_dir')` — output_dir 可空（默认 `{ProjectDir}/T3D/`） | FString (JSON) — `{ok, file_path, size_bytes, size_warning, hint}` |

> `ExportToT3D` 是桥的底层能力，**`unreal_dump` 工具已封装**（对 UObject 一步导出 json1 属性视图 + json2 序列化视图并落盘），分析对象全貌时直接用 unreal_dump，一般无需手动调桥。

常用引脚名：执行流 `then`→`execute`；纯函数返回值 `ReturnValue`；变量写节点输入引脚名=变量名。
常用事件名：`ReceiveBeginPlay` / `ReceiveTick` / `ReceiveEndPlay` / `ReceiveActorBeginOverlap` / `ReceiveDestroyed`。
> 源引脚必须是 Output、目标引脚必须是 Input，别连反。Python 反射里没有的类（`unreal_help` 查不到）用 `unreal.load_class(None,'/Script/Module.Class')`。

---

## 4. Recipe

### 4.1 BeginPlay → 设 Duration 的 Delay → PrintString

```python
cdo = unreal.get_default_object(unreal.load_class(None, '/Script/S1Editor.BlueprintGraphBridge'))
ksl = unreal.load_class(None, '/Script/Engine.KismetSystemLibrary')

bp = unreal.BlueprintEditorLibrary.create_blueprint_asset_with_parent('/Game/BP_Demo', unreal.Actor)
eg = unreal.BlueprintEditorLibrary.find_event_graph(bp)

begin = cdo.call_method('FindEventNode', args=(eg, 'ReceiveBeginPlay'))       # BP 创建时已自带
delay = cdo.call_method('AddFunctionCallNode', args=(eg, ksl, 'Delay', 400, 0))
ps    = cdo.call_method('AddFunctionCallNode', args=(eg, ksl, 'PrintString', 800, 0))

cdo.call_method('SetPinDefaultValue', args=(delay, 'Duration', '1.5'))          # 设引脚字面量
cdo.call_method('SetPinDefaultValue', args=(ps, 'InString', 'Hello from BunnySeek'))

cdo.call_method('ConnectGraphPins', args=(begin, 'then', delay, 'execute'))
cdo.call_method('ConnectGraphPins', args=(delay, 'then', ps, 'execute'))

unreal.BlueprintEditorLibrary.compile_blueprint(bp)
unreal.EditorAssetLibrary.save_loaded_asset(bp)
unreal.BlueprintEditorLibrary.refresh_open_editors_for_blueprint(bp)
```

### 4.2 变量读写节点：把成员变量 Health 打印出来

```python
float_t = unreal.BlueprintEditorLibrary.get_basic_type_by_name('float')
unreal.BlueprintEditorLibrary.add_member_variable(bp, 'Health', float_t)

get_h = cdo.call_method('AddVariableGetNode', args=(eg, 'Health', 0, 300))       # 读节点
ps2   = cdo.call_method('AddFunctionCallNode', args=(eg, ksl, 'PrintString', 400, 300))
cdo.call_method('ConnectGraphPins', args=(get_h, 'Health', ps2, 'InString'))     # 数据引脚：读节点输出名=变量名
```

### 4.3 断线 / 删节点

```python
cdo.call_method('BreakPinLinks', args=(delay, 'then'))    # 断开 delay.then 的所有连线
cdo.call_method('RemoveNode', args=(eg, delay))           # 删除该节点（连带断线）
```

### 4.4 遍历图中节点并读出调用信息

```python
import json

# 遍历事件图的所有 CallFunction / VariableGet / VariableSet 节点并打印信息
graph = unreal.BlueprintEditorLibrary.find_event_graph(bp)
for obj in unreal.ObjectIterator():
    if not isinstance(obj, unreal.EdGraphNode) or obj.get_outer() != graph:
        continue
    cls_name = obj.get_class().get_name()

    if cls_name == 'K2Node_CallFunction':
        info = json.loads(cdo.call_method('GetCallFunctionInfo', args=(obj,)))
        print(f"  CallFunction: {info.get('class_name','?')}::{info.get('function_name','?')}  pure={info.get('is_pure')}")

    elif cls_name == 'K2Node_VariableGet':
        info = json.loads(cdo.call_method('GetVariableGetInfo', args=(obj,)))
        print(f"  VariableGet: {info.get('parent_class','self')}.{info.get('variable_name','?')}")

    elif cls_name == 'K2Node_VariableSet':
        info = json.loads(cdo.call_method('GetVariableSetInfo', args=(obj,)))
        print(f"  VariableSet: {info.get('parent_class','self')}.{info.get('variable_name','?')}")

    # 所有节点都能读引脚
    pins = json.loads(cdo.call_method('GetNodePins', args=(obj,)))
    # pins['pins'] = [{'name': 'execute', 'direction': 'Input'}, ...]
```

### 4.5 ⭐ 分析陌生 Blueprint 的第一步：用 `unreal_dump` 看 CDO 全貌

拿到一个不熟悉的 Blueprint，**不要直接遍历图节点**——先用 `unreal_dump` 导出其 CDO 的全貌。
对被 dump 的 UObject，`unreal_dump` 会输出**两种 JSON** 并落盘：

- **json1 = 属性视图**：Python 反射的 editor property（snake_case 字段名、含默认值/空值、
  `$type/$id/$ref` 身份标注）——看"这个类有哪些属性、当前值是多少"。
- **json2 = 序列化视图**：UE 原生序列化（PascalCase 原始属性名、只含非默认配置值、
  含 protected 属性/图节点、`$class/$name` 对象身份与 `$children` 层级）——看"这个资产
  实际配了什么"，**图节点（AnimGraphNode_* 等 protected 属性）只有 json2 看得到**。

两者字段名不互通（snake_case ↔ PascalCase）；展示各限长 20K，截断时附"共 N 字符，完整版见文件"说明。

```python
# 直接调 unreal_dump 工具，expr 传 CDO 表达式（命名空间与 unreal_exec 共享）
unreal_dump({
  "expr": "unreal.get_default_object(unreal.load_asset('/Game/BluePrints/Rush/BP_Soldier').generated_class())"
})
```

输出依次为：两种结果区别说明 → `=== json1 ===` 内容 → `=== json2（compact）===` 内容 →
完整文件路径（json1 → `*.reflection.json`，json2 → `*.json` / `*.full.json`）。
看完你就知道这个 BP 有哪些关键配置、哪些子对象值得关注，再决定深入哪些图节点。

> **常见用法**：对 Blueprint 的 CDO dump → 看配置属性与组件层级；对 Actor 实例 dump → 看组件
> 树与 Transform。需要更细的字段名时再配合 `unreal_help` / 反射精确读取。

---

## 5. 桥里还没有的接口？直接在 PyBridges 扩展（两条路）

桥代码都在 `S1Game/Source/S1Editor/{Public,Private}/PyBridges/`（本工程唯一可热重载的落点）。
扩展方式与通用套路见 **`ue-cpp-python-bridge`**，这里给出两条路 + 用法：

**A. 想边改边热重载 → 加 `UBunnySeekBridge` 的一个 op**（`BunnySeekBridge.cpp` 里加 `static Op_Xxx`
+ 一行分发，纯函数体改动，`unreal_build` 即生效，无需重启）。适合探索/一次性操作。

**B. 想固化成稳定具名 API → 给 `UBlueprintGraphBridge` 加一个 `UFUNCTION`**（需全量 rebuild + 重启
一次，因为新反射符号 Live Coding 加不进去）。适合会反复用的图操作。

具体例子（路 B，给节点加注释）：

```cpp
// BlueprintGraphBridge.h — 加声明
UFUNCTION(BlueprintCallable, Category = "Python|BlueprintGraph")
static bool SetNodeComment(UEdGraphNode* Node, const FString& Comment);

// BlueprintGraphBridge.cpp — 加实现（函数体用 UEdGraphNode 的字段/方法）
bool UBlueprintGraphBridge::SetNodeComment(UEdGraphNode* Node, const FString& Comment)
{
    if (!Node) return false;
    Node->NodeComment = Comment;
    Node->bCommentBubbleVisible = true;
    return true;
}
```

rebuild + 重启后 Python 直接用：

```python
cdo = unreal.get_default_object(unreal.load_class(None, '/Script/S1Editor.BlueprintGraphBridge'))
cdo.call_method('SetNodeComment', args=(some_node, '这是自动生成的节点'))
```

> 图相关的 C++ API 入口：`FBlueprintEditorUtils`、`UEdGraphSchema_K2`、`UK2Node_*`（S1Editor 已链接
> `BlueprintGraph`/`UnrealEd`，直接 include 用即可）。

---

## 6. 遍历节点 / 函数图

```python
# 遍历某图的所有节点（按类分组）
graph = unreal.BlueprintEditorLibrary.find_event_graph(bp)
by_cls = {}
for obj in unreal.ObjectIterator():
    if isinstance(obj, unreal.EdGraphNode) and obj.get_outer() == graph:
        by_cls.setdefault(obj.get_class().get_name(), []).append(obj)

# 函数图：自带 K2Node_FunctionEntry，用它的 then 作为逻辑起点
func_g = unreal.BlueprintEditorLibrary.add_function_graph(bp, 'MyFunc')
entry = next(o for o in unreal.ObjectIterator()
             if isinstance(o, unreal.EdGraphNode) and o.get_outer()==func_g
             and o.get_class().get_name()=='K2Node_FunctionEntry')
node = cdo.call_method('AddFunctionCallNode', args=(func_g, unreal.Actor, 'K2_GetActorLocation', 200, 0))
cdo.call_method('ConnectGraphPins', args=(entry, 'then', node, 'execute'))
```

---

## 7. 常见陷阱

| 症状 | 原因 | 解决 |
|------|------|------|
| `load_class` 返回 None | 桥没编进当前编辑器 / 刚加的 UFUNCTION 没生效 | 全量 rebuild + 重启（不是 `unreal_build`），见 §2/§5 |
| `AddFunctionCallNode` 返回 None | 函数名拼错或 Class 不匹配 | 用 `unreal_exec` + `search_files` 在源码中搜索 `FuncName` 确认函数所属类 |
| `ConnectGraphPins` 返回 False | 引脚方向反了 / 引脚名拼错 | 源=Output、目标=Input；核对引脚名 |
| `SetPinDefaultValue` 无效 | 引脚已连线（默认值被连线覆盖）/ 值文本格式不对 | 先 `BreakPinLinks`；bool 用 "true"、结构体用 UE 文本格式 |
| 编译报 "disconnected pin" | 非纯函数的 execute 引脚没接 | 确保执行流连通 |
| `FindEventNode` 返回 None | 该事件未被自动生成 | 用 `AddDefaultEventNode` 补 |
| `get_editor_property('function_reference')` 或 `get_editor_property('variable_reference')` 报错 | `FunctionReference` / `VariableReference` 是 `FMemberReference`，不是 `UPROPERTY`，Python 反射读不到 | **必须用桥**：`GetCallFunctionInfo` / `GetVariableGetInfo` / `GetVariableSetInfo` |
| `ObjectIterator` 遍历到 TRASH 节点 | 旧节点残留 | 先 `remove_unused_nodes` |

---

## 8. 相关技能

- `ue-blueprint-components` — Blueprint 组件树（SubobjectData）
- `ue-cpp-python-bridge` — C++ 桥的通用套路、S1Editor/PyBridges 落点、Live Coding 热重载规则
- `ue-material-editor` — 材质编辑器节点操作
