# saros-agents-client Memory 策略

> 项目跨会话记忆子系统的总体策略文档：列举各项手段的实现方案与未来优化方向。
>
> 最后更新：2026-05-25

---

## 一、总体定位

> 应用层负责"记什么、记到哪、怎么找回来"，推理层负责"重复内容不重算"，跨 agent 协作层负责"画像怎么合并不污染"。三层职责正交。

---

## 二、各项手段的实现方案

### 2.1 全量

**作用**：不丢任何历史信息。

**实现现状**：通过 **TDB-AM L0 Raw Log** 实现。每一轮对话原封不动落盘到本地 SQLite + jsonl，永不删除。

- 写入端点：`POST /capture`
- 落盘位置：`~/.saros/.tdai/l0/<session>.jsonl` + SQLite `l0_conversations`
- 不进 prompt（避免长会话爆 context），仅作为可追溯的真相之源

**提升优化方向**：
- **冷热分层**：3 个月以上的 L0 自动转冷归档，仅保留 L1/L2/L3 抽取出的精华
- **加密落盘**：腾讯域合规，敏感信息（token / 内部 URL / TAPD 工单号）需在写入前过滤或加密
- **owner 标记**：每条 L0 强制带 `owner` 字段，为未来 agent 分享场景铺路

---

### 2.2 滑动窗口

**作用**：控制 prompt token 占用，保留最近 N 轮原文供模型直接参考。

**实现现状**：saros 聊天主链路默认保留近 N 轮消息。TDB-AM 召回的内容拼在窗口之外，互不冲突。

**提升优化方向**：
- **窗口大小自适应**：根据当前模型 context 容量动态调整（hunyuan-turbo 32K 与 hunyuan-large 256K 应该不同）
- **滑出即触发抽取**：滑出窗口的内容立即送 L1 抽取（而非等 session 结束），避免崩溃丢失
- **保留关键 turn**：用户主动标记的"重要回合"豁免滑动，永远在窗口内

---

### 2.3 摘要压缩

**作用**：把窗外冗长内容压缩成精炼信息，腾出 context 空间。

**实现现状**：直接由 **TDB-AM L1/L2** 实现：
- L1 Atomic Memory：抽取单条结构化事实（"用户在用 UE5 + World Partition"）
- L2 Scene Block：把同一任务下的多条 L1 聚合成完整场景上下文

L1/L2 抽取由后台 pipeline 异步触发，调用 LLM 完成，比朴素的"塞一段摘要"精度更高。

**提升优化方向**：
- **抽取 prompt 调优**：在 L1 抽取提示词里显式要求"保留文件路径 / 函数名 / 错误码 / 命令行原文"，避免 IDE 场景关键信息被压缩掉
- **抽取频率自适应**：默认每 5 轮触发一次 L1，长任务可降到 3 轮，闲聊可拉到 10 轮
- **多级摘要**：L1 之上再做"周摘要 / 月摘要"，覆盖跨长时间的项目脉络

---

### 2.4 混合方案

#### 2.4.1 三区记忆

**作用**：把记忆分为「核心区 / 工作区 / 归档区」，分别管理进 prompt 的资格。

**实现现状**：TDB-AM 四层金字塔已自然映射：

| 三区 | 对应 TDB-AM 层 | 进 prompt 频率 |
|------|---------------|---------------|
| 核心区（始终在 prompt） | L3 Persona + 高频 L1 | 每次 |
| 工作区（当前任务） | L2 Scene Block | 召回相关 |
| 归档区（按需召回） | L0 Raw Log | 几乎不进 |

不需要单独再实现一套三区系统。

**提升优化方向**：
- **核心区显式打标**：用户能在 UI 把某条 L1 钉为"核心区永驻"，避免被自动淘汰
- **工作区主动切换**：当用户从"调试 LevelSequence"切到"写动画蓝图"，工作区应立即换内容
- **核心区容量上限**：避免无限增长，超过阈值时按访问频率淘汰

#### 2.4.2 KV Cache

**作用**：相同 prompt 前缀不在推理服务端重复计算 attention。

**实现现状**：
- KV Cache 物理上在推理服务端 GPU 显存里，客户端不存 KV
- saros 已消费上游 API 返回的 `prompt_tokens_details.cached_tokens` / `cache_read_input_tokens`，UI 显示 KV 命中数
- 应用层做的事：**让 prompt 拼接顺序保证前缀稳定**

