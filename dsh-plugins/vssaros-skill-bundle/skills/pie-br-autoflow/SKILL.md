---
name: pie-br-autoflow
description: PIE 直开 BR（NordLand）到自动跳伞 + 落地的全自动流程（进局约 16 分钟、较易崩）；只在 bug 依赖 BR 地图/流程时用，其余用 pie-rush-autoflow 训练场。无需 WSL/大厅/输入，recipe + 信号表 + 实测坑（含多客户端 all_landed），实现代码 Content/GameScript/ueflow/br.py（旧 pie_br_flow.py 为兼容垫片）
displayName: "PIE 直开 BR 直到「自动跳伞成功 + 落地」（无需 WSL/大厅，全自动零输入）"
---

# PIE 直开 BR 直到「自动跳伞成功 + 落地」（无需 WSL/大厅，全自动零输入）

> 目标：从编辑器未启动/已启动开始，完全自动地把玩家送进 BR 对局（NordLand），
> 等到自动跳伞成功并落地。2026-09-17 端到端实测跑通一局。

## 什么时候用
- PIE 进 BR 大图做战斗/玩法调试，不想搭大厅/WSL/DS。
- 复现「进局 / 飞机 / 跳伞 / 落地」阶段 bug（做 bug 单前置环境）。
- 自动化「PIE 启动 → 进局 → 跳伞成功」全链路冒烟。

## 什么时候不用
- **bug 不依赖 BR 地图/流程**（技能、特效、数值、UI 等）→ 用 Rush 训练场（skill `pie-rush-autoflow` 备用路径）。
  - 训练场约 107s 进 Fighting；NordLand 进局约 16min，而且更容易崩（BR PIE BeginPlay 加载 AI 投放资产时崩过多次）。
- 需要 登录/选角色/建大厅 数据 → 本路线没有大厅环节（PIE 同进程服务器+客户端**直接进局**），
  完整大厅链路见 memory `editor-client-to-local-ds-fullflow` / `game-mode-unreal-exec-tips`。
- 需要驱动按键/UI/技能 → 见 skill `ue-pie-repro` 的输入阶梯；本路线全程被动无需输入。

## 原理（为什么不需要任何按键/指令/作弊码）
1. PIE = 同进程服务器(`UEDPIE_0_NordLand`) + 客户端(`UEDPIE_1_NordLand`)，`PlayNetMode=PIE_Client`。
2. 进局后玩家自动上飞机(RingShip)，航线结束 `RingShip::DetachAllPlayers` 强制全员离机 = 自动跳伞。
3. 降落伞自动展开（引擎保底 CVar `a.AnimSkill.Parachute.EnableSafetyNet` 默认 1）。
4. 落地后 Pawn 移动模式 = MOVE_WALKING。
5. ⚠️ 实测：PIE 直开模式 **FlightMgr GUVObject 不挂载**（全日志无 LogFlightMgr），
   加速器（`DetachFromShip`/`ActivateParachute`）在本模式无实例可调（完整 DS 对局才有）——
   被动流程是唯一且最可靠的路径，`pbr.force_jump()/activate_parachute()` 返回
   `no-server-flight-mgr` 属正常，不是失败。

## 唯一可执行实现
`GameScript/ueflow/br.py`（`Content/GameScript/ueflow/br.py`，GameScript 独立仓库，版本需与 skills 配合）。
`Content/Python` 在编辑器启动时已由 `init_unreal.py` 注入 sys.path，
**每个编辑器会话一次引导导入即可**（unreal_exec 命名空间持久，之后全程可用 `pbr.*`）：

```python
from GameScript.ueflow import br as pbr
```

旧引导方式仍然兼容：同目录 `pie_br_flow.py` 现在是兼容垫片，
`import pie_br_flow as pbr` 指向同一个 `GameScript.ueflow.br` 模块对象。
所有等待用 `unreal_wait`（宿主侧轮询）；模块内**禁止 sleep**（cell 在 GameThread 同步执行，sleep 冻结引擎）。

