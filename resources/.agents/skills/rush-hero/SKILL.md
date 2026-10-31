---
name: rush-hero
description: 为Rush模式英雄技能添加技能等级养成（天赋）参数的完整操作指南，覆盖Tag注册、配置表、C++代码、蓝图资产所有步骤，基于天使技能CBT2改造实战总结
displayName: "Rush 英雄技能等级养成（天赋参数）添加指南"
---

# Rush 英雄技能等级养成（天赋参数）添加指南

> 基于开发者对 Hero07（天使）CBT2 三个技能（被动/战术/大招）添加天赋养成支持的实际提交总结。

---

## 一、背景与目标

Rush 模式下，英雄技能可以通过"技能等级养成"（天赋树）系统进行数值增强。策划在 Excel 中配置天赋参数后导入引擎，C++ 代码通过 `USkillTalentQueryHelper` 读取天赋修正后的参数值。

### 天使天赋系统重构 (CBT2) 完整图景

本次重构涉及天使（Hero07）的 **被动 / 战术 / 大招** 三个技能槽位，分 4 个 commit 完成，是理解整个流程的最佳实例：

#### 提交概览

| 技能槽位 | 提交标识 | 涉及文件数 |
|----------|---------|:--------:|
| 被动 | 变更-被动 | 4 |
| 战术 | 变更-战术 | 6 |
| 大招 | 变更-大招 | 12 |
| 大招(补充) | 变更-大招补充 | 1 |

#### 各技能改动对比

| 维度 | 被动 | 战术 | 大招 |
|------|:------------:|:------------:|:--------------------:|
| **代码重构** | Pipeline 过滤统一化<br>TalentQuery API 迁移 | — | — |
| **新增天赋参数** | — | `RecoveryCountTime`<br>`HealIncreaseRatio` | `CDTime`<br>`HealIncreaseRatio` |
| **删除旧参数** | — | — | `DyingTeleportTime`<br>`MaxTeleportTimes`<br>`TeleportRecoverHealth` |
| **天赋效果** | — | `OnGiveAbility` 修改冷却时间<br>所有治疗 × 倍率 | `OnGiveAbility` 设 CD<br>治疗 Buff 加倍率<br>BP 区域加 ModifierRatio<br>召唤物 CountLimit 接口 |
| **配置表清理** | 删除 `TargetDistanceFilter`<br>删除 `DistanceProviderStruct` | — | — |
| **天赋树调整** | 移除 `RescueDuration`<br>移除 `RescueFullHealth` | 新增 2 个参数节点 | 新增 2 个参数节点 |

#### 公共改动（跨所有提交）

| 文件 | 改动 |
|------|------|
| `S1SkillTalentTagSettings.h` | 新增 4 个 `FGameplayTag` UPROPERTY |
| `DefaultGame.ini` | 4 个 Tag 映射注册 |
| `SkillTags.ini` | GameplayTagList 同步 |
| `DA_SkillTalent_ImportExportConfig.uasset` | 参数导入导出注册 + 清理旧参数 |
| `DA_SkillTalentTree_Hero_Female_Hero07.uasset` | 天赋树节点配置 |

#### 框架层改动

| 文件 | 改动 |
|------|------|
| `GeRTSPComponent.h/cpp` | Buff 数据结构新增 `ModifierMagnitudeRatio` 及 Pipeline 动态计算 |
| `GeSkillSummonedSubSystem.h/cpp` | 新增 `ReachCountLimit` 接口 |

本指南覆盖为一个技能添加新的天赋参数所需的**全部文件改动**。

---

## 二、涉及文件清单（务必逐项核对）

### 2.1 C++ 代码文件（Framework 层）

| 文件 | 路径 | 改什么 |
|---|---|---|
| Tag 配置头文件 | `S1Game/Source/S1Framework/S1Game/Public/Managers/S1SkillTalentTagSettings.h` | 新增 `FGameplayTag` UPROPERTY 声明 |

### 2.2 INI 配置文件

| 文件 | 路径 | 改什么 |
|---|---|---|
| 游戏配置 | `S1Game/Config/DefaultGame.ini` | 在 `[/Script/S1Game.S1SkillTalentTagSettings]` 段新增 Tag 映射 |
| Tag 注册表 | `S1Game/Config/Tags/SkillTags.ini` | 在 `GameplayTagList` 中注册新 Tag |

