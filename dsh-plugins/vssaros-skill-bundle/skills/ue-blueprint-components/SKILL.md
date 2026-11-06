---
name: ue-blueprint-components
description: 通过 Python 操控 UE5 Blueprint 的【组件树 / SCS】(SubobjectDataSubsystem)：创建 BP、加/配组件、ChildActorComponent 组装，以及编译时机、句柄去重、跨组件引用、实例残留等语义坑。只管组件树——图节点/连线/变量见 ue-blueprint-graph，C++-only 接口见 ue-cpp-python-bridge。
displayName: "UE5 Blueprint 组件层级 Python 开发指南"
---

# UE5 Blueprint 组件层级 Python 开发指南

通过 Python 在 UE5 编辑器中创建、配置 Blueprint 的**组件树**（SCS / SubobjectData）。

---

## 0. 定位 & 与 `ue-blueprint-graph` 的分工

一个 Blueprint 由四部分组成，各有对应做法 —— 动手前先认清你要改哪一部分：

| Blueprint 的构成 | 谁负责 | 主要入口 |
|-----------------|--------|---------|
| **组件树 (SCS)**：加/删组件、层级、Transform、ChildActor 组装 | **本技能** | `SubobjectDataSubsystem` |
| **图 (事件图/函数图)**：节点、引脚、连线、变量读写节点 | `ue-blueprint-graph` | 原生 API + `UBlueprintGraphBridge` |
| **变量 / 函数图声明** | `ue-blueprint-graph` | `BlueprintEditorLibrary.add_member_variable` / `add_function_graph` |
| **C++-only 接口**（Python 反射够不到的） | `ue-cpp-python-bridge` | S1Editor/PyBridges 里的 C++ 桥 |

**本技能只管组件树**：用 `SubobjectDataSubsystem` 在 BP 编译前搭好组件层级、配好属性。

**核心心智模型 —— 固定四步**：创建 BP → 拿根句柄 → 加组件 → **编译后**再取对象配属性（§1–§2）。
组件都是 UObject，属性基本能反射读写；真正的坑不在“调哪个 API”，而在**语义**：句柄要去重、
`get_object` 前必须编译、跨组件引用不持久化、实例有 TRASH 残留、CDO 上取不到组件（§4–§6、§10）。
先按四步走通，再回头看坑。

> 图里的节点/连线不在这里 —— 见 `ue-blueprint-graph`；别因为“组件搭好了但逻辑没连”就停下。

---

## 1. 创建 Blueprint 资产

```python
import unreal

bp = unreal.BlueprintEditorLibrary.create_blueprint_asset_with_parent(
    '/Game/MyBlueprint',    # 路径（"/Game/..." 格式）
    unreal.Actor            # 父类
)
bp.set_editor_property('blueprint_description', '我的描述')
```

**⚠️ 加载前检查存在性（防 Crash）：**
```python
if unreal.EditorAssetLibrary.does_asset_exist('/Game/MyBP'):
    bp = unreal.load_asset('/Game/MyBP')  # 安全加载
```

**⚠️ 删除后等一个 tick 再重建同名资产**，否则 `create_blueprint_asset_with_parent` 可能返回 None。

---

## 2. SubobjectDataSubsystem — 组件操作

`SubobjectDataSubsystem` 是 **EngineSubsystem**（不是 EditorSubsystem）：

```python
sub = unreal.get_engine_subsystem(unreal.SubobjectDataSubsystem)
bfl = unreal.SubobjectDataBlueprintFunctionLibrary
```

> **通用判据（不用死记）**：`get_editor_subsystem` 只收 `EditorSubsystem` 子类，
> `get_engine_subsystem` 只收 `EngineSubsystem` 子类。拿不准就 `unreal_help('XxxSubsystem')`
> 看它打印的 **Base classes (MRO)**：链里是 `EngineSubsystem` 就用 `get_engine_subsystem`，
> 是 `EditorSubsystem` 就用 `get_editor_subsystem`。若某个 factory 抛
> `must be a 'X'` 的 TypeError，同理先查目标类的基类再换调用。

### 2.1 添加组件

```python
# 获取根句柄
handles = sub.k2_gather_subobject_data_for_blueprint(bp)
root_handle = handles[0]  # 第一个就是 DefaultSceneRoot / Actor 根

# 构造参数
params = unreal.AddNewSubobjectParams()
params.set_editor_property('new_class', unreal.StaticMeshComponent.static_class())
params.set_editor_property('blueprint_context', bp)
params.set_editor_property('parent_handle', root_handle)  # 父组件的 handle

new_handle, fail_reason = sub.add_new_subobject(params)
if str(fail_reason):
    print(f"Failed: {fail_reason}")

# 重命名
sub.rename_subobject(new_handle, 'MyComponent')
```

