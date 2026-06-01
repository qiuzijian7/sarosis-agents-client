# Anthropic SDK 引入评估报告

## 评估背景

当前 `BuiltInBYOKModelProvider` 使用原生 `fetch` API 调用 Anthropic Messages API，通过 `isAnthropic: true` 配置项启用 Anthropic 兼容模式。Void 项目使用 Anthropic 官方 SDK（`@anthropic-ai/sdk`）。

## 当前实现分析

### 当前方案：原生 fetch + OpenAI 兼容代理

**工作方式**：
1. 在 `builtInBYOKModelProvider.ts` 中通过 `fetch` 调用 Anthropic API
2. 使用 OpenAI 兼容格式发送请求（因为 Anthropic 也提供了 OpenAI 兼容端点）
3. 在最后一个 system message 注入 `cache_control` 字段实现 Prompt Caching

**优点**：
- ✅ 无额外依赖，包体积零增长
- ✅ 与其他 BYOK 提供商共享同一套 `_streamChat` 逻辑
- ✅ 维护成本低（一套代码适配所有提供商）

**缺点**：
- ❌ 无法使用 Anthropic 特有的 API 功能（如原生 `messages.stream()` 事件驱动模式）
- ❌ 无法利用 Anthropic SDK 的自动重试和错误处理
- ❌ 系统消息处理不标准（当前通过 OpenAI 格式的 `role: 'system'` 发送，但 Anthropic 原生格式应使用独立 `system` 参数）
- ❌ 缺少 Anthropic 特有功能的类型安全（如 `thinking` blocks、`redacted_thinking`）

### Void 项目方案：Anthropic 官方 SDK

**工作方式**：
1. 使用 `new Anthropic({ apiKey })` 初始化客户端
2. 调用 `anthropic.messages.stream({ system, messages, model })`
3. 通过事件监听器处理流式响应（`streamEvent`、`finalMessage`、`error`）

**优点**：
- ✅ 类型安全（完整的 TypeScript 类型定义）
- ✅ 自动重试和错误处理
- ✅ 原生支持 `thinking` blocks 和 `redacted_thinking`
- ✅ 系统消息使用独立 `system` 参数（符合 Anthropic API 规范）
- ✅ Prompt Caching 原生支持（`cache_control` 在 content blocks 中）

**缺点**：
- ❌ 增加包体积（`@anthropic-ai/sdk` 约 500KB minified）
- ❌ 需要维护独立的适配器代码
- ❌ 与其他 BYOK 提供商代码路径分叉

## 决策矩阵

| 维度 | 保持 fetch | 引入 Anthropic SDK |
|------|-----------|-------------------|
| **包体积** | 0KB 增长 | +500KB |
| **类型安全** | 低（any 类型） | 高（完整类型定义） |
| **API 功能覆盖** | 部分（OpenAI 兼容子集） | 完整（包括 thinking blocks） |
| **错误处理** | 手动 | 自动重试 |
| **系统消息** | 非标准（role: 'system'） | 标准（独立 system 参数） |
| **维护成本** | 低（共享代码） | 中（独立代码路径） |
| **Prompt Caching** | 部分支持 | 原生支持 |
| **thinking blocks** | 不支持 | 原生支持 |

## 建议：**暂不引入 Anthropic SDK**

### 理由

1. **当前方案已满足基本需求**：Anthropic 的 OpenAI 兼容端点已经支持聊天和工具调用，足以满足基本使用场景。

2. **架构优势**：共享 `_streamChat` 逻辑意味着一处修复所有提供商受益，引入 SDK 会破坏这种统一性。

3. **包体积代价过高**：对于 VSCode 二次开发项目，500KB 的增量不可忽视。

4. **替代方案可行**：
   - 系统消息处理：已通过 `MessageFormatConverter.toAnthropic()` 实现正确的格式转换
   - thinking blocks：已通过 `reasoning_content` / `thinking` 字段解析
   - Prompt Caching：已通过 `cache_control` 注入实现

5. **渐进式策略**：如果未来需要 Anthropic 特有功能（如 extended thinking 的 `budget_tokens`），可以通过以下方式渐进式引入：
   - 先创建独立的 `AnthropicModelProvider` 类（实现 `IModelProvider` 接口）
   - 只在用户选择 Anthropic 提供商时使用 SDK
   - 其他提供商仍使用 `BuiltInBYOKModelProvider`

### 何时引入 SDK

以下情况出现时建议引入：
- Anthropic OpenAI 兼容端点不支持某项关键功能
- 需要使用 Anthropic 特有的 streaming 事件（如 `content_block_start` / `content_block_delta`）
- SDK 的自动重试机制被频繁需要
- Anthropic SDK 包体积通过 tree-shaking 大幅减小

## 行动项

- [x] 评估完成
- [ ] 将 `MessageFormatConverter.toAnthropic()` 集成到 Anthropic BYOK 提供商中（替代 OpenAI 兼容格式）
- [ ] 添加 Anthropic 原生格式的 thinking blocks 解析支持