## 全流程 recipe（按顺序执行）
0. 编辑器：`unreal_editor_manager status`；未运行则 `start`（`wait_until_ready=true`，首启 2-5min）。
   然后执行上方「引导导入」代码块（`from GameScript.ueflow import br as pbr`）。
   若 PIE 已在跑：`pbr.end_pie()` → `unreal_wait(condition="not pbr.in_pie()")`。
1. **预热**（编辑器首启后只做一次；跳过也行，只是首局更慢）：
   - `unreal_exec`: `pbr.preheat()`（timeout_seconds=600）
   - `unreal_wait(log_pattern=pbr.LOG_NMT_WELCOME, timeout_seconds=300)`
   - `unreal_exec`: `pbr.end_pie()` → `unreal_wait(condition="not pbr.in_pie()", timeout_seconds=300)`
2. **开图+优化+Play**：
   - `unreal_exec`: `pbr.prepare_map()`（timeout_seconds=600；load_level 同步 1-2min + 5 条 Play 前优化命令）
   - `unreal_exec`: `pbr.begin_pie()`（默认单客户端；两个玩家：`pbr.begin_pie(clients=2)`，`UEDPIE_1/2` 为两个客户端）
3. **等进局**（期间**不要**频繁 unreal_exec 探测——GameThread 被大图加载占满，unreal_exec 60s 超时(HTTP 504)是正常现象）：
   - `unreal_wait(log_pattern=pbr.LOG_NMT_WELCOME + '|' + pbr.LOG_FIGHTING, timeout_seconds=1500, poll_interval_seconds=5)`
   - 实测：NMT_Welcome 417.9s、Fighting +105.2s（预热后首局；冷启动可能 10min+）
4. **玩家确认**：
   - `unreal_exec`: `pbr.player_snapshot()`
   - 预期：`pc=BP_S1PlayerController_Default_C_0`、`pawn=BP_GameCharacter_C`、在飞机上（MOVE_FALLING，z≈5000）
5. **等自动跳伞 + 落地**（全被动，零介入）：
   - `unreal_wait(log_pattern=pbr.LOG_SHIP_JUMP, timeout_seconds=900)` — DetachAllPlayers 强制离机
   - `unreal_wait(log_pattern=pbr.log_parachute_end(pid), timeout_seconds=600)` — 跳伞完成（服务器侧，玩家特定）
   - `unreal_wait(condition="pbr.landed()", timeout_seconds=300)` — 落地 Walking
     （多客户端用 `pbr.all_landed()`：`landed()` 只看第一个客户端的玩家）
   - 实测：Fighting → AI 起跳 ~20s → DetachAllPlayers ~95s → OnParachuteEnd ~106s → 落地 1-2min
6. **收尾**：`pbr.report()` 打印 `[LANDED]` 汇总；留 PIE 继续调试或 `pbr.end_pie()` 退出。

## 判定信号表（2026-09-17 实测，可直接 grep）
| 阶段 | 信号 | 来源 |
|---|---|---|
| 进局 | `NMT_Welcome Welcomed` (Level: /Game/Maps/Nord/UEDPIE_0_NordLand) | LogKeyStep |
| 开战 | `SkillState from [WarmUp] to [Fighting]` | LogGameUniverseSubsystem |
| 自动跳伞触发 | `DetachAllPlayers` | LogRingShip |
| 跳伞完成 | `OnParachuteEnd] PlayerId = [<pid>]` | LogSkydiving（服务器侧） |
| 落地 | pawn movement_mode 含 `MOVE_WALKING`（`pbr.landed()`） | Python 探测 |

pid 从 `pbr.get_player_id()` 取（实测 257）。

