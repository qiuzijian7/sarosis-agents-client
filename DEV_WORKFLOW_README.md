# 完整开发流程工具

## 📋 概述

这是一个自动化的开发流程工具，实现了从需求输入到代码提交的完整工作流：

```
需求输入 → 开发 → 错误检查 → 测试 → 确认提交
```

## ✨ 主要特性

- ✅ **需求管理**：支持模板、多行输入、AI 辅助分析
- ✅ **智能开发**：AI 辅助代码生成、自动编译检查
- ✅ **错误检查**：TypeScript 检查、ESLint、代码格式检查、循环依赖检查
- ✅ **测试验证**：单元测试、集成测试、E2E 测试、覆盖率检查
- ✅ **提交管理**：Conventional Commits、自动生成提交信息、推送管理
- ✅ **AI 集成**：需求分析、代码生成、错误修复、测试生成、提交信息生成

## 🚀 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置工具

编辑 `dev-workflow.config.js` 文件，根据你的项目需求进行配置。

主要配置项：
- `project` - 项目信息
- `stages` - 各阶段配置
- `ai` - AI 辅助配置
- `integrations` - 第三方集成（Jira、TAPD、工蜂等）

### 3. 运行工具

#### 基础用法

```bash
# 运行完整流程（带 AI 辅助）
node ai-dev-workflow.js

# 运行完整流程（不使用 AI）
node ai-dev-workflow.js --no-ai

# 运行基础流程（无 AI）
node dev-workflow.js
```

#### 高级用法

```bash
# 跳过测试阶段
node ai-dev-workflow.js --skip-tests

# 跳过错误检查阶段
node ai-dev-workflow.js --skip-checks

# 自动提交（使用 AI 生成的提交信息）
node ai-dev-workflow.js --auto-commit

# 使用自定义配置文件
node ai-dev-workflow.js --config ./my-config.js

# 查看帮助
node ai-dev-workflow.js --help
```

## 📋 工作流程详解

### 阶段 1: 需求输入

**功能：**
- 提供需求模板（新功能、Bug 修复、性能优化）
- 支持多行输入
- AI 分析需求类型、实现方式、影响文件、测试策略

**示例：**
```
请选择模板 (输入编号, 回车跳过): 1
请输入您的需求 (输入空行结束):
功能描述: 实现用户登录功能
输入: 用户名、密码
输出: 登录成功/失败
影响范围: 前端登录页面、后端认证 API
```

### 阶段 2: 开发实现

**功能：**
- AI 生成代码（组件、服务、测试）
- 自动创建文件目录
- 实时编译检查
- AI 辅助修复编译错误

**生成的文件示例：**
```
src/
  components/
    LoginForm.tsx         # 登录表单组件
    LoginForm.test.tsx   # 组件测试
  services/
    authService.ts        # 认证服务
    authService.test.ts   # 服务测试
```

### 阶段 3: 错误检查

**检查项：**
1. **TypeScript 类型检查**
   ```bash
   npm run compile-check-ts-native
   ```

2. **ESLint 代码规范检查**
   ```bash
   npm run eslint
   ```

3. **代码格式检查**
   ```bash
   npm run hygiene
   ```

4. **循环依赖检查**
   ```bash
   npm run check-cyclic-dependencies
   ```

**AI 辅助修复：**
- 分析错误信息
- 提供修复建议
- 自动应用修复

### 阶段 4: 测试验证

**测试类型：**
1. **单元测试**
   ```bash
   npm test -- --watchAll=false --coverage
   ```

2. **浏览器测试**（可选）
   ```bash
   npm run test-browser-no-install
   ```

3. **E2E 测试**（可选）
   ```bash
   npm run test-extension
   ```

**覆盖率要求：**
- 语句覆盖率: 80%
- 分支覆盖率: 70%
- 函数覆盖率: 80%
- 行覆盖率: 80%

**AI 生成测试：**
- 根据代码自动生成测试用例
- 生成测试文件和 Mock 数据

### 阶段 5: 确认提交

**功能：**
- 显示 Git 状态
- AI 生成符合 Conventional Commits 的提交信息
- 支持编辑提交信息
- 可选推送到远程仓库
- 可选创建 Pull Request

**提交信息格式：**
```
feat: 实现用户登录功能

需求描述:
功能描述: 实现用户登录功能
输入: 用户名、密码
输出: 登录成功/失败
影响范围: 前端登录页面、后端认证 API

AI 分析:
{
  "type": "新功能开发",
  "implementation": "建议创建登录组件和认证服务",
  "affectedFiles": [...],
  "testStrategy": "单元测试 + 集成测试 + E2E 测试"
}

变更文件:
src/components/LoginForm.tsx
src/services/authService.ts
src/App.tsx

流程: Prompt输入需求 -> 开发 -> 错误检查 -> 测试 -> 确认提交
```

## ⚙️ 配置详解

### AI 配置

```javascript
ai: {
  enabled: true,
  model: 'claude-3.5-sonnet',
  api: {
    provider: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: 'https://api.anthropic.com'
  },
  features: {
    codeGeneration: true,    // AI 代码生成
    codeReview: true,        // AI 代码审查
    testGeneration: true,     // AI 测试生成
    commitMessageGeneration: true  // AI 提交信息生成
  }
}
```

### 通知配置

支持企业微信、钉钉、邮件通知：

```javascript
notifications: {
  wecom: {
    enabled: true,
    webhook: process.env.WECOM_WEBHOOK
  },
  dingtalk: {
    enabled: true,
    webhook: process.env.DINGTALK_WEBHOOK
  },
  email: {
    enabled: true,
    smtp: { ... },
    recipients: ['team@example.com']
  }
}
```

### 集成配置