### 2.3 引擎资产（uasset）

> ⚠️ **ImportExportConfig 和 TalentTree 不应手动编辑。** 它们应通过 XLSX 导入工具（菜单 → S1 Game → 技能天赋导入导出 → 导入技能天赋XLSX，或 Python 调用 `US1PythonSkillTalentBridge`）自动生成。参见步骤 2c。

| 文件 | 路径说明 | 改什么 |
|---|---|---|
| 天赋导入导出配置 | `S1Game/Content/AssetDatas/Rush/SkillTalent/DA_SkillTalent_ImportExportConfig.uasset` | **由 XLSX 导入工具自动注册**参数列映射 |
| 天赋树 | `S1Game/Content/AssetDatas/Rush/SkillTalent/SkillTalentTree/DA_SkillTalentTree_Hero_Female_HeroXX.uasset` | **由 XLSX 导入工具自动生成**节点、数值、层级 |
| 技能 Config DataAsset | `S1Game/Content/BluePrints/Abilities/HeroAbilities/HeroXX/<SkillSlot>/Config_*.uasset` | 如有 UPOPERTY 变更需重新保存 |
| 技能 GA Blueprint | `S1Game/Content/BluePrints/Abilities/HeroAbilities/HeroXX/<SkillSlot>/GA_*.uasset` | C++ 父类变更后自动重编 |
| 其他 Blueprint | 视具体技能而定（如 `BP_Shepherd_Ultimate_Area.uasset`） | 需同步更新 BP 节点引用 |

### 2.4 C++ 技能代码文件

| 文件 | 路径模式 | 改什么 |
|---|---|---|
| 技能 Header | `S1Game/Source/S1BRGame/GeSkill/<HeroFolder>/GeSkill<Hero>_<Skill>.h` | 新增 include、Overrride、Struct |
| 技能 CPP | `S1Game/Source/S1BRGame/GeSkill/<HeroFolder>/GeSkill<Hero>_<Skill>.cpp` | 新增 include、OnGiveAbility/ActivateAbility 中读取天赋值 |

### 2.5 可能涉及的 GenericSkill 插件（框架层）

| 文件 | 路径 | 场景 |
|---|---|---|
| GeRTSPComponent.h/cpp | `S1Game/Plugins/GenericSkill/Source/GenericSkill/Public/TargetSelectPipeline/` | 需要在 Buff 数据结构中新增 pipeline 动态参数时 |
| GeSkillSummonedSubSystem.h/cpp | `S1Game/Plugins/GenericSkill/Source/GenericSkill/Public/SubSystems/` | 需要新增召唤物相关接口时 |

---

## 三、详细步骤

### 步骤 1：注册 GameplayTag

#### 1a. `S1SkillTalentTagSettings.h`

在对应 Hero 区段新增 UPROPERTY，遵循已有命名规范：

```cpp
// 命名规范：SkillTalent_Param_{HeroXX}_{SkillSlot}_{ParamName}
// HeroXX: Hero07, Hero04 等
// SkillSlot: Passive / Tactical / Ultimate
// ParamName: 驼峰命名，描述参数含义

/** 注释说明参数用途 */
UPROPERTY(config, EditAnywhere, Category = SkillTalentParam)
FGameplayTag SkillTalent_Param_Hero07_Tactical_RecoveryCountTime;

UPROPERTY(config, EditAnywhere, Category = SkillTalentParam)
FGameplayTag SkillTalent_Param_Hero07_Tactical_HealIncreaseRatio;
```

**关键要求：**
- `Category = SkillTalentParam` 必须一致
- `config` 标记使该 Tag 可以从 ini 文件读取
- 注释格式：`/** 中文说明 */`
- 参考已有属性的位置插入，保持 Hero07 相关属性聚集

#### 1b. `Config/DefaultGame.ini`

在段 `[/Script/S1Game.S1SkillTalentTagSettings]` 下新增：

