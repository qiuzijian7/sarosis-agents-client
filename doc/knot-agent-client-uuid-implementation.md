# Knot Agent Client UUID 实现总结

## 需求背景

用户配置了 Knot 后，需要：
1. Workspace 的路径应该加入到 Knot 工作区路径中
2. 记录该路径对应的 `agent_client_uuid`，使用 `knot-cli client-status` 命令获取 `connection_uuid`
3. 使用 Knot AGUI 发送消息时，在 `chat_extra` 中设置 `agent_client_uuid`

## 实现方案

### 1. 添加 KnotClientStatus 接口

**文件**: `extensions/knot-agui/src/extension.ts`

定义了 `knot-cli client-status` 命令的输出格式接口，包含 `connection_uuid` 字段。

```typescript
/** Knot CLI client-status 命令的输出格式 */
interface KnotClientStatus {
	readonly arch: string;
	readonly branch: string;
	readonly command: string;
	readonly commit: string;
	readonly connection_uuid: string;
	readonly host_user: string;
	readonly host_user_group: string;
	readonly instance_id: string;
	readonly ip: string;
	readonly last_active_time: string;
	readonly last_ask_time: string;
	readonly origin: string;
	readonly os: string;
	readonly path: readonly string[];
	readonly pid: number;
	readonly server_port: number;
	readonly status: string;
	readonly user: string;
	readonly uuid: string;
	readonly version: string;
}
```

### 2. 添加 getKnotClientStatus 函数

**文件**: `extensions/knot-agui/src/extension.ts`

添加了 `getKnotClientStatus` 函数，调用 `knot-cli client-status` 命令并解析 JSON 输出，返回 `KnotClientStatus` 对象。

```typescript
async function getKnotClientStatus(output: vscode.OutputChannel): Promise<KnotClientStatus> {
	const cliStatus = await detectKnotCli(output);
	if (!cliStatus.installed) {
		throw new Error('knot-cli is not installed');
	}
	const executable = cliStatus.path ?? 'knot-cli';
	output.appendLine(`[Knot] getKnotClientStatus: ${executable} client-status`);

	return new Promise<KnotClientStatus>((resolve, reject) => {
		// ... 执行 knot-cli client-status 并解析输出
	});
}
```

### 3. 修改 activate 函数

**文件**: `extensions/knot-agui/src/extension.ts`

在扩展激活时，自动获取 `connection_uuid` 并保存到 `context.globalState`。

```typescript
// Auto-fetch connection_uuid on activation (best-effort, fire-and-forget).
// This saves the connection_uuid to globalState so it can be used in chat_extra.agent_client_uuid.
void getKnotClientStatus(output).then(clientStatus => {
	context.globalState.update('knot.connection_uuid', clientStatus.connection_uuid);
	output.appendLine(`[Knot] auto-fetch connection_uuid on activate -> ${clientStatus.connection_uuid}`);
}).catch(err => {
	output.appendLine(`[Knot] auto-fetch connection_uuid failed: ${err instanceof Error ? err.message : String(err)}`);
});
```

### 4. 修改 knot.workspaceSync 命令

**文件**: `extensions/knot-agui/src/extension.ts`

在成功添加 workspace 后，重新获取 `connection_uuid` 并保存到 `context.globalState`。

```typescript
const result = await runKnotWorkspaceCli(['workspace', '--action', 'add', '--path', wsPath], output);
if (result.ok) {
	// After successfully adding workspace, fetch connection_uuid
	try {
		const clientStatus = await getKnotClientStatus(output);
		context.globalState.update('knot.connection_uuid', clientStatus.connection_uuid);
		output.appendLine(`[Knot] workspaceSync: updated connection_uuid=${clientStatus.connection_uuid}`);
	} catch (err) {
		output.appendLine(`[Knot] workspaceSync: failed to get connection_uuid: ${err instanceof Error ? err.message : String(err)}`);
	}
}
return result;
```

### 5. 修改 KnotChatProvider 类

**文件**: `extensions/knot-agui/src/extension.ts`

在构造函数中添加了 `_globalState` 参数，这样就可以在 `provideLanguageModelChatResponse` 方法中访问 `globalState`。

