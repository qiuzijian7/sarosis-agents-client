---
name: ue-python-api-gotchas
description: UE5 Python 反射里"名字猜错就报错"的坑速查表（wrong → right 对照）：GameplayTag 怎么构造、ASC 怎么读属性、protected UPROPERTY 读不到怎么绕、枚举叫 TriggerEvent 不是 ETriggerEvent、ARFilter/get_referencers 的参数形状、ObjectIterator 必须包 try、CharacterMovement 的取法等。撞到 AttributeError / "Failed to find property" / "is protected" 时先查本表，再用 unreal_help(symbol, filter=...) 自省，不要用 dir() 盲试。
displayName: "UE5 Python API 形状坑速查"
---

# UE5 Python API 形状坑速查

UE 的 Python 绑定是反射生成的，命名与 C++ **不一致**（`GetNumericAttribute` 并不等于
`get_numeric_attribute`），而错一个字就是 `AttributeError`。实测一次会话里撞了 **30+ 个**
不同的形状错误、`unreal_exec` 失败率 34%。本表是那批错误的 wrong → right 对照。

**撞错时的正确反应**（比逐个试快得多）：

0. 先读 `unreal_exec` 结果末尾的 **[unreal_exec hint]**：AttributeError / NameError / ImportError
   会当场附上近似名（带签名）、已知正解、缺的 import 语句——大多数情况照它改一次就对。
1. `unreal_help("<TypeName>", filter="<关键词>")` —— 只列名字含该子串的成员。大类
   （`PlayerController` / `S1AbilitySystemComponent`）不加 `filter` 会倾泻 20 KB。
   cell 里同样能查：`ue_help('S1AbilitySystemComponent', filter='attribute')`
   （`unreal_help` 是宿主工具，`unreal.unreal_help(...)` 不存在）；GameScript 的函数：
   `from GameScript import ueflow; print(ueflow.help('players'))`。
2. `unreal_dump` 一个实例 —— 递归列出所有可读 editor property，不必猜字段名。
3. 别用 `dir()` + 反复试错；也别改 `timeout_seconds` 硬扛。

---

## GameplayTag / Container

```python
# ✗ unreal.GameplayTagLibrary.make_gameplay_tag_from_name('X')   # 不存在
# ✗ unreal.GameplayTagLibrary.request_gameplay_tag('X')          # 不存在
# ✓
tag = unreal.GameplayTag()
tag.import_text('Ability.Parkour.Jump')          # import_text 是通用构造手段
assert unreal.GameplayTagLibrary.is_gameplay_tag_valid(tag)

# ✗ container.add_tag(tag)                        # 不存在
# ✓
container = unreal.GameplayTagLibrary.make_gameplay_tag_container_from_tag(tag)
```

`import_text` / `export_text` 对**任意 struct** 都可用，是绕过"构造函数参数不明"的通用招。
注册新 Tag（免重启）见 [[ue-gameplay-tags]]。

读 tag 的名字（2026-10-09 实测，嵌在 InputData 里的 tag 尤其容易撞）：

```python
# ✗ str(tag)                     # "<Struct 'GameplayTag' {}>"
# ✗ tag.tag_name                 # 某些容器里取出的 GameplayTag 报 AttributeError
# ✓ tag.get_editor_property('tag_name')        # FName，再 str()
# ✓ inventory.tag_text(tag)                    # GameScript.ueflow：export_text() 里解析 TagName="…"（最稳）
```

## Array 属性：`get_editor_property` 返回的是**活引用**（2026-10-09 实测）

```python
# ✗ 把它当"原值"保存——之后 set 了属性，saved 跟着变，"还原"等于没还原
saved = ia.get_editor_property('triggers')
ia.set_editor_property('triggers', [t1, t2])
len(saved)            # → 2（不是 1）

# ✓ 先 list() 快照；改共享资产用 core.set_prop_quietly（不弄脏包）
saved = list(ia.get_editor_property('triggers'))
core.set_prop_quietly(ia, 'triggers', [t_new] + saved)
try:
    ...
finally:
    core.set_prop_quietly(ia, 'triggers', saved)
```

