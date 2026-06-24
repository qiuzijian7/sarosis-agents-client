# 完整开发流程使用示例

本文档提供了完整开发流程工具的实际使用场景和示例。

## 📋 目录

1. [快速开始](#快速开始)
2. [使用场景](#使用场景)
3. [配置示例](#配置示例)
4. [AI 集成示例](#ai-集成示例)
5. [CI/CD 集成](#cicd-集成)
6. [最佳实践](#最佳实践)

## 🚀 快速开始

### 示例 1: 基础使用（带 AI 辅助）

```bash
# 启动完整开发流程
npm run workflow

# 或直接使用脚本
./dev-workflow.sh
# Windows:
dev-workflow.bat
```

**交互过程：**

```
🚀 启动完整开发流程...
================================================
✅ Node.js 版本检查通过: v18.16.0
✅ 依赖检查完成

📋 配置:
  AI 辅助: true
  跳过测试: false
  跳过检查: false
  自动提交: false

🚀 执行命令: node ai-dev-workflow.js
================================================

📝 阶段 1: 需求输入与 AI 分析
============================================================

📋 可用需求模板:
  1. 新功能开发
  2. Bug 修复
  3. 性能优化
  0. 不使用模板

请选择模板 (输入编号, 回车跳过): 1

已选择模板，请补充具体内容:
---------------------------------------------------------------
功能描述: 
输入: 
输出: 
影响范围: 
---------------------------------------------------------------

请输入您的需求 (输入空行结束):
功能描述: 实现用户登录功能
输入: 用户名、密码
输出: 登录成功/失败，跳转首页
影响范围: 前端登录页面、后端认证 API、用户状态管理

🤖 AI 正在分析需求...
  [模拟] 调用 AI API 分析需求...

📊 AI 需求分析结果:
============================================================
需求类型: 新功能开发
建议的实现方式: 建议创建登录组件、认证服务、路由守卫
预估影响文件: src/components/Login.tsx, src/services/auth.ts, src/App.tsx
建议的测试策略: 单元测试 + 组件测试 + E2E 测试
============================================================

🔧 阶段 2: AI 辅助开发实现
============================================================

🤖 AI 正在生成代码...
  [模拟] 调用 AI API 生成代码...

📄 AI 生成的代码:
============================================================

文件 1: src/components/Login.tsx
---------------------------------------------------------------
import React, { useState } from 'react';
import { Button, Input, Card } from '@/components/ui';
import { authService } from '../services/auth';

export const Login: React.FC = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleLogin = async () => {
    try {
      await authService.login(username, password);
      window.location.href = '/';
    } catch (err) {
      setError('登录失败，请检查用户名和密码');
    }
  };

  return (
    <Card className="login-card">
      <h2>用户登录</h2>
      <Input 
        placeholder="用户名" 
        value={username}
        onChange={e => setUsername(e.target.value)}
      />
      <Input 
        type="password"
        placeholder="密码" 
        value={password}
        onChange={e => setPassword(e.target.value)}
      />
      <Button onClick={handleLogin}>登录</Button>
      {error && <div className="error">{error}</div>}
    </Card>
  );
};
---------------------------------------------------------------

文件 2: src/components/Login.test.tsx
---------------------------------------------------------------
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Login } from './Login';
import { authService } from '../services/auth';

jest.mock('../services/auth', () => ({
  authService: {
    login: jest.fn()
  }
}));

describe('Login', () => {
  it('should render login form', () => {
    render(<Login />);
    expect(screen.getByPlaceholderText('用户名')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('密码')).toBeInTheDocument();
    expect(screen.getByText('登录')).toBeInTheDocument();
  });

  it('should call authService.login on button click', async () => {
    render(<Login />);
    fireEvent.change(screen.getByPlaceholderText('用户名'), {
      target: { value: 'testuser' }
    });
    fireEvent.change(screen.getByPlaceholderText('密码'), {
      target: { value: 'password123' }
    });
    fireEvent.click(screen.getByText('登录'));
    
    expect(authService.login).toHaveBeenCalledWith('testuser', 'password123');
  });
});
---------------------------------------------------------------

是否将生成的代码写入文件？(y/n/edit): y
✅ 已写入: src/components/Login.tsx
✅ 已写入: src/components/Login.test.tsx

🔍 执行初始编译检查...
✅ 初始编译检查通过

📊 阶段 3: 错误检查与 AI 辅助修复
============================================================

正在执行: TypeScript 类型检查
---------------------------------------------------------------
✅ TypeScript 类型检查 通过

正在执行: ESLint 检查
---------------------------------------------------------------
✅ ESLint 检查 通过

正在执行: 代码格式检查
---------------------------------------------------------------
✅ 代码格式检查 通过

正在执行: 循环依赖检查
---------------------------------------------------------------
✅ 循环依赖检查 通过

✅ 所有错误检查通过！

🧪 阶段 4: 测试验证与 AI 生成测试
============================================================

🤖 AI 正在生成测试用例...
  [模拟] 调用 AI API 生成测试...

📝 AI 生成了 2 个测试文件:
  1. src/services/auth.test.ts
  2. src/pages/LoginPage.test.tsx

是否写入测试文件？(y/n): y
✅ 已写入测试: src/services/auth.test.ts
✅ 已写入测试: src/pages/LoginPage.test.tsx

正在执行: 单元测试
---------------------------------------------------------------
✅ 单元测试 通过

📊 测试覆盖率:
总覆盖率: 85.2%

✅ 所有测试通过！

✅ 阶段 5: 确认提交
============================================================

📊 Git 状态:
 M src/components/Login.tsx
 M src/components/Login.test.tsx
 A src/services/auth.test.ts
 A src/pages/LoginPage.test.tsx

🤖 AI 正在生成提交信息...
  [模拟] 调用 AI API 生成提交信息...

📝 AI 生成的提交信息:
============================================================
feat: 实现用户登录功能

需求描述:
功能描述: 实现用户登录功能
输入: 用户名、密码
输出: 登录成功/失败，跳转首页
影响范围: 前端登录页面、后端认证 API、用户状态管理

AI 分析:
{
  "type": "新功能开发",
  "implementation": "建议创建登录组件、认证服务、路由守卫",
  "affectedFiles": ["src/components/Login.tsx", "src/services/auth.ts", "src/App.tsx"],
  "testStrategy": "单元测试 + 组件测试 + E2E 测试"
}

变更文件:
src/components/Login.tsx
src/components/Login.test.tsx
src/services/auth.test.ts
src/pages/LoginPage.test.tsx

流程: Prompt输入需求 -> 开发 -> 错误检查 -> 测试 -> 确认提交
============================================================

确认提交以上更改？(y/n/edit): y

📦 正在添加文件到 Git...
💾 正在提交...
  [main 1a2b3c4] feat: 实现用户登录功能
   4 files changed, 156 insertions(+)

✅ 提交成功！

是否推送到远程仓库？(y/n): y

⬆️  正在推送...
  Enumerating objects: 9, done.
  Counting objects: 100% (9/9), done.
  Delta compression using up to 8 threads
  Compressing objects: 100% (5/5), done.
  Writing objects: 100% (5/5), 1.45 KiB | 1.45 MiB/s, done.
  Total 5 (delta 2), reused 0 (delta 0), pack-reused 0
  To https://github.com/your-org/your-repo.git
    5d6e7f8..1a2b3c4  main -> main

✅ 推送成功！

🎉 完整开发流程执行成功！
============================================================
```

### 示例 2: 不使用 AI（传统模式）

```bash
npm run workflow:no-ai
# 或
node ai-dev-workflow.js --no-ai
```

### 示例 3: 跳过测试和检查（快速迭代）

```bash
# 跳过测试
npm run workflow:skip-tests

# 跳过错误检查
npm run workflow:skip-checks

# 同时跳过测试和检查
npm run workflow:skip-tests -- --skip-checks
```

### 示例 4: 自动提交

```bash
npm run workflow:auto-commit
# 或
node ai-dev-workflow.js --auto-commit
```

## 🎯 使用场景

### 场景 1: 新功能开发

**需求：** 实现用户管理模块

```bash
# 1. 启动工作流
npm run workflow

# 2. 选择模板 "新功能开发"

# 3. 输入需求
功能描述: 实现用户管理模块
输入: 用户信息表单（姓名、邮箱、角色）
输出: 用户列表、用户详情、操作结果
影响范围: 前端用户页面、后端用户 API、数据库用户表

# 4. AI 自动生成代码
#   - src/pages/UserManagement.tsx
#   - src/components/UserForm.tsx
#   - src/components/UserList.tsx
#   - src/services/userService.ts
#   - src/services/userService.test.ts

# 5. 自动运行错误检查
#   - TypeScript 类型检查
#   - ESLint 检查
#   - 代码格式检查

# 6. 自动生成并运行测试
#   - 单元测试
#   - 组件测试
#   - 集成测试

# 7. AI 生成提交信息并提交
#   feat: 实现用户管理模块
```

### 场景 2: Bug 修复

**需求：** 修复用户登录后页面闪烁的问题

```bash
# 1. 启动工作流
npm run workflow

# 2. 选择模板 "Bug 修复"

# 3. 输入问题描述
问题描述: 用户登录后页面闪烁
复现步骤: 
  1. 输入正确用户名密码
  2. 点击登录
  3. 页面闪烁后停留在登录页
预期行为: 登录成功后跳转到首页
实际行为: 页面闪烁后停留在登录页

# 4. AI 分析并定位问题
#   AI 分析: 可能是路由守卫或状态管理的问题
#   影响文件: src/components/Login.tsx, src/App.tsx, src/store/auth.ts

# 5. AI 生成修复代码

# 6. 运行测试验证修复

# 7. 提交修复
#   fix: 修复用户登录后页面闪烁的问题
```

### 场景 3: 性能优化

**需求：** 减少首页加载时间

```bash
# 1. 启动工作流
npm run workflow

# 2. 选择模板 "性能优化"

# 3. 输入优化目标
优化目标: 减少首页加载时间
当前性能: 首屏加载 3 秒
预期提升: 首屏加载 < 1 秒
实施方案: 代码分割、懒加载、缓存优化

# 4. AI 生成优化方案
#   - 路由级别代码分割
#   - 组件懒加载
#   - API 响应缓存

# 5. 实施优化

# 6. 性能测试

# 7. 提交优化
#   perf: 优化首页加载性能
```

### 场景 4: 代码重构

**需求：** 重构用户服务模块

```bash
# 1. 启动工作流（不使用 AI）
npm run workflow:no-ai

# 2. 手动输入需求
重构用户服务模块，改善代码可维护性
- 拆分大型服务类
- 提取通用逻辑
- 改善错误处理
- 添加更完善的类型定义

# 3. 手动重构代码

# 4. 运行错误检查

# 5. 运行测试确保不破坏现有功能

# 6. 提交重构
#   refactor: 重构用户服务模块，改善代码可维护性
```

## ⚙️ 配置示例

### 示例 1: 基础配置

```javascript
// dev-workflow.config.js
module.exports = {
  project: {
    name: 'My VSCode Extension',
    version: '1.0.0',
    rootDir: __dirname,
    srcDir: path.join(__dirname, 'src'),
    testDir: path.join(__dirname, 'test')
  },
  
  stages: {
    requirement: {
      enabled: true,
      templates: [
        {
          name: 'VSCode 功能开发',
          template: '功能描述: \n触发方式: \n预期行为: \n影响范围: '
        }
      ]
    },
    
    development: {
      enabled: true,
      autoCompile: true,
      compileCommand: 'npm run compile'
    },
    
    errorCheck: {
      enabled: true,
      checks: [
        {
          name: 'TypeScript 检查',
          command: 'npm run compile-check-ts-native',
          required: true
        },
        {
          name: 'ESLint 检查',
          command: 'npm run eslint',
          required: true
        }
      ]
    },
    
    testing: {
      enabled: true,
      testTypes: [
        {
          name: '单元测试',
          command: 'npm test',
          required: true
        }
      ]
    },
    
    commit: {
      enabled: true,
      messageFormat: 'conventional',
      autoPush: false
    }
  }
};
```

### 示例 2: 启用 AI 辅助

```javascript
// dev-workflow.config.js
module.exports = {
  // ... 其他配置
  
  ai: {
    enabled: true,
    model: 'claude-3.5-sonnet',
    api: {
      provider: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: 'https://api.anthropic.com'
    },
    features: {
      codeGeneration: true,
      codeReview: true,
      testGeneration: true,
      commitMessageGeneration: true
    }
  }
};
```

### 示例 3: 集成通知

```javascript
// dev-workflow.config.js
module.exports = {
  // ... 其他配置
  
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
      smtp: {
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS
        }
      },
      recipients: ['team@example.com']
    }
  }
};
```

### 示例 4: 集成项目管理工具

```javascript
// dev-workflow.config.js
module.exports = {
  // ... 其他配置
  
  integrations: {
    jira: {
      enabled: true,
      host: 'https://jira.example.com',
      username: 'your-email@example.com',
      apiToken: process.env.JIRA_API_TOKEN,
      projectKey: 'PROJ'
    },
    tapd: {
      enabled: true,
      workspaceId: '12345678',
      apiUser: 'your-api-user',
      apiPassword: 'your-api-password'
    }
  }
};
```

## 🤖 AI 集成示例

### 示例 1: 集成 Anthropic Claude API

在 `ai-dev-workflow.js` 中添加：

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
  "type": "需求类型（新功能/bug修复/性能优化/重构）",
  "implementation": "建议的实现方式",
  "affectedFiles": ["文件1", "文件2"],
  "testStrategy": "建议的测试策略"
}`
    }]
  });
  
  return JSON.parse(message.content[0].text);
}

async generateCodeWithAI(requirement, analysis) {
  const client = new Anthropic({
    apiKey: config.ai.api.apiKey,
  });
  
  const message = await client.messages.create({
    model: config.ai.model,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `根据以下需求和分生成代码：

需求: ${requirement}

分析: ${JSON.stringify(analysis, null, 2)}

请生成：
1. React 组件代码（使用 TypeScript）
2. 对应的样式文件
3. 对应的测试文件
4. 需要的服务/工具函数

要求：
- 使用函数式组件和 Hooks
- 添加完整的类型定义
- 添加 JSDoc 注释
- 遵循项目代码规范
- 包含完整的单元测试`
    }]
  });
  
  // 解析返回的代码
  return this.parseGeneratedCode(message.content[0].text);
}
```

### 示例 2: 集成 OpenAI API

```javascript
const OpenAI = require('openai');

async generateTestsWithAI(filesChanged) {
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
  
  // 读取变更的文件
  const filesContent = filesChanged.map(file => {
    const content = fs.readFileSync(path.join(__dirname, file), 'utf8');
    return { path: file, content };
  });
  
  const response = await openai.chat.completions.create({
    model: 'gpt-4-turbo',
    messages: [{
      role: 'system',
      content: '你是一个专业的测试工程师，擅长编写 Jest 和 React Testing Library 测试。'
    }, {
      role: 'user',
      content: `为以下代码生成完整的单元测试：

${filesContent.map(f => `文件: ${f.path}\n\`\`\`typescript\n${f.content}\n\`\`\``).join('\n\n')}

要求：
- 使用 Jest 和 React Testing Library
- 覆盖主要功能和边界情况
- 包含 Mock 数据
- 测试覆盖率 > 80%`
    }]
  });
  
  return this.parseGeneratedTests(response.choices[0].message.content);
}
```

### 示例 3: 集成 GitHub Copilot API

```javascript
// 使用 GitHub Copilot 的代码建议功能
async getCodeSuggestions(codeContext) {
  // 这里需要使用 GitHub Copilot 的 API 或 VSCode 扩展 API
  // 示例代码：
  
  const suggestions = await vscode.commands.executeCommand(
    'github.copilot.generateCode',
    {
      language: 'typescript',
      context: codeContext
    }
  );
  
  return suggestions;
}
```

## 🔄 CI/CD 集成

### 示例 1: GitHub Actions

```yaml
# .github/workflows/dev-workflow.yml
name: Development Workflow

on:
  push:
    branches: [ main, develop ]
  pull_request:
    branches: [ main ]

jobs:
  workflow:
    runs-on: ubuntu-latest
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Setup Node.js
      uses: actions/setup-node@v3
      with:
        node-version: '18'
        cache: 'npm'
    
    - name: Install dependencies
      run: npm ci
    
    - name: Run development workflow (checks only)
      run: |
        node ai-dev-workflow.js --no-ai --skip-tests --auto-commit
      env:
        ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    
    - name: Run tests
      run: npm test
    
    - name: Build
      run: npm run compile
```

### 示例 2: Jenkins Pipeline

```groovy
// Jenkinsfile
pipeline {
    agent any
    
    environment {
        ANTHROPIC_API_KEY = credentials('anthropic-api-key')
        NODE_VERSION = '18'
    }
    
    stages {
        stage('Checkout') {
            steps {
                git branch: 'main', 
                url: 'https://github.com/your-org/your-repo.git'
            }
        }
        
        stage('Setup') {
            steps {
                sh "nvm install ${NODE_VERSION}"
                sh "nvm use ${NODE_VERSION}"
                sh 'npm ci'
            }
        }
        
        stage('Development Workflow') {
            steps {
                sh 'node ai-dev-workflow.js --no-ai --skip-tests'
            }
        }
        
        stage('Test') {
            steps {
                sh 'npm test'
            }
        }
        
        stage('Build') {
            steps {
                sh 'npm run compile'
            }
        }
        
        stage('Commit & Push') {
            when {
                branch 'develop'
            }
            steps {
                sh 'git add -A'
                sh 'git commit -m "feat: automated development workflow"'
                sh 'git push'
            }
        }
    }
    
    post {
        success {
            echo 'Development workflow completed successfully!'
        }
        failure {
            echo 'Development workflow failed!'
            // 发送通知
        }
    }
}
```

## 💡 最佳实践

### 1. 需求描述最佳实践

**好的需求描述：**
```
功能描述: 实现用户登录功能
输入: 用户名（字符串，6-20位）、密码（字符串，8-32位，需包含字母和数字）
输出: 
  - 成功：返回用户信息和 token，跳转到首页
  - 失败：返回错误提示（用户名或密码错误）
影响范围: 
  - 前端：登录页面、认证状态管理
  - 后端：认证 API、token 生成和验证
  - 数据库：用户表、会话表
依赖: 
  - 需要后端提供认证 API
  - 需要 JWT token 生成库
测试策略: 
  - 单元测试：认证服务
  - 集成测试：登录 API
  - E2E 测试：完整登录流程
```

**不好的需求描述：**
```
实现登录功能
```

### 2. 提交信息最佳实践

**好的提交信息：**
```
feat: 实现用户登录功能

需求描述:
功能描述: 实现用户登录功能
输入: 用户名、密码
输出: 登录成功/失败，跳转首页
影响范围: 前端登录页面、后端认证 API、用户状态管理

AI 分析:
{
  "type": "新功能开发",
  "implementation": "创建登录组件和认证服务",
  "affectedFiles": [...],
  "testStrategy": "单元测试 + 集成测试 + E2E 测试"
}

变更文件:
- src/components/Login.tsx (新增)
- src/services/auth.ts (新增)
- src/App.tsx (修改)
- tests/Login.test.tsx (新增)

测试:
- 所有测试通过
- 覆盖率: 85.2%

流程: Prompt输入需求 -> 开发 -> 错误检查 -> 测试 -> 确认提交
```

**不好的提交信息：**
```
修复了一些问题
```

### 3. AI 使用最佳实践

1. **提供清晰的需求描述** - AI 的输出质量取决于输入质量
2. **审查 AI 生成的代码** - 不要盲目接受 AI 的建议
3. **逐步迭代** - 如果 AI 生成的代码不满意，改进需求描述后重新生成
4. **结合人工审查** - AI 是辅助工具，最终决策权在人类
5. **保护敏感信息** - 不要将 API 密钥、密码等敏感信息发送给 AI

### 4. 测试最佳实践

1. **测试驱动开发（TDD）** - 先写测试，再写实现
2. **保持测试独立** - 每个测试应该独立运行
3. **Mock 外部依赖** - 不要依赖外部服务
4. **测试边界情况** - 不仅要测试正常情况，还要测试异常情况
5. **维护测试** - 随着代码变化更新测试

### 5. 代码审查最佳实践

1. **审查所有代码** - 不要跳过任何文件
2. **关注逻辑错误** - 而不仅仅是代码风格
3. **提供建设性反馈** - 说明为什么和建议如何改进
4. **讨论替代方案** - 可能有多种实现方式
5. **认可好的代码** - 正面反馈同样重要

## 📚 更多资源

- [Conventional Commits 规范](https://www.conventionalcommits.org/)
- [TypeScript 最佳实践](https://typescript.tv/best-practices/)
- [React 测试最佳实践](https://github.com/mawrk/React-Testing-Best-Practices)
- [Anthropic Claude API 文档](https://docs.anthropic.com/)
- [OpenAI API 文档](https://platform.openai.com/docs/)

---

**需要帮助？** 欢迎提交 Issue 或 Pull Request！