```ini
SkillTalent_Param_Hero07_Tactical_RecoveryCountTime=(TagName="SkillTalent.Param.Hero07.Tactical.RecoveryCountTime")
SkillTalent_Param_Hero07_Tactical_HealIncreaseRatio=(TagName="SkillTalent.Param.Hero07.Tactical.HealIncreaseRatio")
```

**Tag 命名规范：** `SkillTalent.Param.{Hero}.{SkillSlot}.{ParamName}`

#### 1c. `Config/Tags/SkillTags.ini`

在 `GameplayTagList` 中按字母顺序插入新 Tag：

```ini
GameplayTagList=(Tag="SkillTalent.Param.Hero07.Tactical.HealIncreaseRatio",DevComment="")
GameplayTagList=(Tag="SkillTalent.Param.Hero07.Tactical.RecoveryCountTime",DevComment="")
```

**注意：** 不要在已有条目的行尾添加，每条独立一行。

---

### 步骤 2：通过 XLSX 导入更新天赋资产（uasset）

> ⚠️ **ImportExportConfig 和 TalentTree 由 XLSX 导入工具自动维护，切忌手动编辑。**  
> 手动编辑易出错（字段格式、editor_title/editor_description 等只读属性无法设置），且策划 Excel 才是数据源。

#### 2a. `DA_SkillTalent_ImportExportConfig`（参考）

该 DataAsset 的 `skill_arg_mappings` 定义了 SkillID → 参数列映射（arg1→ParamTag, arg2→ParamTag, ...）。
**由 XLSX 导入工具根据 Excel 第2行（arg1, arg2, ...）和第1行中文描述自动注册。**

#### 2b. `DA_SkillTalentTree_Hero_Female_HeroXX`（参考）

该 DataAsset 存储每个英雄的天赋树：
- `skill_base_params`：各参数的 Level 1 基础值（无天赋时的默认值）
- `talent_nodes`：天赋节点列表（每个节点有 `talent_node_id`、`param_modifiers`、`prerequisite_node_ids` 等）

**由 XLSX 导入工具根据 Excel 数据行自动生成节点和数值。**

#### 2c. 从 Python 调用 XLSX Bridge 导入 （执行）

