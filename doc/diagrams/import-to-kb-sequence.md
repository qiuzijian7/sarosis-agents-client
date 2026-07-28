# 「导入知识库」时序图

```mermaid
sequenceDiagram
    actor User as 👤 用户
    participant ChatUI as ChatPanel<br/>(agentChatPanel.*.ts)
    participant Pane as NativeChatEditorPane
    participant Svc as AgentStudioService
    participant KBTS as knowledgeTools.ts
    participant Storage as IStorageService
    participant FS as IFileService<br/>(磁盘 IO)
    participant LLM as LLM Provider<br/>(Chat API)
    participant Notify as NotificationService
    participant KBView as KnowledgeBaseView<br/>(侧边栏视图)

    %% ── 1. 用户点击按钮 ──
    User->>ChatUI: 点击「导入知识库」按钮
    ChatUI->>Pane: onImportToKnowledgeBase(messageContent)

    %% ── 2. Pane 层处理 ──
    Pane->>Pane: _handleFavoriteMessage(content)
    Note over Pane: 传入 agentId + source

    Pane->>Svc: importMessageRawToKnowledgeBase(content, {agentId, source})
    Svc->>Svc: _buildKbToolDeps()
    Note over Svc: 组装 KnowledgeToolDeps<br/>（包含 resolveNotesDir）
    Svc->>KBTS: importMessageRawToKnowledgeBase(deps, content, opts)

    %% ── 3. 核心导入逻辑 ──
    KBTS->>KBTS: 检查 content 非空

    %% ── 3a. 解析写入目录 ──
    KBTS->>Svc: deps.resolveNotesDir()
    Svc->>Storage: storageService.get('agentStudio.kb.vaults')
    Storage-->>Svc: IKbVault[] (JSON)
    Svc->>Storage: storageService.get('agentStudio.kb.active')
    Storage-->>Svc: activeVaultId (string)
    Svc->>Svc: _resolveNotesDir()
    Note over Svc: 构造路径:<br/>&lt;root&gt;/&lt;vaultId&gt;/笔记/
    Svc-->>KBTS: notesDir (fsPath)

    %% ── 3b. 创建目录 ──
    KBTS->>FS: fileService.createFolder(notesDir)
    FS-->>KBTS: OK

    %% ── 3c. LLM 标题生成 ──
    KBTS->>KBTS: deriveTitleFromLLM(deps, content)
    KBTS->>Svc: deps.resolveKbModel()
    Svc->>Svc: _resolveKbChatModel()
    Note over Svc: 按优先级解析:<br/>1. Curator 配置<br/>2. 默认 Provider<br/>3. 首个可用 Provider
    Svc-->>KBTS: {providerId, modelId}

    KBTS->>KBTS: isChatProviderConfigured(...)
    alt LLM 可用
        KBTS->>KBTS: resolveChatModel(configSvc, {providerId, modelId})
        KBTS->>LLM: chatModel.extract({prompt, schema})
        Note over LLM: Prompt: "你是标题提取助手..."<br/>Schema: {title: string}
        LLM-->>KBTS: {title: "Python 协程与多线程的区别"}
    else LLM 不可用 / 调用失败
        KBTS->>KBTS: deriveTitle(content)
        Note over KBTS: Fallback: 取第一非空行
    end

    %% ── 3d. 组装 Markdown ──
    KBTS->>KBTS: renderRawNote(content, meta)
    Note over KBTS: 生成 YAML frontmatter + 正文<br/>---<br/>title: "..."<br/>date: 2026-07-21T...<br/>source: agent-chat-import<br/>agentid: xxx<br/>---<br/>&lt;原文&gt;

    %% ── 3e. 写盘 ──
    KBTS->>FS: fileService.writeFile(noteUri, buffer)
    Note over FS: 写入到 &lt;vaultId&gt;/笔记/YYYY-MM-DD_hash.md
    FS-->>KBTS: OK

    %% ── 4. 返回结果 ──
    KBTS-->>Svc: ImportToKbResult {success, action:"build", id, notePath, title}
    Svc-->>Pane: ImportToKbResult

    %% ── 5. 用户通知 ──
    alt 导入成功
        Pane->>Notify: notificationService.notify({message, severity:Info})
        Pane->>Pane: logService.info("[NativeChatEditorPane] 已导入知识库...")
        Notify-->>User: 🔔 "已导入知识库（原样存档）：Python 协程与多线程的区别"
    else 导入失败
        Pane->>Pane: _writeLegacyFavorite(content)
        Note over Pane: 降级到本地收藏夹
        Pane->>Notify: notificationService.notify({message: "已存入本地收藏夹"})
    end

    %% ── 6. 视图刷新（独立触发） ──
    Note over KBView: 用户切换到知识库视图 / 手动刷新
    KBView->>KBView: renderAll()
    KBView->>KBView: renderSection('notes')
    KBView->>KBView: loadSectionTree('notes')
    KBView->>KBView: sectionUri(vault, 'notes')
    Note over KBView: 路径: &lt;root&gt;/&lt;vaultId&gt;/笔记/
    KBView->>FS: fileService.resolve(sectionUri)
    FS-->>KBView: 目录下所有 .md 文件列表
    KBView->>KBView: listChildren() → IKbNode[]
    KBView->>KBView: renderNode() 逐个渲染到 DOM
    Note over KBView,User: ✅ 文档出现在知识库视图中
```

## 关键路径说明

| 步骤 | 文件 | 方法 | 说明 |
|------|------|------|------|
| 按钮点击 | `agentChatPanel.*.ts` | `onImportToKnowledgeBase` | UI 层触发 |
| 入口分发 | `nativeChatEditorPane.ts:1005` | `_handleFavoriteMessage` | 传入 agentId + source |
| 服务委托 | `agentStudioService.ts:838` | `importMessageRawToKnowledgeBase` | 组装 deps → 委托到 knowledgeTools |
| 目录解析 | `agentStudioService.ts:814` | `_resolveNotesDir` | 从 Storage 读活动 vault，构造 `vaultId/笔记/` |
| LLM 标题 | `knowledgeTools.ts:445` | `deriveTitleFromLLM` | chatModel.extract()，失败 fallback 到 deriveTitle |
| Markdown 组装 | `knowledgeTools.ts:492` | `renderRawNote` | YAML frontmatter + 原文 |
| 写盘 | `knowledgeTools.ts:412` | `fileService.writeFile` | 存入 `YYYY-MM-DD_hash.md` |
| 通知 | `nativeChatEditorPane.ts:3375` | `notificationService.notify` | 用户可见提示 |
| 视图渲染 | `knowledgeBaseView.ts:514` | `renderAll → loadSectionTree` | fileService.resolve 扫描目录 |

## 降级路径

```
LLM 不可用 → deriveTitle (第一非空行)
resolveNotesDir 失败 → fallback 到 <root>/notes/
写入失败 / 整个流程失败 → _writeLegacyFavorite (本地收藏夹)
```