#### Jira 集成

```javascript
integrations: {
  jira: {
    enabled: true,
    host: 'https://jira.example.com',
    username: 'your-email@example.com',
    apiToken: process.env.JIRA_API_TOKEN,
    projectKey: 'PROJ'
  }
}
```

#### TAPD 集成

```javascript
integrations: {
  tapd: {
    enabled: true,
    workspaceId: '12345678',
    apiUser: 'your-api-user',
    apiPassword: 'your-api-password'
  }
}
```

#### 工蜂（Git）集成

```javascript
integrations: {
  gongfeng: {
    enabled: true,
    apiURL: 'https://gongfeng.example.com/api',
    privateToken: process.env.GONGFENG_PRIVATE_TOKEN
  }
}
```

## 🔧 实际集成示例

### 集成 Anthropic Claude API

在 `ai-dev-workflow.js` 中添加真实的 API 调用：

```javascript
const Anthropic = require('@anthropic-ai/sdk');

async analyzeRequirementWithAI(requirement) {
  const client = new Anthropic({
    apiKey: config.ai.api.apiKey,
  });
  
  const message = await client.messages.create({
    model: config.ai.model,
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `分析以下需求，返回 JSON 格式：
      需求: ${requirement}
      
      请返回:
      {
        "type": "需求类型",
        "implementation": "实现方式",
        "affectedFiles": ["文件1", "文件2"],
        "testStrategy": "测试策略"
      }`
    }]
  });
  
  return JSON.parse(message.content[0].text);
}
```

### 集成 OpenAI API

```javascript
const OpenAI = require('openai');

async generateCodeWithAI(requirement, analysis) {
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
  
  const response = await openai.chat.completions.create({
    model: 'gpt-4-turbo',
    messages: [{
      role: 'system',
      content: '你是一个专业的代码生成助手。'
    }, {
      role: 'user',
      content: `根据以下需求和分生成代码：
      需求: ${requirement}
      分析: ${JSON.stringify(analysis, null, 2)}
      
      请生成完整的 React 组件代码和对应的测试代码。`
    }]
  });
  
  // 解析返回的代码
  return this.parseGeneratedCode(response.choices[0].message.content);
}
```

## 📊 使用场景

### 场景 1: 新功能开发

```bash
# 1. 启动工具
node ai-dev-workflow.js

# 2. 选择模板 "新功能开发"

# 3. 输入需求
功能描述: 实现用户管理模块
输入: 用户信息表单
输出: 用户列表、用户详情
影响范围: 前端用户页面、后端用户 API

# 4. AI 自动生成代码

# 5. 自动运行错误检查

# 6. 自动生成并运行测试

# 7. AI 生成提交信息并提交
```

### 场景 2: Bug 修复

```bash
# 1. 启动工具
node ai-dev-workflow.js

# 2. 选择模板 "Bug 修复"

# 3. 输入问题描述
问题描述: 用户登录后页面闪烁
复现步骤: 1. 输入正确用户名密码 2. 点击登录 3. 页面闪烁后停留在登录页
预期行为: 登录成功后跳转到首页
实际行为: 页面闪烁后停留在登录页

# 4. AI 分析并定位问题

# 5. AI 生成修复代码

# 6. 运行测试验证修复

# 7. 提交修复
```

### 场景 3: 性能优化

```bash
# 1. 启动工具
node ai-dev-workflow.js

# 2. 选择模板 "性能优化"

# 3. 输入优化目标
优化目标: 减少首页加载时间
当前性能: 首屏加载 3 秒
预期提升: 首屏加载 < 1 秒
实施方案: 代码分割、懒加载、缓存优化

# 4. AI 生成优化方案

# 5. 实施优化

# 6. 性能测试

# 7. 提交优化
```

## 🛠️ 高级功能

### 1. 自定义需求模板

在 `dev-workflow.config.js` 中添加：

```javascript
stages: {
  requirement: {
    templates: [
      {
        name: 'API 接口开发',
        template: '接口名称: \n请求方法: \n请求路径: \n请求参数: \n响应格式: '
      },
      {
        name: '数据库迁移',
        template: '迁移描述: \n影响的表: \n迁移步骤: \n回滚方案: '
      }
    ]
  }
}
```

### 2. 自定义检查项

```javascript
stages: {
  errorCheck: {
    checks: [
      {
        name: '自定义检查',
        command: 'npm run custom-check',
        required: true,
        timeout: 60000
      }
    ]
  }
}
```

### 3. 自定义测试命令

```javascript
stages: {
  testing: {
    testTypes: [
      {
        name: '性能测试',
        command: 'npm run test:performance',
        required: false,
        timeout: 600000
      }
    ]
  }
}
```

## 🐛 故障排查

### 问题 1: AI API 调用失败

**解决方案：**
1. 检查 API Key 是否正确
2. 检查网络连接
3. 检查 API 配额
4. 查看错误日志 `dev-workflow.log`

### 问题 2: 编译检查失败

**解决方案：**
1. 检查 TypeScript 配置
2. 检查依赖是否安装
3. 查看详细错误信息
4. 使用 `--skip-checks` 跳过检查（不推荐）

### 问题 3: 测试失败

**解决方案：**
1. 检查测试配置
2. 检查测试依赖
3. 查看测试报告
4. 使用 `--skip-tests` 跳过测试（不推荐）

## 📚 参考资料

- [Conventional Commits](https://www.conventionalcommits.org/)
- [TypeScript 官方文档](https://www.typescriptlang.org/docs/)
- [Jest 测试框架](https://jestjs.io/)
- [Anthropic Claude API](https://docs.anthropic.com/)
- [OpenAI API](https://platform.openai.com/docs/)

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

MIT License
