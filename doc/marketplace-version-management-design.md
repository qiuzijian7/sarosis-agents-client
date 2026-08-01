# 双端版本管理设计方案：客户端 × VsSaros 商城（Agent / Skill / Workflow）

> 版本：v1.0 ｜ 日期：2026-07-31
> 范围：agent、skill、workflow 三类资源在客户端与商城两端的版本管理闭环
> 前置文档：`doc/marketplace-design.md`（商城总体方案）、`doc/marketplace-integration-analysis.md`（统一包抽象）

---

## 1. 背景与现状

### 1.1 客户端现状（已落地）

三类资源各自有基于 isomorphic-git 的**本地版本服务**，模式一致：

| 资源 | 服务 | 追踪对象 | 能力 | 发布联动 |
|------|------|---------|------|---------|
| Agent | `agentVersionService.ts` | `agents/{id}/.agent.md` | init / autoCommit / history / diff / rollback | ❌ 无 tag 方法 |
| Skill | `skillVersionService.ts` | `skills/{id}/` 整个目录 | + status / **tag** | ✅ 发布成功后 `autoCommit` + `tag(vX.Y.Z)`（integrationView.ts:1765） |
| Workflow | `workflowVersionService.ts` | `workflows/{id}/workflow.json` | 同 Agent | ❌ 无 tag 方法 |

- 保存时自动快照：`agentStudioService.updateAgent` → `autoCommit`（agentStudioService.ts:1229）；skill/workflow 同理。
- UI：agent 版本 Tab（agentSettingsEditorPane）、skill 版本区（resourceManagerEditorPane）、workflow 版本面板（workflowVersionPanel）——**三套独立实现**。

商城侧（`marketplaceService.ts` + `common/marketplace.ts`）：

- `publish()`：版本预检仅比对 `latestVersion`（marketplaceService.ts:510），上传 `POST /packages/:id/versions/raw`；`IPublishOptions.changelog` 已支持（`x-changelog` 头）但**上传 UI 无 changelog 输入框**。
- `download(storeId, version, kind)`：支持下载**任意指定版本**。
- `checkUpgrades()`：批量比对 installed-packages.json → 返回 latest + changelog。
- `installed-packages.json`：每包仅一条 `{kind, storeId, version, installedAt}`，无历史、无锁版本。
- 上传 UX（2026-07-31 已落地）：未登录前置拦截 + 版本冲突自动 `_bumpVersion` 重试（仅 agentSettingsEditorPane）。

### 1.2 商城服务端现状（独立服务，仓库外）

按 `doc/marketplace-design.md` 已实现：

- `package_versions` 表：`version / changelog / sha256 / size / is_latest / manifest / created_at`，`UNIQUE(package_id, version)`。
- API：`GET /packages/:slug`（含 versions 列表）、`POST /packages/:id/versions`、`GET .../versions/:version/download`、`DELETE .../versions/:version`（作者）、`POST /upgrade/check`。

### 1.3 核心缺口

```
本地 git 历史（sha，开发态）          商城版本（semver，发布态）
  auto: 2026-07-31 14:00            v1.0.0  ← tag 仅 skill 有
  auto: 2026-07-31 15:30      ??→   v1.1.0  ← agent/workflow 无关联
  publish: v1.1.0 (skill only)
```

1. **双轨脱节**：本地 git sha 与商城 semver 仅靠 skill 的 tag 弱关联；agent/workflow 发布后无法回答"商城 v1.1.0 对应本地哪个 git 状态"。
2. **发布预检弱**：只查 `latestVersion`，不查全量 versions（历史上传过又删除的版本会误判）；不强制 semver 递增。
3. **发布内容不受控**：发布前不检查 git dirty——tar 包内容可能从未进入 git 历史，发布态与开发态永久失联。
4. **无商城版本历史视图**：`getPackage()` 已返回 versions+changelog，客户端无 UI 展示；无法查看/安装历史版本。
5. **changelog 无入口**：协议支持但 UI 未暴露。
6. **无版本锁定**：installed-packages.json 单版本记录，升级只能升到 latest，不能"固定 v1.2.x 不升级"。
7. **版本生命周期缺客户端入口**：服务端已有 `DELETE /versions/:version`，客户端无法下架版本。

---

## 2. 目标与非目标

### 目标
1. 三类资源统一的双轨版本模型：**git = 开发态历史，semver tag = 发布锚点**，二者强关联。
2. 发布流水线统一：dirty 检查 → 版本校验 → changelog → 发布 → 打 tag → 写回本地。
3. 统一版本管理视图：本地 git 历史 + 商城 release 双栏对照，支持双向回滚。
4. 商城侧版本生命周期完整：查看 / 安装指定版本 / 下架版本 / latest 重算。