上一轮会话的手搓按键脚本就这样把一个带 InputData 的 trigger 永久留在了 `IAE_SwitchWeapon_1` 上（内存态，直到编辑器重启），
之后按 2 会切到 1 号槽。`keys` 内部已经按快照处理。

## AbilitySystemComponent 读属性 / buff（GE）

**首选现成函数**（PIE 里按 pid 取，零缓存）：

```python
from GameScript.ueflow import players as pl
pl.attrs(pid, 'UltimateEnergy')      # ✓ {'UltimateEnergy': 90.0, 'UltimateEnergyMax': 90.0, ...}
pl.attr(pid, 'UltimateEnergy')       # ✓ 90.0
pl.effects(pid, 'Hero01_Rush')       # ✓ 当前 GE + remaining / total 秒（-1 = 无限）
```

手写时唯一正确的读法（✓ 在前；2026-09-30 会话有模型把下面 ✗ 那行当成正解抄了 4 次）：

```python
asc = pawn.get_component_by_class(unreal.S1AbilitySystemComponent)
for a in asc.get_all_attributes():                     # 本项目实测 200 个（含重名）
    name = a.attribute_name                            # （a.get_name() 不存在）
    val, found = asc.get_gameplay_attribute_value(a)   # ✓ 返回 (value, found)
# 当前 GE：
L = unreal.AbilitySystemLibrary
for h in asc.get_active_effects(unreal.GameplayEffectQuery()):
    ge_cls = L.get_gameplay_effect_from_active_effect_handle(h).get_class()
    left = L.get_active_gameplay_effect_remaining_duration(pawn, h)   # 第一个参数是 world context
    total = L.get_active_gameplay_effect_total_duration(h)
```

不存在、别再写（✗）：`asc.get_numeric_attribute(...)`（C++ 叫 GetNumericAttribute，但**没有**
Python 绑定）、`get_numeric_attribute_base`、`pl.asc(...)` 以外的"猜的 helper 名"——撞到时看
`unreal_exec` 结果末尾的 **[unreal_exec hint]**，它会给出近似名（带签名）和已知正解。

技能实例用 `asc.get_all_use_skills()`——⚠️ 它返回**已授予（granted）的全部**技能实例（飞行员实测
120 个），**不是**正在激活的；"某 GA 还挂在列表里"不代表它卡在激活状态（2026-09-29 会话据此误判
"状态污染"）。判断激活/结束看日志：`signals.ga_activated(...)` / `signals.ga_ended(...)`。

## protected UPROPERTY 读不到

```python
# ✗ pc.get_editor_property('player')
#   → Property 'Player' ... is protected and cannot be read
# ✗ asc.activatable_abilities.get_editor_property('items')
#   → Property 'Items' ... is protected
```

绕法，按优先级：

1. **`unreal_dump`** —— 它的 T3D/序列化视图常能看到反射读不到的内容
   （实测能 dump 出 `activatable_abilities` 的完整 `Items`）。
2. `export_text()` 后正则抠。
3. `ObjectIterator` 直接找那个对象（如找 `EnhancedInputLocalPlayerSubsystem` 实例，
   而不是从 PC 走 `get_local_player()` —— 后者也不存在）。

## C++ 类型前缀在 Python 里都去掉（E 枚举 / F 结构体 / U·A 类）

```python
# ✗ unreal.ETriggerEvent.TRIGGERED     # ✗ unreal.ESelectItemType.THROW
# ✓ unreal.TriggerEvent.TRIGGERED      # ✓ unreal.SelectItemType.THROW
# ✗ hasattr(unreal, 'EComplexBackpackType') / 'FRushItemData' / 'UFTRushBackpackComponent'   → 全 False
# ✓ unreal.ComplexBackpackType / unreal.RushItemData / unreal.FTRushBackpackComponent        → 都在
```

2026-10-10：agent 用 C++ 名探测得到一串 False，断定"FTRushModeCore 没暴露给 Python"，转去写 C++ 桥（链接失败、删 dll）。
`unreal_help` / `ue_help` 找不到时会自动去前缀再查；cell 里 `hasattr(unreal, 'E…')` 失败也会提示 Python 名。