### 2.2 获取已添加的组件对象（模板级别）

**⚠️ 必须先 Compile 才能访问组件对象！**

```python
unreal.BlueprintEditorLibrary.compile_blueprint(bp)

handles = sub.k2_gather_subobject_data_for_blueprint(bp)
comp_map = {}
for h in handles:
    data = sub.k2_find_subobject_data_from_handle(h)
    obj = bfl.get_object(data)           # 获取实际 UObject
    vname = str(bfl.get_variable_name(data))  # BP 变量名（如 'CenterSphere'）
    if obj and vname != 'None' and vname not in comp_map:
        comp_map[vname] = obj
```

**⚠️ 去重是必需的**：同一个 `variable_name` 会出现多个 handle（每个 handle 返回同一个底层对象），所以用 dict 去重。

### 2.3 配置 StaticMesh / Transform

```python
comp = comp_map['CenterSphere']
comp.set_editor_property('static_mesh', unreal.load_asset('/Engine/BasicShapes/Sphere'))
comp.set_editor_property('relative_scale3d', unreal.Vector(1.5, 1.5, 1.5))
comp.set_editor_property('relative_location', unreal.Vector(200, 0, 0))
comp.set_editor_property('relative_rotation', unreal.Rotator(45, 0, 0))  # Roll=45
```

### 2.4 替换根组件

```python
sub.make_new_scene_root(root_handle, my_new_root_handle, bp)
```

---

## 3. RotatingMovementComponent

```python
rmc = comp_map['RingRotation']
rmc.set_editor_property('rotation_rate', unreal.Rotator(0, 0, 45))  # Yaw 45°/s
```

| 属性 | 说明 |
|------|------|
| `rotation_rate` | Rotator，单位 deg/s |
| `updated_component` | 要旋转的目标 SceneComponent |
| `auto_activate` | 默认 True |
| `auto_register_updated_component` | 默认 True，BeginPlay 时自动绑定到 Actor Root（**仅 PIE 有效**） |
| `pivot_translation` | 旋转中心偏移 |

---

## 4. ⚠️ 核心陷阱：跨组件引用不持久化

在 SCS 模板上设置 `updated_component` 指向另一个模板组件，**不会传递到实例**：

```python
# ❌ 模板上设置了，spawn 后变成 None
rmc.set_editor_property('updated_component', some_scene_comp)

# spawn 后检查 → updated_component = None
```

**解决方案：ChildActorComponent 架构**

每个需要自旋转的模块做成独立 Blueprint，用 `ChildActorComponent` 组装。RMC 在子 BP 内部，`auto_register_updated_component` 在 PIE 时自动生效。

### 4.1 ChildActorComponent 用法

```python
# 创建 ChildActorComponent
cac_h = add_comp(root_h, unreal.ChildActorComponent, 'MyChild')

# 设置子 Actor 类（用 generated_class，不是 Blueprint 本身）
child_bp = unreal.load_asset('/Game/BP_Child')
cac.set_editor_property('child_actor_class', child_bp.generated_class())

# 运行时访问已生成的子 Actor
child_actor = cac.get_editor_property('child_actor')
```

### 4.2 编辑器视口内旋转的 workaround

`auto_register_updated_component` 只在 PIE 的 BeginPlay 触发。编辑器视口内需要手动绑定：

```python
# 在每个子 Actor 内部
rmc.set_editor_property('updated_component', root_component)
```

这可以在 fix 脚本中做（见下方）。

---

## 5. 实例操作（spawn 后）

```python
actor_sys = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
spawned = actor_sys.spawn_actor_from_class(gen_class, unreal.Vector(0, 0, 400))

# 获取所有组件
comps = spawned.call_method('K2_GetComponentsByClass', 
    args=(unreal.ActorComponent.static_class(),))

# ⚠️ 过滤 TRASH 组件
for c in comps:
    if 'TRASH' in c.get_name():
        continue  # 跳过已销毁但尚未 GC 的残留
```

---

## 6. CDO 相关限制

```python
cdo = unreal.get_default_object(gen_class)
comps = cdo.call_method('K2_GetComponentsByClass', ...)  # → 总是返回 0！
```

**CDO 上 `K2_GetComponentsByClass` 永远返回空。** 配置组件必须通过 SubobjectData 系统在编译前完成。

---

## 7. 完整 Recipe：从零创建带组件的 BP