### 非目标
- 不改动商城服务端的存储模型（package_versions 表已够用）。
- 不引入分支模型（单 main 分支线性历史足够，三类资源都是单人编辑场景）。
- MCP / knowledge 两类不在本期（MCP 无版本概念；knowledge 复用本设计时仅需新增 VersionService）。

---

## 3. 总体设计：双轨版本模型

```
┌─ 客户端（开发态）─────────────────────────────┐
│  ~/.vssaros/{agents|skills|workflows}/{id}/   │
│  ├── .agent.md / SKILL.md / workflow.json     │  ← 编辑
│  └── .git  (isomorphic-git, main 线性)        │  ← autoCommit on save
│       ├── sha-a  auto: ...                    │
│       ├── sha-b  auto: ...                    │
│       └── sha-c  publish: v1.1.0  🏷 v1.1.0   │  ← 发布锚点 (tag)
└──────────────┬────────────────────────────────┘
               │ publish / download
┌──────────────▼────────────────────────────────┐
│  商城（发布态）                                 │
│  package_versions:                             │
│    v1.0.0  sha256  changelog  is_latest=0     │
│    v1.1.0  sha256  changelog  is_latest=1     │
└────────────────────────────────────────────────┘
```

**关联规则**：
- 每次成功发布 → 本地 `tag("v{version}")` 指向发布时打包的 commit。
- 反向溯源：本地 git 历史中带 `v*` tag 的 commit = 商城对应版本的内容快照。
- `installed-packages.json` 记录 `publishedSha`（发布 commit），卸载/重装可校验一致性。

---

## 4. 客户端设计

### 4.1 统一版本服务接口

三个 VersionService 已有 80% 重复代码（init/autoCommit/history/diff/rollback 模式一致）。收敛为统一契约：

```ts
// common/packageVersionTypes.ts（新增，三个现有 types 文件保留 re-export 兼容）
export interface IPackageVersionService {
  isAvailable(): boolean;
  init(id: string): Promise<void>;
  autoCommit(id: string, message?: string): Promise<string | null>;
  history(id: string, limit?: number): Promise<CommitMeta[]>;
  diff(id: string, sha: string): Promise<DiffResult | null>;
  rollback(id: string, sha: string): Promise<void>;
  /** 新增（agent/workflow 补齐，skill 已有）：打发布锚点 tag */
  tag(id: string, tagName: string): Promise<void>;
  /** 新增：列出发布锚点 → 本地历史与商城版本的对照表 */
  listReleaseTags(id: string): Promise<{ tag: string; sha: string }[]>;
  /** 新增：工作区是否有未提交变更（发布预检用） */
  isDirty(id: string): Promise<boolean>;
}
```

实现策略：**不急着重构合并三个类**（风险大、收益低），而是：
- P1 先给 `AgentVersionService` / `WorkflowVersionService` 补 `tag()`（各 10 行，照抄 skillVersionService.ts:346）。
- P2 再抽公共基类 `BaseGitVersionService`，三服务继承，仅配置 `trackedFile` / `dirResolver` 不同。

### 4.2 统一发布流水线 `publishWithVersioning()`

将 agentSettingsEditorPane 的 `_handleUpload`、integrationView 的 skill 上传、resourceManagerEditorPane 的上传三处逻辑收敛到 `MarketplaceService` 上层的一个编排方法：