```
[System 固定]              ┐
[L3 Persona]               ├ 稳定前缀，KV cache 高命中
[高频 L1]                  ┘
─── 边界 ───
[召回的 L2/L1 动态段]      ┐
[滑动窗口最近 N 轮]        ├ 动态部分，每次不同
[当前 query]               ┘
```

**提升优化方向**：
- **Knot 链路 KV metric 透传**：当前 KnotBridge 不解析 Knot 返回的 prompt cache 元信息，导致走 Knot 时 UI 看不到命中数。需在 bridge 里收集 metadata 并填回 OpenAI `usage` 字段
- **prompt 模板审计**：核对 TDB-AM 内部抽取调用的 prompt 是否也遵循"稳定前缀在前"的顺序
- **核心区指纹**：当 L3 / 高频 L1 内容变了立即触发命中率监控，避免不知不觉破坏 prefix cache

---

### 2.5 TencentDB-AM

**作用**：长期记忆基础设施，承载 L0/L1/L2/L3 全部数据与抽取 pipeline。

**实现现状**：
- Electron 主进程 spawn 独立 Node 子进程（vendor TdaiGateway），监听 `127.0.0.1:8420`
- 召回策略：`keyword`（FTS5 + jieba 中文分词），关闭 embedding / 向量召回
- 存储：SQLite + WAL，本地落盘
- LLM 调用：经 Knot Bridge（`127.0.0.1:8421`）翻译 OpenAI 协议为 Knot AG-UI 协议
- UI 浏览：saros 主仓内置 ViewPane，显示 L0/L1/L2/L3 四层

**提升优化方向**：
- **同义词词表**：UE / 腾讯内部术语映射（"复制 ↔ Replication"、"关卡序列 ↔ LevelSequence"），提升中文 keyword 召回
- **冷启动数据灌入**：把已有 CodeBuddy 历史批量喂入 TDB-AM，瞬间获得带历史经验的 Persona
- **编辑 / 删除能力**：vendor 加 `/edit/memory` `/delete/memory` API，让用户能修正错误抽取
- **冲突检测增强**：L1 去重当前依赖关键词检测，可加入 LLM 语义判重

---

### 2.6 第三方 mem 插件

**作用**：作为 TDB-AM 的对照基线 / 后备方案。

**实现现状**：仅 PoC 分支保留 Mem0 的接入参考，**不上生产**。

- 主要原因：TDB-AM 在腾讯域内有合规、Knot 网络、中文场景三重优势
- Mem0 的 Graph Memory 在 codebase 依赖关系记忆场景下有差异化价值，但当前 PoC 阶段不引入

**提升优化方向**：
- **保持 Provider 接口干净**：saros 的 `IMemoryProvider` 接口已经支持多 Provider 优先级注册（tdb-am-memory=80 > 内置=50），未来切换或并存其他 mem 系统不需要改主仓
- **基准测试套件**：建立可重复的召回质量评测集，定期对比 TDB-AM vs Mem0 的命中率，为是否切换提供数据支撑
- **降级机制**：当 TDB-AM gateway 不可用时，自动降级到第三方 / 内置 mem，保证 chat 不被记忆故障阻塞

---

### 2.7 Memory 合并升级（分享 agent 时需要）

**作用**：当 agent 被分享给其他用户、或多个 agent 共享同一份 memory 时，正确融合不同来源的画像与事实。

**实现现状**：**当前未实现**。这是为多用户协作场景预留的能力。

**核心问题**：
- Persona 冲突：用户 A 偏好 C++，用户 B 偏好 Rust，agent 该信谁？
- 事实冲突：A 用 UE 5.4，B 用 UE 5.3，同时存还是取最新？
- 身份污染：共享 agent 不应该让 B 看到 A 的 TAPD 工单号
- 重复抽取：同一份 L0 被两个 agent 各抽一遍 L1，产生重复条目

**分层合并策略**：

| 层 | 合并策略 |
|----|---------|
| L0 Raw | **不合并**，按 owner 物理隔离 |
| L1 Atomic | **三向合并**，按 (owner, scene) 去重 |
| L2 Scene | **按 owner 隔离**（场景是私人任务上下文）|
| L3 Persona | **多 Persona 并存**，调用按 caller 取分支 |

