# CodeBuddy Provider 实现方案

## 概述

本文档描述了如何在 `sarosis-agents-client` 项目中实现 CodeBuddy provider，使其可以作为内置插件使用 `https://copilot.tencent.com/v2` 作为 AI provider。

## 背景

HoudniAgent 项目已经成功集成了 CodeBuddy 作为 AI provider。通过分析其实现，我们可以借鉴其功能，在 `sarosis-agents-client` 项目中实现类似的 provider。

### CodeBuddy API 关键信息

1. **API Endpoint**: `https://copilot.tencent.com/v2/chat/completions`
2. **认证方式**: Bearer Token (JWT)
3. **认证文件**: `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\Tencent-Cloud.coding-copilot.info`
4. **请求头**:
   - `Authorization: Bearer <JWT token>`
   - `X-User-Id: <account.uid>`
   - `X-Enterprise-Id: <account.enterpriseId>`
   - `X-Tenant-Id: <account.enterpriseId>`
   - `X-Domain: tencent.sso.copilot.tencent.com`
   - `X-Department-Info: <base64 encoded department path>`
   - `X-Product: SaaS`
   - `X-Requested-With: XMLHttpRequest`
   - `X-Agent-Intent: craft`
   - `X-IDE-Type: VS Code` (自定义)
   - `X-IDE-Name: CodeBuddy` (自定义)
   - `X-Conversation-ID: <uuid>`
   - `X-Request-ID: <hex uuid>`
5. **请求体**: 标准 OpenAI Chat Completions 格式，必须 `stream: true`
6. **响应格式**: 标准 OpenAI SSE 格式

## 实现方案

### 1. 创建 CodeBuddyAgent 类

创建新文件 `src/vs/platform/agentHost/node/codebuddy/codebuddyAgent.ts`，实现 `IAgent` 接口。

```typescript
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../log/common/log.js';
import { IInstantiationService } from '../../../instantiation/common/instantiation.js';
import { AgentSession, IAgent, IAgentAttachment, IAgentCreateSessionConfig, IAgentCreateSessionResult, IAgentDescriptor, IAgentModelInfo, IAgentSessionMetadata } from '../common/agentService.js';

export class CodeBuddyAgent extends Disposable implements IAgent {
    readonly id = 'codebuddy' as const;
    
    private readonly _onDidSessionProgress = this._register(new Emitter<AgentSignal>());
    readonly onDidSessionProgress = this._onDidSessionProgress.event;
    
    private readonly _models = observableValue<readonly IAgentModelInfo[]>(this, []);
    readonly models = this._models;
    
    private _authData: CodeBuddyAuthData | undefined;
    
    constructor(
        @ILogService private readonly _logService: ILogService,
        @IInstantiationService private readonly _instantiationService: IInstantiationService,
    ) {
        super();
        this._loadAuthData();
    }
    
    // ... 实现 IAgent 接口的方法
}
```

### 2. 实现认证逻辑

从本地 CodeBuddy 认证文件读取 JWT token 和用户元数据。

```typescript
interface CodeBuddyAuthData {
    token: string;
    userId: string;
    enterpriseId: string;
    departmentInfo: string;
}

private _loadAuthData(): void {
    const authPath = this._getAuthFilePath();
    if (!existsSync(authPath)) {
        this._logService.error('[CodeBuddy] Auth file not found:', authPath);
        return;
    }
    
    try {
        const content = readFileSync(authPath, 'utf-8');
        const data = JSON.parse(content);
        this._authData = {
            token: data.auth.accessToken,
            userId: data.account.uid,
            enterpriseId: data.account.enterpriseId,
            departmentInfo: data.account.departmentFullName,
        };
    } catch (err) {
        this._logService.error('[CodeBuddy] Failed to load auth data:', err);
    }
}

private _getAuthFilePath(): string {
    const localAppData = process.env.LOCALAPPDATA || '';
    return join(localAppData, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'Tencent-Cloud.coding-copilot.info');
}
```

### 3. 实现 API 调用逻辑

直接调用 CodeBuddy API，处理流式响应。