```ts
// browser/marketplacePublishOrchestrator.ts（新增）
async publishWithVersioning(kind: 'agent'|'skill'|'workflow', localId: string): Promise<void> {
  const vs = this.versionServiceFor(kind);

  // ① 登录守卫（已有 ensureLoggedIn）
  await this.marketplaceService.ensureLoggedIn();

  // ② 权限守卫（agent: canUploadAgent；skill/workflow 类比）
  // ③ 未提交变更检查：dirty 时提示并自动快照，保证发布内容进 git
  if (await vs.isDirty(localId)) {
    await vs.autoCommit(localId, `snapshot: before publish`);
  }

  // ④ 版本号选择（循环直到通过）
  const remote = await this.marketplaceService.getPackage(localId).catch(() => null);
  let version = this.suggestNextVersion(remote);      // latest 基础上 patch+1，无包则 1.0.0
  while (true) {
    const input = await this.dialog.input({
      title: `发布到商城`,
      inputs: [
        { value: version, placeholder: '版本号 (semver)' },
        { value: '', placeholder: '更新说明 changelog（可选）', multiline: true },  // ⑤ changelog 入口
      ],
    });
    if (!input.confirmed) { return; }
    version = input.values[0].trim();

    // ⑥ 强校验：semver 合法 + 不在 remote.versions 中 + > latestVersion
    const err = this.validateVersion(version, remote);
    if (err) { this.notification.warn(err); continue; }

    try {
      const { version: published } = await this.marketplaceService.publish(localId, kind, {
        version, changelog: input.values[1] || undefined, /* 其余 opts 由各 kind 调用方提供 */
      });

      // ⑦ 发布锚点：autoCommit(若还有变动) + tag + 记录 sha
      const sha = await vs.autoCommit(localId, `publish: v${published} to marketplace`)
        ?? await vs.headSha(localId);
      await vs.tag(localId, `v${published}`);
      await this.recordPublishedSha(kind, localId, published, sha);   // 写入 installed-packages.json

      // ⑧ 回写本地清单版本号（skill 已有：同步 SKILL.md frontmatter version）
      this.notification.info(`v${published} 发布成功`);
      return;
    } catch (e) {
      this.notification.error(`发布失败: ${msg(e)}`);
      if (/已存在|already exists/i.test(msg(e))) { version = bumpPatch(version); continue; }
      return;
    }
  }
}
```

**关键规则**：
- `validateVersion`：必须 `x.y.z` 格式；不得命中 `remote.versions` 任一历史版本（防删除后重传覆盖 sha256 不一致）；必须 `semver.gt(version, latestVersion)`。
- 版本冲突自动递增重试的行为从 agentSettingsEditorPane 上移至此，三类资源共用。
- ⑦中"先 autoCommit 再 tag"保证 tag 永远指向包含发布内容的 commit（即使打包后用户又改了文件）。

### 4.3 统一版本管理视图（Version Manager）

三类资源现有的三个版本 UI 收敛为一个可复用组件 `packageVersionPanel`，双栏：

```
┌─ 版本管理 ─────────────────────────────────────────┐
│ 本地历史 (git)              │ 商城版本 (releases)    │
│ ─────────────────────────  │ ─────────────────────  │
│ 🏷 v1.1.0  a1b2c3d  今天    │ ● v1.1.0 (latest)      │
│    publish: v1.1.0         │   changelog: ...       │
│ ○ 9f8e7d6  auto: 15:30     │   [回滚到此版本] [下架] │
│ ○ 5d4c3b2  auto: 14:00     │                        │
│ 🏷 v1.0.0  1a2b3c4  昨天    │ ○ v1.0.0               │
│    publish: v1.0.0         │   [回滚到此版本] [下架] │
│ ─────────────────────────  │ ─────────────────────  │
│ [查看 diff] [回滚(本地)]    │ [安装指定版本▾]         │
└────────────────────────────────────────────────────┘
```

- **左栏**：现有 history/diff/rollback 能力（本地开发态回滚，不进商城）。
- **右栏**：`getPackage().versions` 渲染；操作：
  - **回滚到此版本** = `download(storeId, version, kind)` 覆盖安装（force=true 已支持）→ 安装后 `autoCommit(localId, "rollback: install v1.0.0 from marketplace")` —— 商城回滚也会进入本地 git 历史，双轨不丢。
  - **下架**：调服务端 `DELETE /packages/:id/versions/:version`（客户端新增 `marketplaceService.deleteVersion()`，仅作者可见该按钮）；下架 latest 后提示"商城 latest 将回退到次新版本"。
  - **安装指定版本▾**：下拉任意版本安装（当前 UI 只有 latest）。
- 落地形态：agent 版本 Tab / skill 版本区 / workflow 版本面板均替换为该组件，通过 `kind + localId` 参数化。

### 4.4 installed-packages.json 扩展

```jsonc
{
  "kind": "agent",
  "storeId": "gr-gc-expert",
  "version": "1.1.0",
  "installedAt": "...",
  "pinnedVersion": null,          // 新增：锁定版本（非 null 时 checkUpgrades 跳过或只提醒不升级）
  "publishedSha": "a1b2c3d...",   // 新增：发布锚点 commit（本地是作者时）
  "source": "published"           // 新增：published(自己传的) | installed(商城下载的) | local(纯本地)
}
```

- `source` 字段解决此前 gr-gc 案例的误判：自定义 agent 不该因残留记录被当成"商城已安装"而隐藏上传按钮——判断条件从"记录存在"改为"`source === 'installed'`"。
- 旧格式迁移：读入时缺字段按 `installed` 兼容（维持现状行为）。