不确定时：`[n for n in dir(unreal) if 'trigger' in n.lower()]`，或
`unreal_help("", filter="TriggerEvent")`。枚举成员是 **SCREAMING_SNAKE_CASE**。
给 `default_enum` 这类字段赋值时用**整数**（`ESelectItemType::Throw` → `4`）。

## AssetRegistry 参数形状

```python
ar = unreal.AssetRegistryHelpers.get_asset_registry()

# ✗ unreal.ARFilter(package_paths=[...], class_names=[...])   # 本版本无 class_names
# ✗ unreal.ARFilter(package_paths=[...], recursive=False)     # 无 recursive
# ✓ 只传支持的字段，其余在 Python 侧过滤
f = unreal.ARFilter(package_paths=['/Game/BluePrints/Misc/EnhancedInput'])
assets = ar.get_assets(f)
for a in assets:
    name = str(a.asset_name)      # ✗ a.package_name 当字符串用会 AttributeError
                                  #   （是 Name 对象，要 str()）

# ✗ ar.get_referencers(path)                     # 缺第二参
# ✓
opts = unreal.AssetRegistryDependencyOptions()
refs = ar.get_referencers('/Game/.../IAE_SelectItemCommonBegin', opts)
print([str(r) for r in refs])     # 反查"谁引用了这个资产"——找 IMC 映射极有用
```

⚠️ **PIE 运行中别用 `unreal_find_asset` 工具**（AssetRegistry 全库扫描），实测会崩编辑器
（`Class.cpp:6927` 断言）。PIE 期间只用 `unreal.load_asset(<已知路径>)`。
见 [[pie-rush-autoflow]] 坑表。

## ObjectIterator：按类迭代 + 逐个 try，**绝不全量**

```python
# ✗ for o in unreal.ObjectIterator():                 # 全量：PIE 里会崩编辑器（unreal_exec 现在直接拒绝）
# ✗ for o in unreal.ObjectIterator(unreal.Object):    # 同上
#   2026-10-10 17:41：为找一个背包 widget 全量遍历 + 每个对象 get_world() → UWorld::GetWorldPartition 访问违例崩溃，
#   之后连环崩溃 / 缓存隔离 38 分钟。
# ✓ 迭代最具体的那个类，逐个 try
found = []
for o in unreal.ObjectIterator(unreal.RushSelectItemViewModel):
    try:
        if not o.get_name().startswith('Default__'):
            found.append(o)
    except Exception:
        pass
# ✓ 某个 PIE 客户端里的 UMG 控件：cap.widgets_in(<客户端下标>, unreal.<控件类>)（按类迭代 + world 过滤，已封装）
#   本引擎没有 unreal.WidgetBlueprintLibrary 模块属性；BP 子类控件用父类 C++ 类迭代即可（ObjectIterator 含子类）
```

还要**排除 CDO 与 Python 代理**：过滤掉名字含 `Default__` / `PythonCallable` 的。
`is_default_object()` 在本项目 Python 绑定**不存在**。

## 背包 / 物品结构体（2026-10-10 / 10-12 实测）

```python
# FRushItemData 的字段名 get_editor_property 读不到（'item_id' → Failed to find property）：用 export_text 解析
inv.item_fields(data)          # → {item_id, instance_id, item_type, sub_category, num}
# RushBagViewModel.get_item_by_instance(inst) 只收一个参数、直接返回结构体（不是 (ok, out) 元组）
# RushBagFunctionLibrary.get_first_item_instance_id_by_item_id 只查槽位，背包格里的物品返回 -1
# RushBagFunctionLibrary.try_use_item 只"使用"消耗品（Potion / Throwable），护甲 / 武器静默无效 → 换装用 inv.equip
# 服务器背包组件（FTRushBackpackComponent）的 get_all_bag_elements_by_item_id / get_item_num_by_item_id /
#   get_inventory_instance / get_item_id_by_inventory_instance_id 只看得见装备栏，背包格里的物品一律 0 / 空 / None
#   （服务器日志明明 AddInventoryItem BoxType[1]）→ 全部实例用 inv.instances（装备栏 + 客户端背包视图，实例号同号）
# 背包格物品照样能删：delete_item(unreal.InventoryIdentity(item_id=…, item_instance_id=…), 1, tag)——inv.remove 已处理
# 护甲剩余值存在物品上（ArmorShield 属性）：穿过、打残、换下来的甲再穿上还是残的；新下发的甲穿上是满的
#   （装备时 GDS.ArmorDataPicked 补满，下发时塞 ArmorShield / ArmorDurability 属性也会被补满）
```

