# Agent 数据包 HTML 文件存储与数据结构设计方案

## 1. 背景与目标

当前 Agent 数据包（tar.gz）仅包含 `agent.json` 和可选的 `AGENTS.md`，不支持携带 HTML 文件。
需求：让 Agent 数据包**包含 HTML 文件**（ConfigMD 渲染的 HTML 预设、自定义 UI 模板等），并在
**安装**和**升级**时正确处理这些文件。

### 现有流程

```
publish:  agentInstaller.preparePack() → 临时目录(agent.json + AGENTS.md) → tar.gz → 上传
install:  下载 tar.gz → 解压 → agentInstaller.install() → agentStudioService.createAgent()
upgrade:  同 install，覆盖已有记录
```

### 现有数据包结构

```
agent-coder-1.0.0.tar.gz
├── manifest.json          # 包清单
├── agent.json             # AgentExportData（agent 定义 + bootstrap files）
└── AGENTS.md              # 可选，agent 引导文件
```

---

## 2. 新数据包结构

```
agent-coder-1.0.0.tar.gz
├── manifest.json          # 包清单（新增 htmlFiles 字段）
├── agent.json             # AgentExportData（新增 html 字段）
├── AGENTS.md              # 可选，agent 引导文件
└── html/                 # 新增：HTML 资源目录
    ├── index.html         # 主 HTML 文件（ConfigMD 预渲染 HTML）
    ├── styles.css         # 可选，样式表
    ├── script.js          # 可选，交互脚本
    └── assets/            # 可选，图片等静态资源
        ├── logo.png
        └── dashboard.png
```

### manifest.json 变更

```jsonc
{
  "kind": "agent",
  "id": "agent-coder",
  "name": "Coder",
  "version": "1.0.0",
  "description": "...",
  "files": ["manifest.json", "agent.json", "AGENTS.md", "html/index.html"],
  // 新增字段
  "htmlFiles": {
    "entry": "html/index.html",          // HTML 入口文件（相对路径）
    "assets": [                           // 资源文件清单（相对路径）
      "html/styles.css",
      "html/script.js",
      "html/assets/logo.png"
    ]
  },
  "skillRefs": ["skill-code-gen"],
  "mcpRefs": []
}
```

### agent.json (AgentExportData) 变更

```jsonc
{
  "version": 1,
  "exportedAt": "2026-06-30T15:00:00Z",
  "agent": { /* ... Agent 定义 ... */ },
  "agentConfig": {},
  "files": {
    "agentsMd": "...",         // 已有
    "soulMd": "...",            // 已有
    // 新增：HTML 文件内容（内联，用于小文件）
    "html": {
      "entry": "index.html",
      "content": "<!DOCTYPE html>...",      // 入口 HTML 内容
      "inlineAssets": {                      // 小资源内联（< 50KB）
        "styles.css": "body { ... }",
        "script.js": "function init() { ... }"
      }
    }
  }
}
```

> **设计决策**：HTML 文件同时支持「目录文件」和「内联」两种方式。
> - tar.gz 包内使用 `html/` 目录（支持大文件、二进制资源）
> - agent.json 内的 `files.html` 用于 AgentExportData 导入导出（小文件内联，便于跨工作区传输）
> - 安装时优先读取 `html/` 目录，回退到 `files.html` 内联内容

---

## 3. 本地存储方案

### 安装目录结构

```
~/.saros/agents/custom/
├── agent-coder/              # 已有：agent 定义目录
│   ├── agent.json            # 已有
│   └── AGENTS.md             # 已有
└── html/                     # 新增：HTML 资源根目录
    └── agent-coder/          # 按 storeId 分目录
        ├── index.html        # HTML 入口
        ├── styles.css        # 样式
        ├── script.js         # 脚本
        └── assets/           # 静态资源
            └── logo.png
```

### Agent 定义中的 configMd 关联

安装后，Agent 定义中的 `configMd` 字段会被设置为指向本地 HTML 文件：

```jsonc
// ~/.saros/custom-agents.json 中的 agent 记录
{
  "id": "coder",
  "name": "Coder",
  "version": "1.0.0",
  "storeId": "agent-coder",
  "configMd": {
    "mdPath": "config.md",          // 原有 MD 源文件（若存在）
    "htmlPath": "index.html",       // 新增：HTML 入口文件（相对 htmlInstallDir）
    "htmlInstallDir": "~/.saros/agents/html/agent-coder",  // 新增：HTML 安装根目录
    "autoShow": true
  }
}
```

---

## 4. 类型定义变更

### 4.1 `PackageManifest` 扩展（packageInstaller.ts）