### 4.5 升级流程增强

1. `checkUpgrades` 结果中跳过 `pinnedVersion != null` 的项（或在 UI 标记"已锁定"）。
2. 升级前展示 changelog（`IUpgradeInfo.changelog` 已有，当前 UI 未展示）。
3. 升级 = `download(latest)` → 覆盖安装 → `autoCommit("upgrade: v{old} → v{new}")` → tag 不动（tag 只标记自己发布的版本）。
4. 支持"升级到指定版本"（同 4.3 的安装指定版本，复用 download）。

---

## 5. 商城服务端设计（改动点）

现有模型已支撑 90% 需求，仅需小幅增强：

### 5.1 版本唯一性与递增约束（防御性）

- 现有 `UNIQUE(package_id, version)` 保留。
- **新增**：`POST /versions` 时服务端强制 `semver.gt(newVersion, latestVersion)`，否则 409 + `{"error": "新版本号必须大于当前最新版本 v{x}"}`——防止绕过客户端的旧版本客户端/脚本乱传。
  - 例外：管理员 `?force=1` 可覆盖（用于修复错误发布）。

### 5.2 下架与 latest 重算

- `DELETE /versions/:version` 已存在。补充语义：
  - 删除 `is_latest=1` 的版本后，事务内重算：剩余版本中 semver 最大者置 `is_latest=1`，同步 `packages.latest_version`。
  - 删除最后一个版本 → 包保留但 `latest_version=NULL`（列表页显示"暂无版本"），或级联软删包（`status=removed`），**建议前者**，保留元数据与下载统计。
- 可选：`yanked` 标记（软下架，版本仍可被指定版本号下载但不参与 upgrade/check 与 latest 计算）——对标 npm unpublish 政策，P2 再做。

### 5.3 API 增量清单

| 方法 | 路径 | 说明 | 状态 |
|------|------|------|------|
| POST | `/packages/:id/versions` | 增加 semver 递增校验 | 改 |
| DELETE | `/packages/:id/versions/:version` | 增加 latest 重算事务 | 改 |
| GET | `/packages/:slug/versions/:version` | 单版本详情（changelog/sha256/manifest） | 新增（当前只能 getPackage 全量取） |
| POST | `/packages/:id/versions/:version/yank` | 软下架（可选） | P2 |

客户端 `marketplaceService.ts` 对应新增：

```ts
deleteVersion(storeId: string, version: string): Promise<void>;
getVersion(storeId: string, version: string): Promise<IMarketplaceVersion>;
```

---

## 6. 关键场景时序

### 6.1 正常发布（以 agent 为例）

```
用户点击"上传到商城"
 → ensureLoggedIn()                    [未登录→错误通知,拦截]
 → canUploadAgent()                    [非 owner→warn,拦截]
 → versionService.isDirty()
     → autoCommit("snapshot: before publish")
 → getPackage() → 建议 version = bumpPatch(latest)
 → dialog(version + changelog)
 → validateVersion()                   [semver/重复/递增]
 → marketplaceService.publish()
     → 服务端 UNIQUE + 递增校验双保险
 → autoCommit("publish: v1.1.0") + tag("v1.1.0")
 → installed-packages.json: {version, publishedSha, source:published}
 → 同步 .agent.md version 字段
```

### 6.2 商城版本回滚

```
版本视图右栏选择 v1.0.0 → "回滚到此版本"
 → download(storeId, "1.0.0", kind)    [sha256 校验]
 → 覆盖安装到本地目录
 → autoCommit("rollback: install v1.0.0 from marketplace")
 → installed-packages.json.version = "1.0.0"
 → 通知："已回滚到 v1.0.0；商城 latest 仍为 v1.1.0，如需下架请联系…/使用下架按钮"
```

注意区分两个语义：**本地回滚 ≠ 商城回滚**。商城 latest 指针只能前移（发新版）或靠下架重算，不提供"latest 回指"接口，避免下游 checkUpgrades 抖动。

### 6.3 版本冲突自愈

```
发布 v1.0.0 → 409 已存在
 → 错误通知（已落地）
 → bumpPatch → v1.0.1 重新弹框（已落地，上移到 orchestrator 后三类共用）
```

---

## 7. 边界与异常

