# 代码图谱（codebase）交接与工具面收敛：实测记录

> 2026-10-20/21 · 面向"接手这条链路的人"：怎么量、量到了什么、哪些坑不要再踩。

## 0. 一句话现状

**能力面**：`@vssaros/dsh-codebase` 21 个工具全部移植完成并逐个实测过（只读 24 项 + 写路径 11 项）。
**执行权**：已按"甲档"交接 —— dsh 写 `<ws>/.codebase-memory/`（`producer: vssaros-dsh`），IDE 见producer 即让路、只读 + 10s 轮询重载。
**性能**：一次索引 ≈ 7s（增量）/ 15s（全量重建）；空跑不再重写 135MB 缓存、也不再 gzip 编码。

## 1. 怎么量（别靠感觉）

```bash
# 真机看护测量：只读采样，不写盘、不碰索引锁 ⇒ Host 跑着也能测
npm run codebase:watch-metrics -- --minutes 8            # 报告
npm run codebase:watch-metrics -- --minutes 8 --json > metrics.json

# ★ 一条命令出 before/after 对比表（同一把尺）
npm run codebase:watch-save                              # 测一次并存成基线 doc/codebase-watch-baseline.json
npm run codebase:watch-compare                           # 再测一次并与基线对比（均值/最快/最慢/空跑/缓存重写/降级 + ✓✗）
#   仓库里已存了一份 0.6.80 的基线：doc/codebase-watch-baseline-2026-10-21.json

# ★★ 改完插件源码后的"一条龙"：等新版本上机 → 测 → 与基线对比（宿主会自己换进程）
npm run codebase:watch-verify
#   等不到会**如实说**"仍未上机"并继续测当前这版（不假装 ✓）

# 交接状态（一次性）
npm run codebase:handover -- --status                    # 谁产的图 / 多少节点 / watch / 锁
npm run codebase:handover -- --build                     # 首次全量建图（treesitter + 2 万文件预算）
```

`watch-metrics` 回答四个问题，数据全部来自现场（`index-meta.json` 的 history + 缓存 mtime）：

| 问题 | 数据源 |
|---|---|
| 跑了几次、每次多久 | meta.history 的 `ms` |
| 其中几次是**空跑**（nodes/edges 逐字相同） | 相邻 history 行的节点数对比 |
| **增量缓存被重写几次**（= 省下的 135MB 写盘） | `index-cache.json` 的 mtime 变化次数 |
| 档位有没有被**静默降级** | history 每行的 `parser` |

## 2. 量到的数字

### 2.1 单次索引的成本分解（13,300 文件的真机工作区）

| 阶段 | 耗时 | 备注 |
|---|---|---|
| 扫描（只列目录） | 0.4–0.6s | |
| 建图（从缓存复原结构） | 7.7–9.0s | 38 万符号节点 + 80 万条边 |
| 真解析变更文件 | 1.4s | `reused 13,295 / parsed 3~6` |
| gzip 编码图（19.7MB） | 4.7s | **A 档优化后：指纹相同则整段跳过** |
| 序列化缓存（135.7MB） | 0.7s | **0.6.78 起：没变就不写** |
| 写盘 | 0.25s | |

⇒ **瓶颈不是"读文件"**（缓存里存了 `size`+`mtimeNs`，未变文件本来就不读），
而是**整图重建 + gzip 编码**。

### 2.2 before / after

| 指标 | before（0.6.76 真机 4 分钟） | after（0.6.80 真机 6 分钟） |
|---|---|---|
| 索引次数 / 单次耗时 | 3 次 · 14,368 / 15,711 / 16,545ms（**均值 15,541ms**） | 7 次 · 5,565–12,643ms（**均值 7,588ms**）⇒ **-51%** |
| 其中**空跑**（内容没变） | 未单独统计（每次都重写缓存） | **5 次**，单次 5,565–7,227ms（编码被跳过 ⇒ 省得最多 ✓） |
| 空跑时缓存重写 | **每次都写 135MB** | **不写**（6 次空跑里 0 次重写 ✓） |
| 空跑时 gzip 编码 | 每次都做 | **不做**（指纹相同 ⇒ `encodeSkipped` ✓） |
| 档位 | 曾被 `auto` 静默降成 regex（39.3 万节点 → 9.9 万） | 覆盖层钉死 `parser: treesitter` ⇒ 不再降 ✓ |
| 图是否跟得上代码 | 是 | 是（398,041 → 398,049 节点，跟上并发编辑 ✓） |