```typescript
export interface PackageManifest {
  // ... 已有字段 ...

  /** HTML 文件清单（仅 kind=agent 时有效，可选） */
  readonly htmlFiles?: {
    /** HTML 入口文件（相对包根路径，如 "html/index.html"） */
    readonly entry: string;
    /** 资源文件列表（相对包根路径） */
    readonly assets?: readonly string[];
  };
}
```

### 4.2 `AgentExportData.files` 扩展（agentStudioTypes.ts）

```typescript
export interface AgentExportData {
  // ... 已有字段 ...

  readonly files: {
    readonly agentsMd?: string;
    readonly soulMd?: string;
    readonly identityMd?: string;
    readonly toolsMd?: string;
    readonly memoryMd?: string;
    readonly skillDirectives?: Record<string, string>;

    /** 新增：HTML 文件内容（内联方式，用于跨工作区导入导出） */
    readonly html?: {
      readonly entry: string;
      readonly content: string;
      readonly inlineAssets?: Record<string, string>;
    };
  };
}
```

### 4.3 `AgentConfigMd` 扩展（agentStudioTypes.ts）

```typescript
export interface AgentConfigMd {
  // ... 已有字段 ...

  /** 新增：HTML 入口文件名（相对 htmlInstallDir） */
  htmlPath?: string;

  /** 新增：HTML 资源安装目录（绝对路径） */
  htmlInstallDir?: string;
}
```

### 4.4 `Agent` 接口无需变更

`Agent.configMd?: AgentConfigMd` 已存在，通过扩展 `AgentConfigMd` 即可。

---

## 5. 安装流程变更（AgentInstaller.install）

```typescript
async install(manifest: PackageManifest, extractedDir: URI): Promise<IInstallResult> {
  // 1. 读取 agent.json（已有逻辑）
  const exportData = JSON.parse(raw);

  // 2. 安装 HTML 文件（新增）
  let htmlInstallDir: string | undefined;
  if (manifest.htmlFiles) {
    htmlInstallDir = await this._installHtmlFiles(manifest, extractedDir, manifest.id);
  } else if (exportData.files?.html) {
    // 回退：从 agent.json 内联内容恢复 HTML 文件
    htmlInstallDir = await this._installHtmlFromInline(exportData.files.html, manifest.id);
  }

  // 3. 构建 createData（已有逻辑 + HTML 路径）
  const createData: Partial<Agent> = {
    ...exportData.agent,
    version: manifest.version,
    storeId: manifest.id,
    source: 'custom',
    configMd: {
      ...(exportData.agent.configMd || {}),
      htmlPath: manifest.htmlFiles?.entry ?? exportData.files?.html?.entry,
      htmlInstallDir,
    },
  };

  await this.agentStudioService.createAgent(createData);
}
```

### HTML 文件安装子方法

```typescript
private async _installHtmlFiles(
  manifest: PackageManifest,
  extractedDir: URI,
  storeId: string,
): Promise<string> {
  const userHome = await this.pathService.userHome();
  const htmlRoot = path.join(userHome.fsPath, '.saros', 'agents', 'html', storeId);

  // 清理旧文件（升级时覆盖）
  if (await this.fileService.exists(URI.file(htmlRoot))) {
    await this.fileService.del(URI.file(htmlRoot), { recursive: true });
  }
  await this.fileService.createFolder(URI.file(htmlRoot));

  // 复制 html/ 目录下的所有文件
  const htmlSourceDir = URI.joinPath(extractedDir, 'html');
  if (await this.fileService.exists(htmlSourceDir)) {
    await this._copyDirectory(htmlSourceDir, URI.file(htmlRoot));
  }

  return htmlRoot;
}
```

---

## 6. 打包流程变更（AgentInstaller.preparePack）

```typescript
async preparePack(localId: string): Promise<IPreparePackResult> {
  const agent = await this.agentStudioService.getAgent(localId);

  // 1. 写 agent.json（已有逻辑）
  // 2. 写 AGENTS.md（已有逻辑）

  // 3. 收集 HTML 文件（新增）
  const htmlFiles: string[] = [];
  let htmlFilesManifest: PackageManifest['htmlFiles'] | undefined;

  if (agent.configMd?.htmlInstallDir && agent.configMd?.htmlPath) {
    const htmlDir = agent.configMd.htmlInstallDir;
    const entryFile = agent.configMd.htmlPath;

    // 复制整个 html/ 目录到临时打包目录
    const tmpHtmlDir = path.join(tmpDir, 'html');
    await this._copyDirectory(URI.file(htmlDir), URI.file(tmpHtmlDir));

    // 收集文件清单
    const allFiles = await this._listFilesRecursive(tmpHtmlDir);
    htmlFiles.push(...allFiles.map(f => `html/${f}`));

    htmlFilesManifest = {
      entry: `html/${entryFile}`,
      assets: allFiles.filter(f => f !== entryFile).map(f => `html/${f}`),
    };
  }

  const manifest: PackageManifest = {
    kind: 'agent',
    id: localId,
    name: agent.name,
    version: agent.version || '1.0.0',
    files: ['agent.json', ...htmlFiles],
    htmlFiles: htmlFilesManifest,
  };

  return { localDir: URI.file(tmpDir), manifest };
}
```