| 场景 | 处理 |
|------|------|
| 目录名 ≠ manifest id（gr-gc 案例） | 已修（改 id 对齐目录）；`preparePack` 增加校验：目录名 ≠ id 时发布前 warn |
| 本地 .git 丢失（误删目录/换机） | `autoCommit` 自动 re-init；tag 丢失仅影响溯源，不影响发布 |
| 商城不可达 | publish/download 抛错 → 错误通知；本地 git 功能不受影响（离线可用） |
| 并发发布同版本 | 服务端 UNIQUE 约束兜底，后到者 409 → 客户端 bump 重试 |
| 下架版本被本地引用（skillRefs） | 发布 agent 时检查 skillRefs 在商城存在（现有 `_checkPackageExists` 扩展为含版本检查） |
| installed-packages.json 损坏 | 读取失败回退 `[]`（现有行为）；写入用临时文件+rename 防半截写入（P2） |
| 非 semver 版本号（knowledge 的日期版） | validateVersion 按 kind 放行：agent/skill/workflow 强制 semver；knowledge 允许 `YYYY.MM` |

---

## 8. 分阶段实施

| 阶段 | 内容 | 涉及文件 | 状态（2026-07-31） |
|------|------|---------|--------|
| **P0** | Agent/Workflow VersionService 补 `tag()`；发布成功后打 tag（对齐 skill 现状） | agentVersionService.ts、workflowVersionService.ts、三处发布调用点 | ✅ 已完成 |
| **P1** | 发布编排器 `publishWithVersioning()`：dirty 检查、全量版本校验、semver 递增、changelog 输入、冲突重试上移 | 实际落地为共享纯函数 `publishVersioning.ts` + 三处轻量接入（UI 不收敛，见 §8 注） | ✅ 已完成（形态调整） |
| **P1** | installed-packages.json 扩展（source/pinnedVersion/publishedSha）+ 兼容读取；上传按钮判定改用 source | marketplaceService.ts、presetAgentView.ts | ✅ 已完成（source 字段；pinnedVersion/publishedSha 未加） |
| **P2** | 统一版本视图组件（本地 git + 商城 release 双栏、指定版本安装、下架入口） | 新增 `marketplaceVersionsPanel.ts`；workflowVersionPanel / resourceManagerEditorPane 接入；agent 设置页内联实现 | ✅ 已完成 |
| **P2** | 服务端：semver 递增强制、DELETE 版本 latest 重算、GET 单版本详情 | 商城服务端（仓库外） | 📋 补丁清单已产出（`doc/marketplace-server-version-patch-list.md`），待服务端仓库实施 |
| **P3** | yank 软下架、pin 版本 UI、changelog 聚合页、临时文件原子写 | 双端 | ⬜ 未开始 |

> §8 注：发布编排器未做成独立 orchestrator 类。三处发布 UI 形态差异大（dialogService.input / 自定义 modal / 无对话框直发），收敛风险高收益低；实际以共享纯函数模块 `publishVersioning.ts`（parseSemver / compareSemver / bumpPatch / suggestNextVersion / validatePublishVersion / isVersionConflictError，17 项单测）+ 各调用点接入的方式落地，changelog 输入各 UI 自行提供（单行 input 或 textarea）。dirty 快照由"发布成功即 autoCommit + tag"替代（锚点 commit 必然包含发布内容）。

**P0 即可闭环核心价值**（发布态↔开发态关联），P1 解决发布质量与 gr-gc 类误判，P2 是体验完整化。

---

## 9. 验证方案

1. **单测**（沿用 `test/browser/` 模式）：
   - `packageVersionOrchestrator.test.ts`：validateVersion 各分支（重复/非递增/非法格式）、冲突重试、dirty 自动快照。
   - VersionService tag/listReleaseTags/isDirty（skill 已有 tag 测试参照 skillVersionService.test.ts:401）。
   - installed-packages.json 旧格式兼容迁移。
2. **端到端**：gr-gc-expert 回归——发布 v1.0.1 → 本地出现 `v1.0.1` tag → 版本视图右栏可见 changelog → 回滚到 v1.0.0 → 本地 git 出现 rollback commit。
3. **服务端**：Postman 验证递增校验 409、删 latest 后重算、UNIQUE 冲突。

---

## 10. 开放问题

1. **商城 latest 是否允许回指**：本方案不允许（只能下架重算），是否需要管理员"设某版本为 latest"接口？
2. **tag 命名冲突**：用户手动 git 操作（极客场景）可能已存在 `v1.0.0` tag，发布打 tag 时覆盖还是报错？（建议覆盖 + warn 日志）
3. **团队协作**：多人同时维护一个 agent 时本地 git 无 remote，暂不支持 pull/push 同步；如需协作发布，远期考虑商城侧托管 git bare repo。
4. **knowledge 类接入**：复用本设计时需新增 KnowledgeVersionService（追踪整个 vault 目录，性能需评估大仓库场景）。