```python
import unreal

def create_bp_with_component(path, component_class, parent_class=unreal.Actor):
    """创建一个只有一个组件的简单 BP"""
    if unreal.EditorAssetLibrary.does_asset_exist(path):
        unreal.EditorAssetLibrary.delete_asset(path)
    
    bp = unreal.BlueprintEditorLibrary.create_blueprint_asset_with_parent(path, parent_class)
    sub = unreal.get_engine_subsystem(unreal.SubobjectDataSubsystem)
    bfl = unreal.SubobjectDataBlueprintFunctionLibrary
    
    handles = sub.k2_gather_subobject_data_for_blueprint(bp)
    root_h = handles[0]
    
    # 添加组件
    params = unreal.AddNewSubobjectParams()
    params.set_editor_property('new_class', component_class.static_class())
    params.set_editor_property('blueprint_context', bp)
    params.set_editor_property('parent_handle', root_h)
    comp_h, err = sub.add_new_subobject(params)
    sub.rename_subobject(comp_h, 'MyComponent')
    
    # 必须先编译才能 get_object
    unreal.BlueprintEditorLibrary.compile_blueprint(bp)
    
    # 获取组件引用以便配置
    h2 = sub.k2_gather_subobject_data_for_blueprint(bp)
    comp_obj = None
    for h in h2:
        data = sub.k2_find_subobject_data_from_handle(h)
        vname = str(bfl.get_variable_name(data))
        if vname == 'MyComponent':
            comp_obj = bfl.get_object(data)
            break
    
    # 配置... comp_obj.set_editor_property(...)
    
    # 最终编译 + 保存
    unreal.BlueprintEditorLibrary.compile_blueprint(bp)
    unreal.EditorAssetLibrary.save_loaded_asset(bp)
    return bp
```

---

## 8. 速查：常见类路径

| 用途 | 路径/类型 |
|------|---------|
| Sphere mesh | `/Engine/BasicShapes/Sphere` |
| Cube mesh | `/Engine/BasicShapes/Cube` |
| Cone mesh | `/Engine/BasicShapes/Cone` |
| Cylinder mesh | `/Engine/BasicShapes/Cylinder` |
| Plane mesh | `/Engine/BasicShapes/Plane` |

---

## 9. 善后：保存

```python
# 保存 BP
unreal.EditorAssetLibrary.save_loaded_asset(bp)

# 保存当前关卡
les = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
les.save_current_level()
```

---

## 10. ⚠️ 配 Transform 时最容易错的：`unreal.Rotator` 参数顺序

设 `relative_rotation` / `rotation_rate` 等属性时，构造参数顺序反直觉：

```python
# ✅ Rotator(roll, pitch, yaw) —— yaw 在最后
unreal.Rotator(0, 0, 45)       # Yaw 45°（绕 Z 轴）
unreal.Rotator(0, -30, 0)      # Pitch -30°（绕 Y 轴）
unreal.Rotator(45, 0, 0)       # Roll 45°（绕 X 轴），不是 Pitch！
```

| 构造参数 | 绕轴 | 含义 |
|---------|----|------|
| roll  | X 轴 | 滚转（绕前后轴翻滚） |
| pitch | Y 轴 | 俯仰（抬头/低头） |
| yaw   | Z 轴 | 偏航（水平转向） |

> 通用做法：任何 struct 的构造参数顺序别靠直觉猜，`unreal_help('Rotator')` 看它打印的
> **Constructor** 签名。验证：
> ```python
> r = unreal.Rotator(10, 20, 30); assert r.roll==10 and r.pitch==20 and r.yaw==30
> ```

---

## 11. 常见错误速查表

| 症状 | 原因 | 解决 |
|------|------|------|
| `create_blueprint_asset_with_parent` 返回 None | 同名资产刚被删除，package 未释放 | 等一帧或用新名字 |
| `load_asset` 导致编辑器 Crash | 资产损坏 | 用 `does_asset_exist` 先检查；删除坏资产用 `EditorAssetLibrary.delete_asset` |
| `get_editor_subsystem(SubobjectDataSubsystem)` 报错 | 它是 EngineSubsystem | 用 `get_engine_subsystem()` |
| `add_new_subobject` 没报错但 handles 数没变 | 没编译 | 添加完组件后 compile_blueprint |
| `get_object(data)` 返回 None | 没编译 | 添加完组件后 compile_blueprint |
| 模板上设了 `updated_component`，spawn 后为 None | 跨组件引用不持久化 | 用 ChildActorComponent 架构 |
| `K2_GetComponentsByClass` 返回 TRASH 组件 | 旧实例销毁后的残留 | 过滤 `'TRASH' in name` |
| Rotator 的 yaw 设了值但效果不对 | 参数顺序搞反了 | 记住 `Rotator(roll, pitch, yaw)` |
| 同一个 var_name 出现多个 handle | SCS 的正常行为 | 用 dict 去重 |
| CDO 组件数为 0 | 正常现象 | 不要用 CDO 操作组件，用 SubobjectData |