```typescript
private async _callAPI(messages: any[], model: string, sessionId: string): Promise<void> {
    if (!this._authData) {
        throw new Error('Not authenticated');
    }
    
    const url = 'https://copilot.tencent.com/v2/chat/completions';
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this._authData.token}`,
        'X-User-Id': this._authData.userId,
        'X-Enterprise-Id': this._authData.enterpriseId,
        'X-Tenant-Id': this._authData.enterpriseId,
        'X-Domain': 'tencent.sso.copilot.tencent.com',
        'X-Department-Info': this._authData.departmentInfo,
        'X-Product': 'SaaS',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Agent-Intent': 'craft',
        'X-IDE-Type': 'VS Code',
        'X-IDE-Name': 'CodeBuddy',
        'X-Conversation-ID': sessionId,
        'X-Request-ID': generateUuid().replace(/-/g, ''),
    };
    
    const payload = {
        model,
        messages,
        stream: true,
    };
    
    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
    });
    
    if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`);
    }
    
    // 处理 SSE 流
    const reader = response.body?.getReader();
    if (!reader) {
        throw new Error('No response body');
    }
    
    const decoder = new TextDecoder();
    let buffer = '';
    
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const data = line.slice(6);
                if (data === '[DONE]') {
                    break;
                }
                
                try {
                    const chunk = JSON.parse(data);
                    this._handleChunk(chunk);
                } catch (err) {
                    this._logService.warn('[CodeBuddy] Failed to parse chunk:', err);
                }
            }
        }
    }
}

private _handleChunk(chunk: any): void {
    // 处理 SSE chunk，转换为 AgentSignal
    const choices = chunk.choices || [];
    for (const choice of choices) {
        const delta = choice.delta || {};
        if (delta.content) {
            // 发送内容信号
            this._onDidSessionProgress.fire({
                kind: 'action',
                session: this._currentSession!,
                action: {
                    type: 'response',
                    content: delta.content,
                },
            });
        }
    }
}
```

### 4. 实现 IAgent 接口的关键方法

#### createSession

```typescript
async createSession(config?: IAgentCreateSessionConfig): Promise<IAgentCreateSessionResult> {
    const sessionId = config?.session ? AgentSession.id(config.session) : generateUuid();
    const sessionUri = AgentSession.uri(this.id, sessionId);
    
    // 创建会话元数据
    const metadata: IAgentSessionMetadata = {
        session: sessionUri,
        startTime: Date.now(),
        modifiedTime: Date.now(),
        workingDirectory: config?.workingDirectory,
    };
    
    // 保存会话元数据
    await this._saveSessionMetadata(sessionUri, metadata);
    
    return {
        session: sessionUri,
        workingDirectory: config?.workingDirectory,
    };
}
```

#### sendMessage

```typescript
async sendMessage(session: URI, prompt: string, attachments?: IAgentAttachment[], turnId?: string): Promise<void> {
    const sessionId = AgentSession.id(session);
    this._currentSession = session;
    
    // 获取会话历史
    const messages = await this._getSessionMessages(sessionId);
    
    // 添加用户消息
    messages.push({
        role: 'user',
        content: prompt,
    });
    
    // 调用 API
    await this._callAPI(messages, 'claude-sonnet-4.6', sessionId);
}
```

#### disposeSession

```typescript
async disposeSession(session: URI): Promise<void> {
    const sessionId = AgentSession.id(session);
    
    // 清理会话资源
    this._sessions.delete(sessionId);
    
    // 删除会话元数据
    await this._deleteSessionMetadata(session);
}
```

### 5. 注册 CodeBuddyAgent

在 `src/vs/platform/agentHost/node/agentHostServerMain.ts` 或 `agentHostMain.ts` 中注册 `CodeBuddyAgent`。

```typescript
// 在 agentHostServerMain.ts 中
const codebuddyAgent = disposables.add(instantiationService.createInstance(CodeBuddyAgent));
agentService.registerProvider(codebuddyAgent);
log('CodeBuddyAgent registered');
```

## 文件结构

```
src/vs/platform/agentHost/node/codebuddy/
  - codebuddyAgent.ts          # 主 Agent 类
  - codebuddyAgentSession.ts   # 会话管理
  - codebuddyApiClient.ts      # API 客户端
  - codebuddyModels.ts         # 模型列表
```

## 测试计划

1. **单元测试**: 测试认证逻辑、API 调用、SSE 解析
2. **集成测试**: 测试与 CodeBuddy API 的集成
3. **端到端测试**: 测试完整的会话流程

## 已知限制

1. **仅支持流式响应**: CodeBuddy API 只支持 `stream: true`
2. **依赖 CodeBuddy 登录**: 需要先通过 CodeBuddy 完成 iOA SSO 登录
3. **内网限制**: API endpoint 可能仅在公司内网/VPN 环境下可访问
4. **iOA 网络拦截**: iOA 安全客户端可能拦截进程的 HTTPS 流量

## 参考资料

1. HoudniAgent 项目: `G:\CustomWorkspaces\AIProjects\HoudniAgent\houdini_agent\utils\ai_client.py`
2. CodeBuddy 集成文档: `G:\CustomWorkspaces\AIProjects\HoudniAgent\docs\codebuddy-integration.md`
3. VS Code Agent Host 架构: `src/vs/platform/agentHost/README.md`
