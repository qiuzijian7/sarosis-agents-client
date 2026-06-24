/**
 * 开发工作流配置文件
 * 可以根据项目需求自定义各个阶段的行为
 */

module.exports = {
  // 项目信息
  project: {
    name: 'VSCode Saros Agents Client',
    version: '2.1.156942',
    rootDir: __dirname,
    srcDir: path.join(__dirname, 'src'),
    testDir: path.join(__dirname, 'test'),
    buildDir: path.join(__dirname, 'out')
  },

  // 阶段配置
  stages: {
    // 阶段 1: 需求输入
    requirement: {
      enabled: true,
      // 需求模板
      templates: [
        {
          name: '新功能开发',
          template: '功能描述: \n输入: \n输出: \n影响范围: '
        },
        {
          name: 'Bug 修复',
          template: '问题描述: \n复现步骤: \n预期行为: \n实际行为: '
        },
        {
          name: '性能优化',
          template: '优化目标: \n当前性能: \n预期提升: \n实施方案: '
        }
      ],
      // 是否启用 AI 辅助分析
      enableAIAnalysis: true
    },

    // 阶段 2: 开发实现
    development: {
      enabled: true,
      // 自动生成的文件类型
      generateTypes: ['component', 'service', 'test'],
      // 代码风格检查
      codeStyle: {
        indentSize: 2,
        semiColons: true,
        quoteMark: 'single',
        trailingComma: 'es5'
      },
      // 是否自动运行编译
      autoCompile: true,
      // 编译命令
      compileCommand: 'npm run compile-check-ts-native'
    },

    // 阶段 3: 错误检查
    errorCheck: {
      enabled: true,
      // 要执行的检查项
      checks: [
        {
          name: 'TypeScript 类型检查',
          command: 'npm run compile-check-ts-native',
          required: true,
          timeout: 120000 // 2分钟
        },
        {
          name: 'ESLint 检查',
          command: 'npm run eslint',
          required: true,
          timeout: 60000
        },
        {
          name: '代码格式检查',
          command: 'npm run hygiene',
          required: false,
          timeout: 30000
        },
        {
          name: '循环依赖检查',
          command: 'npm run check-cyclic-dependencies',
          required: false,
          timeout: 30000
        }
      ],
      // 自动修复配置
      autoFix: {
        eslint: true,
        format: true
      },
      // 错误处理策略: 'prompt' | 'auto-fix' | 'fail-fast'
      errorStrategy: 'prompt'
    },

    // 阶段 4: 测试验证
    testing: {
      enabled: true,
      // 测试类型配置
      testTypes: [
        {
          name: '单元测试',
          command: 'npm test -- --watchAll=false --coverage',
          required: true,
          timeout: 300000 // 5分钟
        },
        {
          name: '浏览器测试',
          command: 'npm run test-browser-no-install',
          required: false,
          timeout: 600000 // 10分钟
        },
        {
          name: 'E2E 测试',
          command: 'npm run test-extension',
          required: false,
          timeout: 600000
        }
      ],
      // 覆盖率要求
      coverage: {
        statements: 80,
        branches: 70,
        functions: 80,
        lines: 80
      },
      // 是否自动运行测试
      autoRun: true,
      // 测试失败策略: 'prompt' | 'continue' | 'fail-fast'
      failureStrategy: 'prompt'
    },

    // 阶段 5: 确认提交
    commit: {
      enabled: true,
      // 提交前检查
      preCommitChecks: [
        'git-status',
        'git-diff',
        'build-check'
      ],
      // 提交信息格式: 'conventional' | 'custom'
      messageFormat: 'conventional',
      // Conventional Commits 配置
      conventional: {
        types: ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'chore'],
        scopes: ['ui', 'api', 'core', 'test', 'docs'],
        allowBreakingChanges: ['feat', 'fix']
      },
      // 是否自动推送到远程
      autoPush: false,
      // 推送前是否创建 Pull Request
      createPR: false
    }
  },

  // 通知配置
  notifications: {
    // 企业微信通知
    wecom: {
      enabled: false,
      webhook: process.env.WECOM_WEBHOOK || ''
    },
    // 钉钉通知
    dingtalk: {
      enabled: false,
      webhook: process.env.DINGTALK_WEBHOOK || ''
    },
    // 邮件通知
    email: {
      enabled: false,
      smtp: {
        host: '',
        port: 587,
        secure: false,
        auth: {
          user: '',
          pass: ''
        }
      },
      recipients: []
    }
  },

  // 日志配置
  logging: {
    level: 'info', // 'debug' | 'info' | 'warn' | 'error'
    file: 'dev-workflow.log',
    console: true,
    format: 'combined' // 'combined' | 'common' | 'dev' | 'short' | 'tiny'
  },

  // AI 辅助配置
  ai: {
    enabled: true,
    // 使用的 AI 模型
    model: 'claude-3.5-sonnet',
    // API 配置
    api: {
      provider: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      baseURL: 'https://api.anthropic.com'
    },
    // 功能开关
    features: {
      codeGeneration: true,
      codeReview: true,
      testGeneration: true,
      commitMessageGeneration: true
    }
  },

  // 集成配置
  integrations: {
    // Jira 集成
    jira: {
      enabled: false,
      host: '',
      username: '',
      apiToken: '',
      projectKey: ''
    },
    // TAPD 集成
    tapd: {
      enabled: false,
      workspaceId: '',
      apiUser: '',
      apiPassword: ''
    },
    // 工蜂（Git）集成
    gongfeng: {
      enabled: false,
      apiURL: '',
      privateToken: ''
    }
  }
};

// 辅助函数：获取配置
function getConfig(stage, key) {
  if (stage && key) {
    return module.exports.stages[stage]?.[key];
  }
  return module.exports;
}

// 辅助函数：更新配置
function updateConfig(stage, key, value) {
  if (stage && key) {
    if (!module.exports.stages[stage]) {
      module.exports.stages[stage] = {};
    }
    module.exports.stages[stage][key] = value;
    return true;
  }
  return false;
}

module.exports.getConfig = getConfig;
module.exports.updateConfig = updateConfig;