> **如果 `S1PythonSkillTalentBridge` 尚不存在**，需要在 `S1Editor` 模块中创建该桥接类，源代码参见[附录](#附录xlsx-bridge-工具源码)。创建后 Live Coding 编译 → 重启编辑器（Python 包装类型在启动时重新注册），然后即可直接调用：

```python
import unreal
from GameScript.ueflow import paths as P   # P.WORKSPACE_DIR = <工作区>/（ExcelTables 所在）

# 直接调用（编辑器重启后 unreal 模块才注册 S1PythonSkillTalentBridge）
result = unreal.S1PythonSkillTalentBridge.import_skill_talent_xlsx(
    P.WORKSPACE_DIR + 'ExcelTables/Rush/Hero/Hero07_Rush.xlsx')
print(f"Import: {'OK' if result else 'FAILED'}")
```

功能等价于菜单按钮「S1 Game → 技能天赋导入导出 → 导入技能天赋XLSX」，复用同一底层逻辑（`FXlsxReader` + `FSkillTalentImporter`）。

> **注意：** `Cheat.ImportSkillTalent` 控制台命令只接受 CSV（从编辑器导出的格式），**不支持直接导入 xlsx**。需要 xlsx 导入时使用上述 Bridge。

**XLSX 格式要求**（每个 Sheet = 一个技能）：

| 行 | 内容 | 示例 |
|----|------|------|
| 第1行 | 中文描述表头 | `英雄ID, 英雄备注, 技能ID, 分支, 等级, 充能CD（覆盖）, 治疗倍率\n（覆盖）` |
| 第2行 | 字段名 | `HeroID,,SkillID,SkillBranch,SkillLevel,arg1,arg2,...` |
| 第3行+ | 数据行 | `200070000,天使战术,100072,1,1,35,1`（Level 1 为 BaseValue） |

**关键约定：**
- `TalentNodeId = SkillID * 10000 + Branch * 100 + Level`
- **Level 1 特殊处理**：写入 `skill_base_params`（基础数值），不生成天赋节点
- 表头包含 `（覆盖）`/`（乘法）`/`（加法）` 后缀 → 自动推断 `operation` 类型；默认为 Add
- **空单元格 = 该等级不修改此参数**（不放入 `param_modifiers`）

---

### 步骤 3：C++ 代码集成 — 在技能中读取天赋值

#### 3a. 必备 include

在 `.cpp` 中新增：

```cpp
#include "Managers/S1SkillTalentTagSettings.h"       // 用于 GET_S1SKILLTALENTTAG_CONFIG_VAR 宏
#include "SkillTalent/SkillTalentQueryHelper.h"       // 用于 USkillTalentQueryHelper
```

如果要在 `.h` 中写 Provider struct，则 `.h` 中需要（注意：`S1GeSkillBlueprintLibrary.h` 文件名与类名 `UGeSkillBlueprintLibrary` 不同，必须按实际头文件名 include）：

```cpp
#include "ISTargetSelectPipeline/ISTargetSelectPipelineManager.h"
#include "Managers/S1SkillTalentTagSettings.h"
#include "GeSkill/SkillTalent/SkillTalentQueryHelper.h"
#include "S1GeSkillBlueprintLibrary.h"
```

#### 3b. 核心 API：`USkillTalentQueryHelper::GetTalentModifiedFloat()`

```cpp
static float GetTalentModifiedFloat(
    const UObject* WorldContext,           // this 或 SourceActor，用于定位 WorldSubsystem
    UAbilitySystemComponent* OwnerASC,     // 技能拥有者的 ASC（通常 GetSkillComponent()）
    const FGameplayTag& SkillParamTag,     // 天赋参数 Tag
    float BaseValue);                      // 基础值（无天赋修正时返回此值）
```

**在非 Rush 模式下自动返回 BaseValue，无需额外判断。**

#### 3c. 模式一：OnGiveAbility 中一次性设置

适用场景：技能初始化时需要读取天赋值来修改技能自身属性（CD、能量等）。

```cpp
void UGeSkillAngel_UltimateAreaAbility::OnGiveAbility(
    const FGameplayAbilityActorInfo* ActorInfo, 
    const FGameplayAbilitySpec& Spec)
{
    Super::OnGiveAbility(ActorInfo, Spec);
    UGeSkillComponentBase* SkillComponentBase = GetSkillComponent();
    IfReturn(SkillComponentBase);
    
    // 读取天赋修正后的 MaxEnergy
    float const NewMaxEnergy = USkillTalentQueryHelper::GetTalentModifiedFloat(
        SkillComponentBase,                              // WorldContext
        SkillComponentBase,                              // OwnerASC
        GET_S1SKILLTALENTTAG_CONFIG_VAR(SkillTalent_Param_Hero07_Ultimate_CDTime),  // Tag
        GetMaxEnergy());                                  // BaseValue = 类默认值
    
    MaxEnergy = NewMaxEnergy;
    DefaultConsumeEnergy = NewMaxEnergy;
    InitEnergyInfo();
}
```

**关键点：** BaseValue 应该使用**类 Archetype（CDO）中的默认值**，而非实例当前值：

```cpp
// ✅ 正确：用 Archetype 的默认值作为 BaseValue
if (UGeSkillAngel_Heal* ArcheType = Cast<UGeSkillAngel_Heal>(GetArchetype()))
{
    RecoveryCountTime = USkillTalentQueryHelper::GetTalentModifiedFloat(
        this, SkillComponentBase, 
        GET_S1SKILLTALENTTAG_CONFIG_VAR(SkillTalent_Param_Hero07_Tactical_RecoveryCountTime), 
        ArcheType->RecoveryCountTime);   // Archetype 默认值
}

// ✅ 正确：用 Archetype 的 InteractDistance 作为 BaseValue
InteractDistance = USkillTalentQueryHelper::GetTalentModifiedFloat(
    GeSkillComponent, GeSkillComponent, 
    GET_S1SKILLTALENTTAG_CONFIG_VAR(SkillTalent_Param_Hero07_Ultimate_TeleportDistance), 
    ArcheType->InteractDistance);
```

**注意：** 如果重写 `OnGiveAbility`，必须在对应的 `.h` 类声明中加入：
```cpp
virtual void OnGiveAbility(const FGameplayAbilityActorInfo* ActorInfo, const FGameplayAbilitySpec& Spec) override;
```

#### 3d. 模式二：ActivateAbility 中使用点读取

适用场景：每次技能激活时需要根据天赋修正某个值。

```cpp
void UGeSkillAngel_Heal::ActivateAbility(...)
{
    // ... 其他逻辑 ...
    
    // 读取治疗倍率，默认值为 1.0（即无加成）
    const float HealIncreaseRatio = USkillTalentQueryHelper::GetTalentModifiedFloat(
        this, 
        SourceSkillComponent, 
        GET_S1SKILLTALENTTAG_CONFIG_VAR(SkillTalent_Param_Hero07_Tactical_HealIncreaseRatio), 
        1.0f);  // 默认 100%
    
    // 将倍率应用到所有治疗值
    auto ApplyHealIncreaseRatio = [&](TMap<FGameplayTag, float>& ModifierMagnitudeMap)
    {
        for (auto& Pair : ModifierMagnitudeMap)
        {
            Pair.Value *= HealIncreaseRatio;
        }
    };
    
    // 对自身治疗
    {
        TMap<FGameplayTag, float> ModifierMagnitudeMap;
        // ... 设置各种治疗值 ...
        ApplyHealIncreaseRatio(ModifierMagnitudeMap);  // ← 关键：应用天赋修正
        UGeSkillBlueprintLibrary::ApplyPredictHealBuffToTarget(...);
    }
    
    // 对队友治疗
    {
        TMap<FGameplayTag, float> ModifierMagnitudeMap;
        // ... 设置各种治疗值 ...
        ApplyHealIncreaseRatio(ModifierMagnitudeMap);  // ← 同样应用
        // ...
    }
}
```

#### 3e. 模式三：定义新的 DynamicDoubleProvider（Pipeline 集成）

适用场景：Buff 的 ModifierMagnitude 需要通过 Pipeline 动态计算（如 GE RTSP Component 的 Buff），需要将天赋倍率包装成 Provider。

```cpp
// 在 .h 中定义新 Struct
USTRUCT(BlueprintType)
struct S1BRGAME_API FGeSkillDynamicDouble_Hero07UltHealIncreaseRatio : public FGeSkillDynamicDoubleProviderBase
{
    GENERATED_BODY()
    GESKILL_GENERATED_BODY_DYNAMIC_DOUBLE_PROVIDER(FGeSkillDynamicDouble_Hero07UltHealIncreaseRatio)

    template <typename PayloadType, typename Allocator>
    double Provide(const TGeSkillPipelineTargetContainer<PayloadType, Allocator>& InTargets, 
                   const FGeSkillPipelineContext& Context) const
    {
        const FGameplayTag& TalentTag = GET_S1SKILLTALENTTAG_CONFIG_VAR(
            SkillTalent_Param_Hero07_Ultimate_HealIncreaseRatio);
        if (AActor* SourceActor = Context.GetSourceActor())
        {
            if (AActor* Instigator = SourceActor->GetInstigator())
            {
                UGeSkillComponentBase* InstigatorASC = 
                    UGeSkillBlueprintLibrary::GetSkillComponent(Instigator);
                return USkillTalentQueryHelper::GetTalentModifiedFloat(
                    Instigator, InstigatorASC, TalentTag, 1.0f);
            }
        }
        return 1.0f;  // 默认无修正
    }
};
```

**这个 Provider 可以在 Blueprint 的 RTSP Component Buff 中作为 `ModifierMagnitudeRatio` 的 `DynamicProvider` 使用。**

#### 3f. 代码风格规范

- **不允许**直接在代码中使用宏 `GET_ABILITY_CONFIG_VAR_TALENT_VALUE`（该宏走 Config 中转，已不推荐）
- **必须**直接调用 `USkillTalentQueryHelper::GetTalentModifiedFloat()`
- Tag 获取统一使用 `GET_S1SKILLTALENTTAG_CONFIG_VAR(SkillTalent_Param_XXX)`
- 在 `OnGiveAbility` 中初始化的字段如果依赖 CDO 值，从 `GetArchetype()` 获取

---

### 步骤 4：框架层改动（按需）

#### 4a. GeRTSPComponent — 新增 Buff 动态倍率

当需要在 RTSP Component 的 Buff 数据中支持动态倍率时：

**GeRTSPComponent.h** — 在 `FGeSkillRTSPComponent_Buff` struct 中新增：
```cpp
UPROPERTY(EditDefaultsOnly, meta=(UIMin = 0.f))
FGeSkillDynamicDouble ModifierMagnitudeRatio {1.0f};
```

需要 include：
```cpp
#include "ISTargetSelectPipeline/ISTargetSelectPipelineManager.h"
```

**GeRTSPComponent.cpp** — 在 `GiveOrRemoveSkillGameplayAbilitiesOrBuff` 中使用：
```cpp
// 读取动态倍率
static FName Tag = "UGeRTSPComponent::GiveOrRemoveSkillGameplayAbilitiesOrBuff";
TGeSkillPipelineTargetContainer<AActor*, TInlineAllocator<64>> TargetContainer;
FGeSkillPipelineContext Context{GetOwner(), nullptr, nullptr, Tag};
const float ModifierMagnitudeRatio = SkillBuff.ModifierMagnitudeRatio.GetValue(TargetContainer, Context);

// 应用倍率到 ModifierMagnitudeMap
TMap<FGameplayTag, float> ModifierMagnitudeMap = SkillBuff.ModifierMagnitudeMap;
for (auto& Pair : ModifierMagnitudeMap)
{
    Pair.Value *= ModifierMagnitudeRatio;
}
```

#### 4b. GeSkillSummonedSubsystem — 新增召唤物数量限制查询

当需要根据天赋修改召唤物数量上限时：

**头文件新增：**
```cpp
bool ReachCountLimit(AActor* Owner, TSubclassOf<AGeSkillActorBase> Class);
```

**实现要点：**
```cpp
bool UGeSkillSummonedSubsystem::ReachCountLimit(AActor* Owner, TSubclassOf<AGeSkillActorBase> Class)
{
    // 从已有召唤物实例读取 CountLimit（因为天赋在 OnGiveAbility 中已修改 CDO）
    // fallback 到类默认值
    if (const AGeSkillActorBase* ClassDefaultObject = Class.GetDefaultObject())
    {
        // ... 查找已有召唤物，取任意一个的 CountLimit 判断
        // 如果还没有生成召唤物，使用 ClassDefaultObject->CountLimit
    }
    return false;
}
```

---

### 步骤 5：资产更新

#### 5a. Config DataAsset 重新保存

如果 C++ 类中删除或新增了 UPROPERTY：
1. 在 UE Editor 中打开 Config DataAsset
2. 如有被删除属性的残留数据，直接保存即可自动清理
3. 确认所有剩余配置值正确

#### 5b. GA Blueprint 重新编译

C++ 父类变更后：[SKILL.md](SKILL.md)
1. 在 UE Editor 中打开 GA Blueprint
2. 点击 Compile
3. 保存

**验证：** GA uasset 变化通常极小（<100 bytes），主要是序列化偏移；如果出现功能性字符串变更（如新增/删除节点引用），需要确认是否与 C++ 改动一致。

#### 5c. 其他相关 Blueprint

如果新增了 DynamicProvider 类型的 struct，相关 BP 需要：
1. 将该 BP 中使用的 DynamicProvider 替换为新的类型
2. 设置 `bUseDynamicProvider = true`
3. 保存

---

### 步骤 6：提交策略

建议按以下顺序分多次提交：

1. **Tag 基础设施**：`S1SkillTalentTagSettings.h` + `DefaultGame.ini` + `SkillTags.ini`
2. **C++ 技能代码**：技能 `.cpp/.h` 改动
3. **资产**：配置表 uasset + 技能 uasset

如果框架层有改动（如 GeRTSPComponent、GeSkillSummonedSubsystem），单独一个提交，因为它影响范围更大。

---

## 四、完整验证清单

| # | 检查项 | 如何验证 |
|---|---|---|
| 1 | Tag 头文件声明 | `S1SkillTalentTagSettings.h` 中 `Category = SkillTalentParam` 且 config 修饰 |
| 2 | DefaultGame.ini 映射 | `TagName` 字符串与代码中 GET_S1SKILLTALENTTAG_CONFIG_VAR 的 Tag 名一致 |
| 3 | SkillTags.ini 注册 | GameplayTagList 包含新 Tag，DevComment 可为空 |
| 4 | ImportExportConfig | uasset 中包含新参数条目 |
| 5 | TalentTree | 天赋树节点配置了正确的层级、操作类型、每级数值 |
| 6 | include 头文件 | `.cpp` 中包含了 `SkillTalentQueryHelper.h` 和 `S1SkillTalentTagSettings.h` |
| 7 | 使用直接 API | 代码中调用 `USkillTalentQueryHelper::GetTalentModifiedFloat()` 而非旧的宏 |
| 8 | BaseValue 来源 | OnGiveAbility 中使用 `GetArchetype()->` 获取 CDO 默认值 |
| 9 | Config DataAsset | 删除旧属性的残留数据已清理，文件大小应合理减小 |
| 10 | GA Blueprint | 重新编译后保存，变化量应为微量（<200 bytes） |
| 11 | 框架层改动 | GeRTSPComponent / GeSkillSummonedSubSystem 的改动单独评估影响范围 |
| 12 | 非 Rush 兼容 | `GetTalentModifiedFloat` 在非 Rush 模式下自动返回 BaseValue（无需额外判断） |

---

## 五、常见错误与排查

### 错误 1：Tag 未注册导致编译失败
```
error: 'SkillTalent_Param_Hero07_Tactical_XXX' was not declared
```
→ 检查 `S1SkillTalentTagSettings.h` 和 `DefaultGame.ini` 是否都已添加。

### 错误 2：运行时天赋无效
→ 检查 `SkillTags.ini` 是否注册了 Tag，确认 TagName 字符串与代码完全一致。

### 错误 3：ImportExportConfig 导入不生效
→ 优先使用 XLSX Bridge 导入（步骤 2c）。如果手动编辑，确保 `S1SkillTalentTagSettings` 中 Tag 已在 `SkillTags.ini` 注册，否则 `GameplayTag` 为无效状态。

### 错误 4：多次读取导致 BaseValue 叠加
→ 在 OnGiveAbility 中应使用 `GetArchetype()` 获取原始默认值，而非使用实例当前值。因为实例可能已被之前的天赋修正修改过。

### 错误 5：Pipeline Provider 不工作
→ 检查继承 `FGeSkillDynamicDoubleProviderBase` 是否正确，是否有 `GESKILL_GENERATED_BODY_DYNAMIC_DOUBLE_PROVIDER` 宏。

### 错误 6：Provider Struct 的 include 缺失导致编译失败
→ 如果 Provider 中调用了 `UGeSkillBlueprintLibrary::GetSkillComponent()`，确保 include 了 `S1GeSkillBlueprintLibrary.h`（注意：文件名 `S1GeSkillBlueprintLibrary.h` 与类名 `UGeSkillBlueprintLibrary` 不同）。

### 错误 7：`S1PythonSkillTalentBridge` 在 Python 中找不到
→ Live Coding 新增的 C++ 类不会立即注册进 Python 反射。重启编辑器后 `unreal` 模块才包含它。
如果等不及重启，用控制台命令：`S1Editor.ImportSkillTalentXlsx <xlsx路径>`

---

## 附录：XLSX Bridge 工具源码

C++ 桥接工具位于 `S1Editor` 模块，复用菜单按钮 `导入技能天赋XLSX` 的底层逻辑（`FXlsxReader` + `FSkillTalentImporter`）：

| 文件 | 路径 |
|------|------|
| 头文件 | `S1Game/Source/S1Editor/Public/S1PythonSkillTalentBridge.h` |
| 实现 | `S1Game/Source/S1Editor/Private/S1PythonSkillTalentBridge.cpp` |

```cpp
// S1PythonSkillTalentBridge.h
UCLASS()
class S1EDITOR_API US1PythonSkillTalentBridge : public UBlueprintFunctionLibrary
{
    GENERATED_BODY()
public:
    UFUNCTION(BlueprintCallable, Category = "Python|SkillTalent")
    static bool ImportSkillTalentXlsx(const FString& XlsxPath);
};
```

控制台命令（`.cpp` 中注册）：
```
S1Editor.ImportSkillTalentXlsx <xlsx路径>
```
