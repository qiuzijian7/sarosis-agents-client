# 开发笔记

## 游戏项目代码位置记录

| 功能模块 | 相关文件 |
|---------|---------|
| **GM代码** | `S1GameCheatExtension` |
| **Rush 空投** | `RushAirDropActor`、`GUVObject_GenerateAirDrop_Rush` |
| **BR 空投** | `S1AirDropActorBase`、`GUVObject_GenerateAirDrop` |

---

### 详细说明

#### GM 代码
- **`S1GameCheatExtension`** — GM（作弊/调试）功能扩展类

#### Rush 模式 · 空投相关
- **`RushAirDropActor`** — Rush 模式空投 Actor，继承自 `RushAirDropActorBase`，包含最新/历史标记、信标管理、圈内判断等功能
- **`GUVObject_GenerateAirDrop_Rush`** — Rush 模式空投生成管理器，继承自 `UGUVObject_GS`，负责触发时机、落点计算、信标刷新等逻辑

#### BR 模式 · 空投相关
- **`S1AirDropActorBase`** — BR 模式空投 Actor 基类，包含 `bIsNewest`/`OnRep_IsNewest`/`BecomePrevious`/`IsSafe`/`GetGenerateAirDropGA` 等功能
- **`GUVObject_GenerateAirDrop`** — BR 模式空投生成管理器，Tick 中监听 `RootGA` 的 `Fighting` 状态触发，落点依赖 `ARingActor`（毒圈）计算

---

*最后更新：2026-05-27*