## 坑（全部实测）
- cell 内 sleep 被 AST 守卫拦截；任何等待用 `unreal_wait`。
- `wp.Runtime.EnableServerStreaming 1` 等优化命令**必须在 Play 前**（运行中执行无效）。
- PIE world 全名是 `World /Game/Maps/Nord/UEDPIE_0_NordLand.NordLand` —— UEDPIE 前缀**嵌在路径中**，
  匹配要用「包含」并排除 `/Memory` 瞬态副本（`_is_world_of` 已处理）。
  2026-09-28 修复：`core.is_pie_world` 以前用完整地图路径拼 `UEDPIE_<n>_<路径>`，永远匹配不上。
  后果是 `player_snapshot()` 返回 None、`landed()` 永远等不到。现在按地图短名 `UEDPIE_\d+_<短名>` 匹配。
- 多客户端时角色解析一律用 `GameScript.ueflow.players`（pid ↔ 客户端，零缓存；见 skill `ue-pie-repro`）。
- 运行时 GUVObject（FlightMgr 等）**不在全局对象数组**（ObjectIterator 只能看到 CDO），
  只能走 `PlayerState → GeSkillComponentBase.get_all_use_skills()`。
- player_id：`pc.get_editor_property('player_state').get_editor_property('player_id')`
  （`get_player_state()` / `get_player_id()` 方法在 Python 绑定不存在）。
- 等日志用 `unreal_wait(log_pattern=...)`（只扫新追加行）；回溯全文才用 grep（`order="tail"`）。
- 编辑器/PIE 卡死：`unreal_editor_manager stop force=true` 可能失败，改用 pwsh
  `Get-Process UnrealEditor | Stop-Process -Force`。强制杀后重启若在启动阶段崩
  StructuredArchive 断言（Invalid scope for writing to archive）→ 删
  `Intermediate/CachedAssetRegistry_*.bin` 再启动（memory
  `editor-startup-crash-structuredarchive-delete-assetregistry`）。
- PIE 运行中禁止 `unreal_find_asset`（AssetRegistry 全库扫描会崩，Class.cpp:6927 断言）。
- 编辑器崩了：`unreal_wait` / `unreal_exec` 会自动中止并附崩溃诊断（已知签名 + 处置）。
  - 手动查：`unreal_editor_manager action=crash_report`。
  - StructuredArchive 资产反序列化崩溃：`action=start` 默认 `clean_caches=auto`，会自动隔离 AssetRegistry 缓存，不用手删。
  - 刚起编辑器就 `prepare_map()`、崩点每次不同（签名 `nested-startup-compile`，2026-10-21 一晚 17 次）：是插件启动钩子嵌套在载图里编译
    蓝图，bridge 已规避，不是 NordLand 本身"易崩"——见 `ue-pie-repro` 的 section `crash-freeze`。

## 什么时候需要升级手段
- 要登录/大厅/建房 → WSL 私服链路（memory `editor-client-to-local-ds-fullflow`，脚本在 `Scripts/LocalDs/`）。
- 要按键/UI/技能输入 → skill `ue-pie-repro` 输入阶梯（TryExecActionByBool > lua.do GMP > 服务器 BlueprintCallable；`Gauntlet.InputKey` 在 PIE 无效）。
- 要 GM 指令（刷怪等）→ 引擎修复已在本机实现并验证（2026-09-21，改 PythonScriptPlugin：
  PIE 下不启用 FEditorScriptExecutionGuard，判据 `GEditor->PlayWorld != nullptr`——不能用
  `GIsPlayInEditorWorld`）。提交并 sync 后，Python 里可直接用 `ServerCMD xxx`（含
  `LoadDSProtocol`/`RushKillAllMonster` 等自回发型 GM，会正常跨网络到服务器执行、不再
  递归崩）。在那之前，未同步修复的机器上避免从 Python 裸执行这两个命令
  （`prf.cheat()` 有 FORBIDDEN_CHEATS 保护）；详见 memory `engine-python-rpc-guard-fix`。

## 相关
- memory `pie-dev-debug`（预热/优化命令/关键时间线）· skill `pie-rush-autoflow`（切 RUSH 模式同构流程）
- skill `ue-pie-repro`（驱动输入）· `ue-python-api-gotchas`（API 形状坑速查）