**提升优化方向（按落地优先级）**：
1. **schema 预留**（**立即做，成本极低**）：每条记忆从 L0 开始就强制带 `owner` / `userId` / `agent_id` 字段；现在永远填 `default` 也无所谓，关键是字段在
2. **召回 owner 过滤开关**（**立即做**）：即使现在永远是同一 owner，也提前打开过滤，将来不需要重写召回逻辑
3. **L3 Persona 接口多用户化**（**立即做**）：从 `getPersona()` 改为 `getPersona(userId)`，单例语义改为 `Map<userId, Persona>`
4. **导出 / 导入 API**（短期做）：用户能把自己的 memory 拿走或带到新机器，是合规基线
5. **冲突检测 UI**（中期做）：合并产生冲突时给用户裁决界面，而不是静默 last-wins
6. **合并审计日志**（中期做）：记录每次合并的来源 / 时间 / 冲突解决方式，可回滚
7. **三向合并算法实现**（agent 真正分享时再做）：核心算法引擎，参考 git 三向合并思路

**风险提示**：第 1-3 项现在不做，未来 agent 分享需求一来就得整体重构 schema 和召回逻辑，存量数据迁移工作量极大。

---

## 三、总体提升方向（跨手段）

### 3.1 用户感知与控制权

- **V1 透明可见**已实现（侧边栏 ViewPane 显示 L0/L1/L2/L3）
- **V2 可编辑**待做：用户能改 / 删 / 钉住 / 打敏感标签
- **V3 主动展示**待做：Agent 在回复中说"我用了哪条记忆"，做成可配置开关

### 3.2 写入感知 / 隐私

- 用户必须能在写入瞬间标记"敏感，不记录"
- 自动识别并过滤 token / 内部 URL / 工单号等敏感模式
- 这是腾讯域合规硬要求

### 3.3 监控与可观测性

- 召回命中率 / 抽取耗时 / KV Cache 命中数 全埋点
- 每个 session 的 token 花费可视化
- 异常场景告警（gateway 宕机、抽取连续失败）

### 3.4 跨设备 / 跨平台

- memory 数据本地 SQLite 当前不跨设备同步
- 短期：手动 export / import
- 长期：可选的云端备份（合规审批后）

---

## 四、主流 Agent 应用 Memory 策略对比

下面横向对比 4 个有代表性的开源 / 商业 agent 应用的 memory 设计，作为 saros 选型与未来优化的参考。

### 4.1 速览矩阵

| 维度 | OpenClaw | Hermes Agent | OpenHuman | Claude Code |
|------|----------|--------------|-----------|-------------|
| 出身 | 腾讯云 Agent 框架 | NousResearch（社区，4 万星） | TinyHumans（开源，Rust + Tauri） | Anthropic 官方 |
| 协议 | 闭源 | MIT | GNU GPL3 | 商业 |
| 记忆架构 | 原生 Memory Core + 可挂 TencentDB-AM | **4 层**（常驻 / 会话归档 / Skill / Honcho） | **3 层 Memory Tree**（主题 → 实体 → 文档）+ Obsidian vault | **双系统**（CLAUDE.md 人写 + MEMORY.md 自动） |
| 长期检索 | TencentDB-AM 接管时用 keyword/向量 | **SQLite + FTS5**，检索后再 LLM 摘要 | GraphRAG + 噪声修剪 | 按需读取 topic 文件 |
| 自进化 | 不强调 | **Learning Loop + 自动 Skill 创建** | 潜意识循环（20min 自动同步） | 有限（仅自动记笔记） |
| 数据来源 | 仅对话 | 对话 + skill 沉淀 | **118+ OAuth 集成**（邮件/日历/repo/notion） | 仅对话 + 代码库 |
| 落盘形态 | DB 不开放 | SQLite + 双文件（`MEMORY.md` / `USER.md`） | SQLite + Markdown vault（用户可编辑） | Markdown 文件（用户可编辑） |
| KV Cache 设计 | 无 | **冻结快照模式**（首次读，会话内不刷） | TokenJuice 压缩（−80% token） | Anthropic Prompt Caching |
| 跨会话能力 | 强（接 TDB-AM 后） | 强 | **极强**（持续后台同步） | 中（每次新会话重读 .md） |
| 用户可编辑 | 间接 | 是（Markdown 文件） | 是（Obsidian 兼容） | 是（直接编辑 .md） |
| 隐私边界 | 本机 | 本机 | 本机加密 vault | 本机 |
| 适合场景 | 接 TencentDB 生态 | 长期个人助理、自进化 | 个人 super agent、多源整合 | IDE coding 场景 |

