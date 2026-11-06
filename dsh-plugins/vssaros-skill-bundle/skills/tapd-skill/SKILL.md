---
name: tapd-skill
description: "当提及 TAPD 需求/缺陷/任务/迭代/等内容或包含 tapd.woa.com 链接时使用。不适用于：TAPD 管理后台配置、权限管理、项目创建与管理、流水线与持续集成等场景。"
homepage: http://mcp-idc.tapd.woa.com/mcp/
metadata:
  version: "0.2.0"
---

## ⚠️ 重要提醒：必须通过 mcporter-internal 调用

```
✅ 正确方式：mcporter-internal call tapd.<工具名>
❌ 错误方式：直接调用 tapd 工具（会失败）
```

> 不熟悉 mcporter-internal 用法？请参考 `mcporter-internal` skill 文档，或查阅本目录下 `DEPENDENCIES.md`。

## 🔧 调用流程（严格遵循）

### 第一步：检查服务状态

```bash
mcporter-internal list
# 确认 tapd 服务状态为 healthy
```

### 第二步：语义搜索工具

```bash
mcporter-internal call tapd.lookup_tapd_tool task_description="提炼后的任务描述"
```

### 第三步：执行目标工具

```bash
mcporter-internal call tapd.proxy_execute_tool tool_name="找到的工具名" tool_args='{}'
```

> ⚠️ **高危操作确认**：以下操作需先向用户展示操作摘要并确认后再执行，其余操作可直接执行：
> - **删除操作**（如删除需求/缺陷/任务/Wiki）
> - **批量操作**（一次影响多条记录，如批量修改状态、批量删除）
> - 普通创建/更新操作无需确认，直接执行。

## 📋 调用示例

**场景1**: 用户说"帮我查一下项目 12345 的 bug 列表"（只读操作）

```bash
# 搜索工具
mcporter-internal call tapd.lookup_tapd_tool task_description="查询缺陷列表"
# → 返回: bugs_get 及其 input_schema

# 直接执行（只读，无需确认）
mcporter-internal call tapd.proxy_execute_tool tool_name="bugs_get" tool_args='{"workspace_id": "12345"}'
```

**场景2**: 用户说"帮我提一个新需求"（普通创建，直接执行）

```bash
# 搜索工具
mcporter-internal call tapd.lookup_tapd_tool task_description="创建需求"
# → 返回: stories_create 及其 input_schema

# 直接执行（普通创建，无需确认）
mcporter-internal call tapd.proxy_execute_tool tool_name="stories_create" tool_args='{"workspace_id": "12345", "name": "XXX"}'
```

**场景3**: 用户说"把这些过期的 bug 都删掉"（删除操作，需确认）

```bash
# 搜索工具
mcporter-internal call tapd.lookup_tapd_tool task_description="删除缺陷"

# ⚠️ 高危操作，先确认
# AI: "即将删除项目 12345 中的 12 条缺陷记录，确认执行？"
# 用户: "确认"
mcporter-internal call tapd.proxy_execute_tool tool_name="bugs_delete" tool_args='{"workspace_id": "12345", "id": "xxx"}'
```

**场景4**: 多步骤串联 — 查询迭代 → 获取任务 → 更新状态

```bash
# 1. 查询当前迭代
mcporter-internal call tapd.lookup_tapd_tool task_description="查询迭代"
mcporter-internal call tapd.proxy_execute_tool tool_name="iterations_get" tool_args='{"workspace_id": "12345", "status": "open"}'
# → 得到 iteration_id

# 2. 获取该迭代的任务
mcporter-internal call tapd.proxy_execute_tool tool_name="tasks_get" tool_args='{"workspace_id": "12345", "iteration_id": "xxx"}'

# 3. 更新任务状态（普通更新，直接执行）
mcporter-internal call tapd.proxy_execute_tool tool_name="tasks_update" tool_args='{"workspace_id": "12345", "id": "T-001", "status": "completed"}'
```

## 🛠️ 工具说明

| 工具 | 功能 | 何时使用 |
|------|------|----------|
| `lookup_tapd_tool` | 语义搜索匹配 TAPD 工具 | 不确定用哪个工具时 |
| `lookup_tool_param_schema` | 查询工具参数 schema | 已知工具名，需获取参数定义时 |
| `proxy_execute_tool` | 代理执行任意 TAPD 工具 | 执行具体操作（删除/批量操作需确认） |
| `tql_syntax_reference` | TAPD 查询语法参考（TQL） | 需要高级查询语法（模糊/排除/多值/集合等）时参考，无需调用 |

## 📝 task_description 提炼规范

调用 `lookup_tapd_tool` 前，将用户原话提炼为「动作+对象」格式：

| 用户原话 | 提炼后 |
|----------|--------|
| "帮我看看项目里有哪些 bug" | "查询缺陷列表" |
| "我想提一个新需求" | "创建需求" |
| "把任务状态改成已完成" | "更新任务状态" |
| "获取当前迭代的所有任务" | "查询迭代任务" |

**标准动作词**: 查询/获取/创建/新建/更新/修改/删除/统计
**标准对象词**: 需求/story/缺陷/bug/任务/task/迭代/iteration/Wiki/测试用例

## 🚨 常见错误及解决方案

| 错误信息 | 原因 | 解决 |
|----------|------|------|
| "Not Acceptable: Client must accept application/json" | 直接调用了 TAPD 工具 | 使用 `mcporter-internal call tapd.xxx` 格式 |
| "Invalid request parameters" | 参数格式不正确 | 先 `mcporter-internal list` 确认服务状态 |
| 工具调用失败 | 调用方式或参数有误 | 检查前缀、JSON 格式、重新搜索工具 |

> 跨平台 JSON 参数写法差异详见 [references/json-args-guide.md](references/json-args-guide.md)