```typescript
class KnotChatProvider implements vscode.LanguageModelChatProvider {
	constructor(
		private readonly _output: vscode.OutputChannel,
		private readonly _globalState: vscode.GlobalState,
	) { }
}
```

### 6. 修改 activate 函数（创建 KnotChatProvider）

**文件**: `extensions/knot-agui/src/extension.ts`

在创建 `KnotChatProvider` 时传递 `context.globalState`。

```typescript
const provider = new KnotChatProvider(output, context.globalState);
```

### 7. 修改 provideLanguageModelChatResponse 方法

**文件**: `extensions/knot-agui/src/extension.ts`

从 `this._globalState` 获取 `agent_client_uuid`，在 `chat_extra` 中添加 `agent_client_uuid` 字段。

```typescript
// 从 globalState 获取 agent_client_uuid（由 getKnotClientStatus 在激活/workspaceSync 时保存）
const agentClientUuid = this._globalState.get<string>('knot.connection_uuid');
const chatExtra: Record<string, unknown> = {};
if (agentClientUuid) {
	chatExtra.agent_client_uuid = agentClientUuid;
}
const bodyObj: Record<string, unknown> = {
	input: {
		message: userMessage,
		conversation_id: "",
		stream: true,
		enable_web_search: false,
		chat_extra: chatExtra,
	},
};
```

## 测试建议

### 1. 测试 getKnotClientStatus 函数

**步骤**:
1. 确保 `knot-cli` 已安装并配置
2. 在 VS Code 中打开扩展开发宿主窗口
3. 打开 Knot 输出通道（Output: Knot AG-UI）
4. 重新加载窗口（Ctrl+Shift+P -> Developer: Reload Window）
5. 查看输出通道，应该看到 `[Knot] auto-fetch connection_uuid on activate -> <uuid>` 日志

**预期结果**:
- 输出通道显示获取到的 `connection_uuid`
- `context.globalState` 中保存了 `knot.connection_uuid`

### 2. 测试 knot.workspaceSync 命令

**步骤**:
1. 创建一个测试 workspace
2. 查看输出通道，应该看到 `[Knot] workspaceSync -> add path="..."` 和 `[Knot] workspaceSync: updated connection_uuid=...` 日志

**预期结果**:
- Workspace 路径成功添加到 Knot CLI
- `connection_uuid` 成功更新

### 3. 测试 provideLanguageModelChatResponse 方法

**步骤**:
1. 配置 Knot token 和 agent
2. 在聊天框中选择 Knot 模型
3. 发送一条消息
4. 使用网络抓包工具（如 Fiddler）查看请求 body

**预期结果**:
- 请求 body 中的 `chat_extra` 包含 `agent_client_uuid` 字段
- 字段值为之前保存的 `connection_uuid`

## 注意事项

1. **错误处理**: 所有获取 `connection_uuid` 的操作都使用了 `catch` 进行错误处理，避免因获取失败而导致扩展无法激活或命令执行失败。

2. **最佳实践**: `connection_uuid` 保存在 `context.globalState` 中，而不是 `vscode.workspace.getConfiguration` 中，因为：
   - `globalState` 是扩展的私有状态，不会暴露给用户配置
   - `connection_uuid` 是运行时状态，不是用户配置

3. **时机**: `connection_uuid` 在以下时机更新：
   - 扩展激活时（auto-fetch）
   - `knot.workspaceSync` 命令成功执行后

4. **兼容性**: 如果 `connection_uuid` 获取失败，`chat_extra` 中的 `agent_client_uuid` 字段将为 `undefined`，不会影响请求的正常发送。

## 后续优化建议

1. **定时刷新**: 可以添加一个定时器，定期调用 `getKnotClientStatus` 刷新 `connection_uuid`，防止因 CLI 重启等原因导致 `connection_uuid` 变化。

2. **配置变更监听**: 当 `knot.token` 或 `knot.endpoint` 配置变更时，自动重新获取 `connection_uuid`。

3. **错误提示**: 当 `connection_uuid` 获取失败时，可以在 UI 上显示警告提示，引导用户检查 CLI 状态。

4. **单元测试**: 为 `getKnotClientStatus` 函数添加单元测试，模拟各种输出情况（成功、失败、格式错误等）。