### 4.2 各家关键设计亮点

#### OpenClaw（参照基线）
- 分两套：原生 **Memory Core**（轻量）+ 可选 **TencentDB-AM 插件**（四层金字塔 L0-L3）
- 两套**共存互补**——原生 core 负责短期，TDB-AM 负责长期沉淀
- PersonaMem 准确率 **48% → 76%**（接 TDB-AM 后）
- 数据物理留在用户 Lighthouse 实例本机

#### Hermes Agent（最近的"记忆派标杆"）
最值得借鉴的 4 个设计：
1. **常驻提示记忆**：`MEMORY.md` + `USER.md` 两个文件，**总字符上限 3575**——故意收窄逼用户精选
2. **冻结快照**：会话开始时把 memory 注入 system prompt，**会话内不再刷新** —— 这是为了**保持 KV cache prefix 稳定**，避免每次记忆更新就让 cache 失效。读写分离（中途写磁盘，下次会话才读取）
3. **Skill 系统作为程序化记忆**：把成功的工作流抽象成 skill，下次直接复用，token 成本几乎不变，技能库可以从 40 个增长到 200 个
4. **三级渐进式加载**：技能索引（几十 token）→ 摘要（几百 token）→ 完整内容（按需调入）

#### OpenHuman（最激进的"长记忆"方案）
- **Memory Tree** 三层结构：高级主题（工作/家庭/财务）→ 实体（人/公司/repo）→ 原始文档（邮件/笔记/commit）
- **20 分钟自动获取**：连接 OAuth 后每 20min 后台拉数据，无需手动喂
- **TokenJuice 压缩**：HTML→Markdown、URL 缩短、ASCII 清理，token −80%
- **Obsidian vault 兼容**：记忆同时是 Markdown 文件，用户可直接打开浏览编辑
- 灵感来自 Karpathy 公开提的 "LLM wiki" 概念

#### Claude Code（IDE 场景代表）
- **双系统设计**：
  - **CLAUDE.md**（人写）——指令、规范、工作流约定，每次会话全量加载
  - **MEMORY.md**（Claude 自己写）——构建命令、调试见解、用户偏好，每次会话加载前 200 行作为索引
- **多层级**：托管策略（IT 管） → 用户级（`~/.claude/`） → 项目级（git 共享） → 本地级（gitignore）
- **路径范围规则** `.claude/rules/*.md` —— 通过 frontmatter `paths` 字段把指令限定到特定文件类型，按需加载
- **导入机制** `@path/to/file` —— 复用其它 markdown 文档，最多 5 层递归
- **prompt cache** 由 Anthropic API 层做，CLAUDE.md 内容自动享受缓存

### 4.3 saros 当前位置（自我对照）

| 维度 | saros 现状 | 对照同类 |
|------|------------|---------|
| 架构 | TencentDB-AM L0/L1/L2/L3 + FTS5 + jieba | 与 OpenClaw + TDB-AM 路径一致 |
| 召回 | keyword（FTS5） | 与 Hermes 同（FTS5） |
| KV cache | 上游 metric 消费 | 弱于 Hermes 冻结快照 |
| Skill 系统 | 无（只有 memory，没有程序化记忆） | 弱于 Hermes / Claude Code |
| 数据源 | 仅对话 | 弱于 OpenHuman（118 集成） |
| 用户可编辑 | ⚠️ 阶段 C 待做 | 弱于 Claude Code / OpenHuman |
| 自进化 | 无 | 弱于 Hermes Learning Loop |
| 跨设备 | 无 | 与多数同类一致（本机） |

### 4.4 可借鉴的 5 个具体设计

1. **【高优先级】采用 Hermes 的"冻结快照"模式** ——
   saros 当前 prompt 里 Persona/L1 是动态生成的，每次都可能小变 → KV prefix cache 命中率不稳。
   改造：会话开始读一次 Persona+高频 L1，整段 freeze 进 system prompt，会话内不刷新；下次新会话再读最新版。
   收益：prefix cache 命中率显著提升，**这是性能优化的最大杠杆**。

