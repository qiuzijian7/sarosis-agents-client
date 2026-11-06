---
name: ue-gameplay-tags
description: 在运行中的 UE5 编辑器里处理 GameplayTag：注册一个新 Tag 使其立即有效（无需重启），以及把 GameplayTag 类型的 UPROPERTY 设到资产/CDO 上。堵住"Python 够不到 GameplayTagsManager、手改 DefaultGameplayTags.ini 要重启才生效"这个反复踩的坑。含关键约束：Live Coding 新增的 C++ UPROPERTY 在重启前不会出现在已存在的 BP 子类上。
displayName: "UE GameplayTag：注册 Tag + 设 Tag 属性（免重启）"
---

# UE GameplayTag：注册 Tag + 设 Tag 属性（免重启）

处理 GameplayTag 时 Python 侧有两个反复踩的坑，本技能给出确定的解法：

1. **注册一个新 Tag 让它当场有效** —— `UGameplayTagsManager` / `IGameplayTagsEditorModule`
   没有暴露成 UFUNCTION，Python 够不到；手改 `DefaultGameplayTags.ini` **要重启编辑器**
   才会被加载（运行时 `RequestGameplayTag` 对未注册 Tag 返回**空/无效** Tag）。
2. **把 GameplayTag 值设到某个 UPROPERTY 上** —— 反射能设已注册的 Tag，但没注册的会静默变空。

两件事都走**已建好的 S1Editor 桥** `UBunnySeekBridge` 的两个 op，`unreal_build`
可热重载，**无需重启**（Tag 注册本身也不需要重启）。

---

## 0. ⚠️ 最关键前置：Live Coding 新增的 UPROPERTY 在重启前 BP 子类看不到

如果你刚给某个 C++ 类**新增了一个 `UPROPERTY`（比如一个 `FGameplayTag`）**并 `unreal_build`
热重载了：**已经编译好的 Blueprint 子类（`BlueprintGeneratedClass` CDO）看不到这个新属性**。
在 BP 资产上 `get_editor_property`/`set_editor_property` 会报：

```
BlueprintGeneratedClass: Failed to find property 'X' for attribute 'X'
```

`compile_blueprint` **修不好**（对 `GeSkillBlueprint` 这类自定义 BP 类型尤其如此）。这是信号，
不是要你反复试 —— **BP 类只有在编辑器重启（或真正 reinstance）后才会拿到新属性**。两条出路，
**优先第 1 条**：

1. **让修复根本不需要新的 BP 可配属性**：用纯 C++ 检查，或在 C++ 构造函数里用一个**已注册**的
   Tag 设默认值。自洽、不引入新的资产/配置依赖。
2. 若确实要配 BP：先告诉用户需要重启，重启后再用本技能的 `set_gameplay_tag` 设到 BP 资产上。

> 想在 C++ 构造函数里赋 Tag 默认值时注意：`FGameplayTag(FName)` 是 **protected**，不能直接构造；
> `FGameplayTag::RequestGameplayTag(FName, /*ErrorIfNotFound=*/false)` 对**未注册**的 Tag 返回**空**。
> 所以构造函数里要用的 Tag 必须**先注册**（见 §2），否则默认值是空的。

---

## 1. 前置：桥可用吗？

```python
from GameScript import bunnyseek_bridge as bs
bs.ping("hi")          # {'ok': True, ...} 说明 S1Editor 桥已加载
bs.list_ops()          # 应包含 'Call: register_gameplay_tag' / 'CallObj: set_gameplay_tag'
```

若 `list_ops()` 里没有这两个 op：桥的 C++ 还没编进当前编辑器 —— 先 `unreal_build`
（首次加桥/新增 UFUNCTION 才需要全量 rebuild + 重启；本技能的 op 是函数体分支，热重载即可）。
桥的加 op 机制见 `ue-cpp-python-bridge`。

---

## 2. 注册一个新 Tag（立即有效，免重启）

```python
from GameScript import bunnyseek_bridge as bs

r = bs.register_gameplay_tag(
    "GameplayAbility.Hero07.AOETeleport.Active",
    comment="Angel AOETeleport 激活互斥 Tag, 阻止队友 UltimateToTarget",
    # source 省略 = 默认 DefaultGameplayTags.ini
)
print(r)   # {'ok': True, 'tag': '...', 'registered': True, 'valid': True}
```

- **幂等**：Tag 已存在则直接返回成功。
- 成功后 `valid=True`，此刻 `RequestGameplayTag` 立即能拿到有效 Tag，且已写进 ini（持久）。
- 失败会抛 `BridgeError`（`valid=False`）。

底层等价（不想用 wrapper 时）：

```python
bs.call("register_gameplay_tag",
        tag="GameplayAbility.Hero07.AOETeleport.Active",
        comment="...", source="")
```