## Actor / Component 取法

```python
# ✗ pawn.get_character_movement()          # 不存在
# ✓ pawn.get_component_by_class(unreal.CharacterMovementComponent)
#   （子类要传具体类型，如 unreal.S1BRCharacterMovementComponent）

# ✗ cm.get_movement_mode()                 # 不存在
# ✓ cm.get_editor_property('movement_mode')    # -> "MovementMode.MOVE_WALKING"

# ✗ world.get_net_mode() / world.get_editor_property('net_mode')   # 都没有
# ✓ 用 get_full_name() 里的 UEDPIE_0_/UEDPIE_1_ 判断（见 [[ue-pie-repro]]）

# ✗ unreal.ROLE_AUTONOMOUS_PROXY           # 顶层没有
# ✓ unreal.NetRole.ROLE_AUTONOMOUS_PROXY

# 找 PIE 里刚生成的技能物（风场 / 传送阵 / 召唤物）：
# ✗ [a for a in unreal.ObjectIterator(unreal.Actor) if 'JetZone' in a.get_name()]
#   → 混进 Default__/SKEL_/REINST_ CDO 和每个客户端 world 的副本（实测 20 个，一个都不是要的）
# ✓ pl.find_actors('JetZone')                 # 服务器 world 的实例 + life_left（剩余寿命）
# ✓ a = pl.actor('BP_JetZone_Rush'); a.get_life_span(); a.get_editor_property('actor_life_span')

# bool UPROPERTY 的 Python 名去掉 b 前缀：bIsSameCamp → is_same_camp（✗ b_is_same_camp）
```

## 编辑器 world / 子系统

```python
# ✗ unreal.get_editor_subsystem(unreal.LevelEditorSubsystem).get_editor_world()  # 不存在
# ✓ unreal.EditorLevelLibrary.get_editor_world()
```

## 路径 API 返回相对路径（project_plugins_dir 实测坑）

```python
# ✗ unreal.Paths.project_plugins_dir()
#   → 返回 '../../../../S1Game/Plugins/'（相对路径！）
# ✗ os.path.join(该相对路径, ...)  # 编辑器 CWD=项目根，解析成 D:\S1Game\Plugins，不存在
# ✓
unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_plugins_dir())
#   → 'D:/GRMain/S1Game/Plugins/'（绝对路径；输入已是绝对路径时原样返回，安全）
```

实测编辑器进程 `os.getcwd()` = `D:\GRMain\S1Game`（项目根，非 Engine/Binaries）。
sys.path 里插相对路径条目也能用，但**必须先转绝对路径**。见 [[pie-br-autoflow]] 的引导导入。

## 调 UFUNCTION：call_method 传 tuple

```python
# ✗ comp.call_method('CatchingPlayer', pawn, True)
# ✓ comp.call_method('CatchingPlayer', (pawn, True))     # 参数必须是 tuple
```

先确认目标函数有 `UFUNCTION(BlueprintCallable)`（grep 头文件）；纯 C++ virtual、
CustomThunk（如 `UGMPBPLib`）、以及 C++ 模板（`FGMPHelper`）**都调不到**。

## 属性名与 C++ 不同

`Failed to find property 'X'` 基本都是名字对不上（`asset_tags`、`input_data`、
`net_mode`、`select_item_type`、`local_player`…）。**不要连猜**——
`unreal_help("<Type>", filter="<片段>")` 或 `unreal_dump` 一次看全。
连续 2 次这类错误后 `unreal_exec` 会自动提示先自省。

## 输入 / 技能 / Tag / 武器（2026-09-29 飞行员复盘，全部实测）