2. **【高优先级】引入 Claude Code 风格的 `CLAUDE.md` 等价物** ——
   现在 saros 的"用户偏好"全靠 TDB-AM 自动抽取（容易抽错），但**有些规则用户希望一锤定音**（"永远用 pnpm"、"提交前跑 npm test"）。
   做法：在工作区根目录支持 `.saros/AGENT.md`，每次会话强制加载到 system prompt 前段。**人写规则 + AI 抽取偏好** 双系统，互不取代。

3. **【中优先级】引入 Hermes 的 Skill 系统** ——
   memory 是"事实/偏好"，skill 是"操作流程"。两者职责不同，混在一起会越用越乱。
   做法：让用户能把"修复 LevelSequence 重连问题"这种**多步流程**封装成可复用 skill，下次直接调用。
   saros 已经有 skill 概念（agent-studio/skills），可扩展为程序化记忆层。

4. **【中优先级】Token 压缩 pipeline 借鉴 OpenHuman TokenJuice** ——
   IDE 场景下 L0 里有大量 HTML、长 URL、Stack trace。
   做法：写入 L0 前做一次轻量压缩（HTML→Markdown、长 URL 缩短、重复栈帧合并），不影响信息完整性，存储和召回都更快。

5. **【低优先级】用户可编辑的 Markdown 落地** ——
   现在 L1/L2/L3 用户只能看（V1 阶段），不能改。Claude Code / OpenHuman 都允许用户直接 vim 改 markdown。
   做法：提供 "导出当前 L1 列表为 markdown → 用户编辑 → 导入回 SQLite" 的工作流，作为阶段 C 编辑能力的过渡方案。

### 4.5 我们应该警惕的"反面"

- **OpenHuman 的"118 集成 + 自动同步"在企业域不可行** —— 邮件/Slack/repo 数据同步进 memory 在腾讯内部是合规雷区，Reject。
- **Hermes 的 3575 字符上限不能照搬** —— 它是 chat assistant 场景，saros 是 IDE 场景，代码片段必然更长，应当根据上下文容量动态调整。
- **Claude Code 的 CLAUDE.md 直接 inject 用户消息** —— 是个简化设计，saros 已用更复杂的 capability provider 架构，不需要降级。

---

## 五、未来 30 天行动清单（按价值排序）

1. **memory 合并 schema 预留** — owner / userId / agent_id 字段进 L0/L1/L2/L3，现在做成本极低，不做未来重构成本巨大
2. **冻结快照模式**（借鉴 Hermes）— Persona/L1 会话内不刷新，最大化 KV prefix cache 命中
3. **`.saros/AGENT.md` 人写规则**（借鉴 Claude Code）— 双系统补足"AI 抽不到 / 抽错了"的硬性约束
4. **KnotBridge 透传 prompt cache 元信息** — 让走 Knot 也能看到 KV 命中
5. **写入感知 / 敏感信息打标** — 腾讯域合规
6. **Skill 系统集成**（借鉴 Hermes）— 把多步流程沉淀成程序化记忆
7. **同义词词表** — UE / 腾讯术语映射，提升中文 keyword 召回
8. **TokenJuice 压缩 pipeline**（借鉴 OpenHuman）— L0 写入前做轻量压缩
9. **prompt 拼接顺序审计** — 确认 KV cache 命中率最大化
10. **冷启动数据灌入** — 把已有 CodeBuddy 历史喂进 TDB-AM
11. **编辑 / 删除 API** — 让用户能修正错误抽取
12. **导出 / 导入 API** — 用户主权基线

---

## 六、一句话总结

> **架构主体已对齐 OpenClaw + TencentDB-AM 路径**（L0/L1/L2/L3 + FTS5 + jieba），**最值得借鉴的是 Hermes 的"冻结快照保 KV cache"和"Skill 程序化记忆"，以及 Claude Code 的"`AGENT.md` 人写规则双系统"**。
> **OpenHuman 的"118 集成 + 自动同步"在腾讯域是合规红线，不能照搬**。
> **memory 合并字段必须现在就预留 owner**，否则未来 agent 分享场景重构成本巨大。