> 基线原始数据：`doc/codebase-watch-baseline-2026-10-21.json`（`npm run codebase:watch-compare` 可随时再比一次）。

## 3. 踩过的坑（每个都带"怎么发现的"）

1. **缓存根比较大小写敏感** ⇒ 同一目录只差 `g:` / `G:` 就算"别的��作区" ⇒ 缓存被拒 ⇒ **每次全量重解析**
   （`reused=0 / parsed=13,299`，真解析 ~90s）**而且不报错**。修法：win32 按小写比较；`selfCheck` 双向断言。
   ⇒ **"缓存被拒"是最坏的失败形态**：慢，但看起来一切正常。
2. **`auto` 档会静默降级**：上次实测文件数 > 阈值 3000 ⇒ 降成 regex 快档 ⇒ 把 39.3 万节点的图**覆盖成 9.9 万**
   （方法 / CALLS / USAGE 整族消失）。修法：覆盖层显式 `parser: treesitter` + 插件侧"沿用上次档位"。
3. **watcher 的增量预算**：不传 maxFiles 时默认 1500；甲档下"增量"也按它**扫描** ⇒ 会把全量图**缩掉**。
   ⇒ 覆盖层必须写 `indexMaxFiles: 20000`。
4. **watcher 首次不能代劳交接**：工作区里还是 IDE 产的图时，watcher 的增量预算会覆盖它 ⇒ 插件侧加安全闸
   （`handoverNeedsInitialBuild`：清单存在、有节点、producer 不是我们的 ⇒ 拒写并打 warn）。
5. **临时脚本里 `apply({indexWatch:true})` 会自己起 watcher 并占住 `index.lock`** ⇒ 真机 Host 的 watcher 全部
   `kind=locked`（`runs` 涨到 1103 而图一动不动，看着像"卡住"）。**纪律**：临时脚本不要传 `indexWatch`；跑完确认没有残留 node 进程。
6. **一个 NUL 字节 ⇒ 整份源码被当二进制跳过**：`codebaseGraphService.ts` 用了字面 NUL 做复合键分隔符 ⇒ 371KB 的关键文件
   整体不参与文本搜索（`skippedBinary=2176`）。修法：按 **NUL 密度**判二进制，不是"出现过一次就跳过"。
7. **文本搜索的固定预算**：默认 4000 个文件，在 2.3 万文件的仓里"按名字找 `src/` 下的文件"会 **0 命中**（看着像"没这个文件"）。
   修法：`maxFiles` 可调 + `findFiles` 缺省自动覆盖全仓 + 截断时**点名预算**。

## 4. 不变量（改动时守住）

- 交接三键必须一起：`indexTarget: workspace` + `indexWatch: true` + `indexMaxFiles`（缺一条都会静默退化）。
- 覆盖层必须显式 `parser: treesitter`（否则 `auto` 会按规模降档）。
- 图的"内容指纹"= 文件 hash 聚合 + 解析档 + **配方版本** + 节点/边计数。改"提取/构图语义"必须 **+1 配方版本**，
  否则"代码变了但文件没变"会被判成"图没变"⇒ 图谱停在旧语义上。
- 跳编码还有第二道闸：**图文件大小**必须与 meta 记的一致（防有人动过/截断过盘上那份）。
- 缓存的"工作区根"比较：win32 按小写，其他平台逐字。
- `index-meta.json` 里带 `graphFingerprint` / `graphRecipe` / `encodeSkipped` ⇒ 优化在真机上是**看得见的数据**。

## 5. 还没做的

- **真正的增量图**（只补丁变更文件的符号/边）⇒ 能再省"整图重建"的 ≈7.7s；工程量大，且判据失误就是图谱变旧 ⇒
  建议等 A 档跑几天、确认收益稳定再上。
- **`codebase_export_artifact` / `import_artifact` / `delete_project` / ADR 写入**在真仓上还没跑过（只在临时工作区测过 ✓）。
- IDE 侧仍会把自己的图同步进 `graph.db.sqlite`（39 万节点一次性导入，内存峰值高）⇒ 只影响首次加载速度。