---

## 7. 升级流程

升级（download + install 覆盖）复用安装流程，关键点：

1. **安装前清理旧 HTML**：`_installHtmlFiles` 中先 `del(htmlRoot, { recursive: true })`
2. **保留用户自定义 MD**：`configMd.mdPath` 指向的 `config.md` 不被覆盖（由 `createAgent` 的 override 逻辑保证）
3. **HTML 资源原子替换**：先写到临时目录，成功后 rename 覆盖（避免升级中断导致文件损坏）

```typescript
// 原子替换升级
private async _atomicReplaceHtml(srcDir: URI, targetDir: URI): Promise<void> {
  const tmpBackup = `${targetDir.fsPath}.bak-${Date.now()}`;
  // 1. 备份旧目录
  if (await this.fileService.exists(targetDir)) {
    await this.fileService.rename(targetDir, URI.file(tmpBackup));
  }
  try {
    // 2. 复制新文件
    await this._copyDirectory(srcDir, targetDir);
    // 3. 删除备份
    if (await this.fileService.exists(URI.file(tmpBackup))) {
      await this.fileService.del(URI.file(tmpBackup), { recursive: true });
    }
  } catch (err) {
    // 回滚：恢复备份
    if (await this.fileService.exists(URI.file(tmpBackup))) {
      await this.fileService.rename(URI.file(tmpBackup), targetDir);
    }
    throw err;
  }
}
```

---

## 8. 卸载流程变更

`MarketplaceService.uninstall()` 已有清理逻辑，新增 HTML 目录清理：

```typescript
async uninstall(storeId: string, kind: PackageKind): Promise<void> {
  // 已有：删除 ~/.saros/agents/custom/{storeId}
  // 已有：删除 installed-packages.json 记录

  // 新增：删除 HTML 资源目录
  if (kind === 'agent') {
    const htmlDir = URI.joinPath(userHome, '.saros', 'agents', 'html', storeId);
    if (await this.fileService.exists(htmlDir)) {
      await this.fileService.del(htmlDir, { recursive: true });
    }
  }
}
```

---

## 9. ConfigMD 渲染集成

`ConfigHtmlService` 渲染 HTML 时，优先级：

1. **本地 HTML 文件**（`htmlInstallDir + htmlPath`）→ 直接读取返回
2. **MD 渲染**（`mdPath`）→ 调用 MD→HTML parser
3. **内置默认**（空 HTML 或占位）

```typescript
// configHtmlService.ts
async getHtml(agentId: string): Promise<string> {
  const agent = await this.agentStudioService.getAgent(agentId);
  const configMd = agent?.configMd;

  // 优先：本地 HTML 文件
  if (configMd?.htmlInstallDir && configMd?.htmlPath) {
    const htmlUri = URI.joinPath(URI.file(configMd.htmlInstallDir), configMd.htmlPath);
    if (await this.fileService.exists(htmlUri)) {
      return (await this.fileService.readFile(htmlUri)).value.toString();
    }
  }

  // 回退：MD 渲染
  if (configMd?.mdPath) {
    return this._renderMdToHtml(agentId);
  }

  return '<div>ConfigHTML not configured</div>';
}
```

---

## 10. 文件清单总结

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `common/packageInstaller.ts` | 扩展接口 | `PackageManifest` 新增 `htmlFiles` 字段 |
| `common/agentStudioTypes.ts` | 扩展接口 | `AgentExportData.files` 新增 `html`；`AgentConfigMd` 新增 `htmlPath`/`htmlInstallDir` |
| `browser/installers/agentInstaller.ts` | 核心变更 | install/preparePack 增加 HTML 文件处理 |
| `browser/marketplaceService.ts` | 小改 | uninstall 增加 HTML 目录清理 |
| `browser/configHtmlService.ts` | 小改 | getHtml 优先读取本地 HTML 文件 |
| `browser/views/presetAgentView.ts` | 无需改 | 升级/删除按钮已支持，数据流自动更新 |

---

## 11. 兼容性策略

1. **旧包兼容**：`htmlFiles` 为可选字段，缺失时走原有 MD 渲染逻辑
2. **版本迁移**：已安装的旧 agent 升级时，`configMd.htmlInstallDir` 自动补充
3. **回退机制**：HTML 文件损坏时自动回退到 MD 渲染
4. **大小限制**：内联 HTML（agent.json 中的 `files.html`）建议 < 50KB，更大文件走 `html/` 目录