**命名规范**：跟随工程既有约定（grep `DefaultGameplayTags.ini` 看同模块的 Tag），
如 `GameplayAbility.Hero07.*` / `Skill.Hero07.*`。别复用一个**语义不同**的既有 Tag 来图省事
（那会与它原本用途串扰）—— 需要新 Tag 就注册新的。

---

## 3. 把 Tag 设到某个 UPROPERTY 上

`target` 传 unreal 对象（BP 资产、CDO、actor、component……）。`tag` **必须已注册**（先做 §2）。

```python
import unreal
from GameScript import bunnyseek_bridge as bs

# 例：设到 C++ CDO（推荐 —— 不受 §0 的 BP 重编译限制影响；无 override 的 BP 实例会回退到它）
cdo = unreal.get_default_object(unreal.GeSkillAngel_AOETeleport)
bs.set_gameplay_tag(cdo, "AOETeleportActiveTag",
                    "GameplayAbility.Hero07.AOETeleport.Active")

# 例：设到 BP 资产（仅当该属性在 BP 类上可见 —— 见 §0；新加的 C++ 属性需重启后才行）
asset = unreal.load_asset("/Game/BluePrints/.../GA_Hero07_AOETeleport")
bs.set_gameplay_tag(asset, "AOETeleportActiveTag",
                    "GameplayAbility.Hero07.AOETeleport.Active")
```

- 只 `Modify()` + `MarkPackageDirty()`，**不落盘**。要持久化，随后自己存：

```python
asset_sys = unreal.get_editor_subsystem(unreal.EditorAssetSubsystem)
asset_sys.save_asset(asset.get_path_name())     # 或 save_loaded_asset(asset)
```

- 属性找不到时桥会明确告诉你是不是 §0 的情况（新 UPROPERTY + 未重启）。
- 属性存在但不是 `FGameplayTag` 类型也会报错（防止误设）。

返回：`{'ok': True, 'property': ..., 'tag': '<解析后的 Tag 名>', 'target': ..., 'dirty': True}`。

---

## 4. 典型完整流程（新增互斥 Tag → 配到两端）

```python
import unreal
from GameScript import bunnyseek_bridge as bs

TAG = "GameplayAbility.Hero07.AOETeleport.Active"

# 1) 注册（立即有效 + 写 ini）
bs.register_gameplay_tag(TAG, comment="AOETeleport 互斥")

# 2) 设到两个 CDO（若属性是新加 UPROPERTY 且未重启，改设 BP 资产会失败——见 §0）
for cls, prop in [(unreal.GeSkillAngel_AOETeleport,       "AOETeleportActiveTag"),
                  (unreal.GeSkillAngel_UltimateToTarget,  "AOETeleportActiveBlockTag")]:
    cdo = unreal.get_default_object(cls)
    print(bs.set_gameplay_tag(cdo, prop, TAG))

# 3) 校验
tl = unreal.GameplayTagLibrary
for cls, prop in [(unreal.GeSkillAngel_AOETeleport,       "AOETeleportActiveTag"),
                  (unreal.GeSkillAngel_UltimateToTarget,  "AOETeleportActiveBlockTag")]:
    v = unreal.get_default_object(cls).get_editor_property(prop)
    print(prop, tl.is_gameplay_tag_valid(v), v.export_text())
```

---

## 5. 常见错误速查

| 症状 | 原因 | 解决 |
|------|------|------|
| `RequestGameplayTag` 拿到空 Tag / `is_gameplay_tag_valid` False | Tag 未注册 | 先 `bs.register_gameplay_tag(...)`（§2） |
| 手改了 `DefaultGameplayTags.ini` 但 Tag 还是无效 | ini 要重启才加载 | 用 §2 的 op（内部走 editor module，立即生效） |
| `Failed to find property 'X' on BlueprintGeneratedClass` | Live Coding 新加的 UPROPERTY，BP 子类未重启看不到 | 见 §0：改设 C++ CDO，或重启后再设 BP |
| `编译失败: FGameplayTag(FName) 无法访问 protected` | 想在构造函数里直接构造 Tag | 用 `RequestGameplayTag(FName, false)`，且该 Tag 必须**先注册** |
| `set_gameplay_tag` 说 not a FGameplayTag | 属性名写错 / 类型不符 | `unreal_help` 查真实属性名与类型 |
| `list_ops()` 里没有这两个 op | 桥 C++ 未编进当前编辑器 | `unreal_build`（首次加桥要全量 rebuild+重启一次） |

---

## 6. 相关技能

- `ue-cpp-python-bridge` — 桥的形状、如何新增 op、Live Coding 约束。
- `ue-blueprint-graph` / `ue-blueprint-components` — 其它 BP 操控。