```python
# 读 tag 名：repr 是空的 {}，用 export_text
tag.export_text()                                  # → '(TagName="Character.Gun.TryEnterADS")'
# ASC 当前拥有的 tag（loose + GE）
c = asc.call_method('GetOwnedGameplayTags', ())
names = [t.export_text() for t in unreal.GameplayTagLibrary.break_gameplay_tag_container(c)]
#   更省事：from GameScript.ueflow import players as pl; pl.tags(pid, contains='Gun')
# ✗ unreal.AbilitySystemBlueprintLibrary                # 不存在
# ✓ unreal.AbilitySystemLibrary.send_gameplay_event_to_actor(actor, tag, unreal.GameplayEventData())
# ✗ asc.call_method('SetLooseGameplayTagCount', ...)      # S1ASC 上不可调 → 用 keys 走真实输入链
# ✗ unreal.GameplayTag.RequestGameplayTag(...)             # 不存在（见本表第一节）

# IA / IMC
ia.get_editor_property('gmp_send_msg_map')         # {TriggerEvent.X: GameplayTag} —— 按键发哪些消息
ia.get_editor_property('triggers')                 # IA 级 trigger；IMC 映射级在 imc.mappings[i].triggers
# ✗ ia.get_editor_property('input_event_triggers_map')   # 本项目 IA 没有这个属性
# GameplayAbilityInputData 的 TagContainer/TagEventType/InputID 反射读不到 → keys.explain / unreal_dump(json2)
# EnhancedInputLocalPlayerSubsystem：✗ local_player.player_controller 读不到；✓ 按 world 匹配：
sub = next(s for s in unreal.ObjectIterator(unreal.EnhancedInputLocalPlayerSubsystem)
           if s.get_world() and s.get_world().get_full_name() == pc.get_world().get_full_name())
sub.query_keys_mapped_to_action(ia)                # [Key]；空 = 当前没有映射（真人也按不出来）
sub.has_mapping_context(imc)                       # 生效返回优先级 int，未生效返回 None
#   以上都封装在 GameScript.ueflow.keys（active_mappings / explain / hold）

# 技能配置 / 武器
ga.get_ability_config().get_editor_property('fall_suspend_tags')   # GeSkill 运行时配置
own = pawn.get_component_by_class(unreal.load_class(None, '/Script/S1Game.GAWeaponOwner'))
inst = own.call_method('GetFirstEquippingInstance', ())             # None = 武器还没装好
inst.get_editor_property('zoom_state')
# ✗ inst.call_method('GetASC', ())    # 非 UFUNCTION；C++ 里武器 ASC = 其 outer actor（pawn）的 ASC

# FGeometry 没有可读成员（2026-10-10 实测）
g = w.call_method('GetCachedGeometry', ())   # UWidget::GetCachedGeometry 是 BlueprintCallable，可调
# ✗ g.get_absolute_position() / g.get_size()   # FGeometry struct 在 Python 里 0 个可读属性，全报错
# ✓ 读 widget 位置改走槽位：slot = w.get_editor_property('slot')（CanvasPanelSlot 时）
#   ld = slot.call_method('GetLayoutData', ())   # 返回 (Offsets FMargin, Anchors FAnchors, Alignment Vector2D)
#   文本化：[s.export_text() for s in ld]
# ✓ 或者直接 unreal_dump(widget BP 资产) 的 json2 序列化视图看设计时 WidgetTree 槽位 LayoutData（protected 也能看）

# 杂项
# ✗ loc[2]（unreal.Vector 不可下标）  ✓ loc.z；pl.location(...) 返回的是 tuple 可下标
# ✗ gsc_skill.call_method('IsActive', ())   # GeSkill 实例上找不到；判断激活看 signals.ga_activated/ga_ended 日志
```

---

**Why**：这些错误单个都很小，但连撞会吃掉大量往返（实测 34% 的 `unreal_exec` 调用失败），
而且它们**无法从 C++ 源码推断**（反射改名、protected、参数形状都只在运行时暴露）。
**How to apply**：写 `unreal_exec` 前若对名字没把握，先查本表；表里没有就
`unreal_help(symbol, filter=...)` / `unreal_dump`，不要 dir() 盲试。撞到新坑请补进本表。
