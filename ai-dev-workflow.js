#!/usr/bin/env node

/**
 * AI 辅助开发工作流
 * 集成 AI 能力到完整开发流程中
 */

const DevWorkflow = require('./dev-workflow.js');
const config = require('./dev-workflow.config.js');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class AIAssistedDevWorkflow extends DevWorkflow {
  constructor() {
    super();
    this.aiEnabled = config.ai.enabled;
    this.conversationHistory = [];
  }

  /**
   * 阶段 1: AI 辅助需求分析
   */
  async inputRequirement() {
    console.log('\n📝 阶段 1: 需求输入与 AI 分析');
    console.log('='.repeat(60));

    // 显示需求模板选择
    if (config.stages.requirement.templates.length > 0) {
      console.log('\n📋 可用需求模板:');
      config.stages.requirement.templates.forEach((template, index) => {
        console.log(`  ${index + 1}. ${template.name}`);
      });
      console.log('  0. 不使用模板');
    }

    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    // 获取用户选择
    const templateChoice = await new Promise(resolve => {
      rl.question('\n请选择模板 (输入编号, 回车跳过): ', resolve);
    });

    let requirement = '';
    if (templateChoice && parseInt(templateChoice) > 0) {
      const templateIndex = parseInt(templateChoice) - 1;
      if (config.stages.requirement.templates[templateIndex]) {
        requirement = config.stages.requirement.templates[templateIndex].template;
        console.log('\n已选择模板，请补充具体内容:');
        console.log('-'.repeat(60));
        console.log(requirement);
        console.log('-'.repeat(60));
      }
    }

    // 获取用户需求输入
    console.log('\n请输入您的需求 (输入空行结束):');
    requirement = await this.readMultilineInput(rl, requirement);
    rl.close();

    this.workflowData.requirement = requirement;

    // AI 分析需求
    if (this.aiEnabled && config.ai.features.codeGeneration) {
      console.log('\n🤖 AI 正在分析需求...');
      const analysis = await this.analyzeRequirementWithAI(requirement);
      
      console.log('\n📊 AI 需求分析结果:');
      console.log('='.repeat(60));
      console.log(`需求类型: ${analysis.type}`);
      console.log(`建议的实现方式: ${analysis.implementation}`);
      console.log(`预估影响文件: ${analysis.affectedFiles.join(', ')}`);
      console.log(`建议的测试策略: ${analysis.testStrategy}`);
      console.log('='.repeat(60));

      this.workflowData.aiAnalysis = analysis;
    }

    return true;
  }

  /**
   * 阶段 2: AI 辅助代码生成
   */
  async develop() {
    console.log('\n🔧 阶段 2: AI 辅助开发实现');
    console.log('='.repeat(60));

    if (!this.aiEnabled || !config.ai.features.codeGeneration) {
      console.log('⚠️  AI 辅助未启用，使用传统开发方式');
      return super.develop();
    }

    const requirement = this.workflowData.requirement;
    const analysis = this.workflowData.aiAnalysis;

    console.log('\n🤖 AI 正在生成代码...');

    try {
      // 根据需求生成代码
      const generatedCode = await this.generateCodeWithAI(requirement, analysis);
      
      // 显示生成的代码
      console.log('\n📄 AI 生成的代码:');
      console.log('='.repeat(60));
      generatedCode.forEach((file, index) => {
        console.log(`\n文件 ${index + 1}: ${file.path}`);
        console.log('-'.repeat(60));
        console.log(file.content);
        console.log('-'.repeat(60));
      });

      // 询问是否写入文件
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      const answer = await new Promise(resolve => {
        rl.question('\n是否将生成的代码写入文件？(y/n/edit): ', resolve);
      });

      if (answer.toLowerCase() === 'y') {
        // 写入文件
        for (const file of generatedCode) {
          const fullPath = path.join(__dirname, file.path);
          const dir = path.dirname(fullPath);
          
          // 创建目录
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          
          // 写入文件
          fs.writeFileSync(fullPath, file.content);
          console.log(`✅ 已写入: ${file.path}`);
          this.workflowData.filesChanged.push(file.path);
        }
      } else if (answer.toLowerCase() === 'edit') {
        // 允许用户编辑
        console.log('\n请手动编辑生成的代码...');
        // 这里可以打开编辑器
      }

      rl.close();

      // 运行初始编译检查
      console.log('\n🔍 执行初始编译检查...');
      const compileResult = this.runCompileCheck();
      
      if (compileResult.success) {
        console.log('✅ 初始编译检查通过');
      } else {
        console.log('⚠️  初始编译检查发现问题:');
        console.log(compileResult.output);
        
        // AI 辅助修复
        if (this.aiEnabled) {
          console.log('\n🤖 AI 正在尝试修复编译错误...');
          const fixed = await this.fixErrorsWithAI(compileResult.output);
          if (fixed) {
            console.log('✅ AI 已尝试修复，请检查代码');
          }
        }
      }

      return true;
    } catch (error) {
      console.error('❌ 代码生成失败:', error.message);
      return false;
    }
  }

  /**
   * 阶段 3: AI 辅助错误修复
   */
  async checkErrors() {
    console.log('\n🔍 阶段 3: 错误检查与 AI 辅助修复');
    console.log('='.repeat(60));

    const checks = config.stages.errorCheck.checks;
    let allPassed = true;

    for (const check of checks) {
      console.log(`\n正在执行: ${check.name}`);
      console.log('-'.repeat(60));
      
      try {
        const output = execSync(check.command, { 
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: check.timeout
        });
        console.log(`✅ ${check.name} 通过`);
      } catch (error) {
        console.log(`❌ ${check.name} 失败`);
        const errorOutput = error.stdout || error.stderr || error.message;
        console.log('错误信息:');
        console.log(errorOutput);
        
        this.workflowData.errors.push({
          stage: check.name,
          error: errorOutput
        });

        // AI 辅助修复
        if (this.aiEnabled && config.ai.features.codeReview) {
          console.log('\n🤖 AI 正在分析错误并提供修复建议...');
          const fixSuggestion = await this.getFixSuggestionWithAI(errorOutput);
          
          console.log('\n💡 AI 修复建议:');
          console.log('='.repeat(60));
          console.log(fixSuggestion);
          console.log('='.repeat(60));

          const readline = require('readline');
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
          });

          const answer = await new Promise(resolve => {
            rl.question('\n是否应用 AI 修复建议？(y/n): ', resolve);
          });
          rl.close();

          if (answer.toLowerCase() === 'y') {
            await this.applyFixWithAI(fixSuggestion);
            console.log('✅ 已应用修复，重新检查...');
            // 递归重新检查
            return this.checkErrors();
          }
        }

        if (check.required) {
          allPassed = false;
          if (config.stages.errorCheck.errorStrategy === 'fail-fast') {
            return false;
          }
        }
      }
    }

    if (allPassed) {
      console.log('\n✅ 所有错误检查通过！');
      return true;
    } else {
      console.log('\n⚠️  部分检查未通过');
      return false;
    }
  }

  /**
   * 阶段 4: AI 生成测试
   */
  async runTests() {
    console.log('\n🧪 阶段 4: 测试验证与 AI 生成测试');
    console.log('='.repeat(60));

    // AI 生成测试
    if (this.aiEnabled && config.ai.features.testGeneration) {
      console.log('\n🤖 AI 正在生成测试用例...');
      const generatedTests = await this.generateTestsWithAI(this.workflowData.filesChanged);
      
      if (generatedTests && generatedTests.length > 0) {
        console.log(`\n📝 AI 生成了 ${generatedTests.length} 个测试文件:`);
        generatedTests.forEach((test, index) => {
          console.log(`  ${index + 1}. ${test.path}`);
        });

        const readline = require('readline');
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });

        const answer = await new Promise(resolve => {
          rl.question('\n是否写入测试文件？(y/n): ', resolve);
        });
        rl.close();

        if (answer.toLowerCase() === 'y') {
          for (const test of generatedTests) {
            const fullPath = path.join(__dirname, test.path);
            const dir = path.dirname(fullPath);
            
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }
            
            fs.writeFileSync(fullPath, test.content);
            console.log(`✅ 已写入测试: ${test.path}`);
          }
        }
      }
    }

    // 运行测试
    const testTypes = config.stages.testing.testTypes;
    let allPassed = true;

    for (const test of testTypes) {
      console.log(`\n正在执行: ${test.name}`);
      console.log('-'.repeat(60));
      
      try {
        const output = execSync(test.command, { 
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: test.timeout
        });
        console.log(`✅ ${test.name} 通过`);
        
        // 显示覆盖率
        if (output.includes('coverage')) {
          console.log('\n📊 测试覆盖率:');
          console.log(this.extractCoverageInfo(output));
        }
      } catch (error) {
        console.log(`❌ ${test.name} 失败`);
        console.log('错误:', error.stdout || error.stderr || error.message);
        
        if (test.required) {
          allPassed = false;
          if (config.stages.testing.failureStrategy === 'fail-fast') {
            return false;
          }
        }
      }
    }

    if (allPassed) {
      console.log('\n✅ 所有测试通过！');
      return true;
    } else {
      console.log('\n⚠️  部分测试未通过');
      return false;
    }
  }

  /**
   * 阶段 5: AI 生成提交信息
   */
  async confirmAndCommit() {
    console.log('\n✅ 阶段 5: 确认提交');
    console.log('='.repeat(60));

    // 检查 Git 状态
    console.log('\n📊 Git 状态:');
    try {
      const status = execSync('git status --short', { encoding: 'utf8' });
      if (!status.trim()) {
        console.log('❌ 没有检测到任何更改');
        return false;
      }
      console.log(status);
    } catch (error) {
      console.error('❌ 无法获取 Git 状态');
      return false;
    }

    // AI 生成提交信息
    let commitMessage = '';
    if (this.aiEnabled && config.ai.features.commitMessageGeneration) {
      console.log('\n🤖 AI 正在生成提交信息...');
      commitMessage = await this.generateCommitMessageWithAI();
      
      console.log('\n📝 AI 生成的提交信息:');
      console.log('='.repeat(60));
      console.log(commitMessage);
      console.log('='.repeat(60));
    } else {
      commitMessage = this.generateCommitMessage();
    }

    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const answer = await new Promise(resolve => {
      rl.question('\n确认提交以上更改？(y/n/edit): ', resolve);
    });
    rl.close();

    if (answer.toLowerCase() === 'y') {
      this.workflowData.commitMessage = commitMessage;
      return this.doCommit();
    } else if (answer.toLowerCase() === 'edit') {
      const newMessage = await this.editCommitMessage(commitMessage);
      this.workflowData.commitMessage = newMessage;
      return this.doCommit();
    } else {
      console.log('❌ 提交已取消');
      return false;
    }
  }

  /**
   * AI 辅助方法
   */
  async analyzeRequirementWithAI(requirement) {
    // 这里是模拟 AI 分析，实际应该调用 AI API
    // 例如：Anthropic Claude API, OpenAI API 等
    
    console.log('  [模拟] 调用 AI API 分析需求...');
    
    // 模拟返回结果
    return {
      type: '新功能开发',
      implementation: '建议创建新的 React 组件，并集成到现有页面中',
      affectedFiles: ['src/components/NewComponent.tsx', 'src/pages/MainPage.tsx', 'src/App.tsx'],
      testStrategy: '单元测试 + 组件测试 + E2E 测试'
    };
  }

  async generateCodeWithAI(requirement, analysis) {
    // 模拟 AI 代码生成
    console.log('  [模拟] 调用 AI API 生成代码...');
    
    // 模拟返回结果
    return [
      {
        path: 'src/components/ExampleComponent.tsx',
        content: `import React from 'react';
import { Button, Input } from '@/components/ui';

interface ExampleComponentProps {
  title: string;
  onAction: () => void;
}

export const ExampleComponent: React.FC<ExampleComponentProps> = ({ title, onAction }) => {
  return (
    <div className="example-component">
      <h2>{title}</h2>
      <Input placeholder="请输入内容" />
      <Button onClick={onAction}>执行操作</Button>
    </div>
  );
};
`
      },
      {
        path: 'src/components/ExampleComponent.test.tsx',
        content: `import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExampleComponent } from './ExampleComponent';

describe('ExampleComponent', () => {
  it('should render correctly', () => {
    render(<ExampleComponent title="测试" onAction={() => {}} />);
    expect(screen.getByText('测试')).toBeInTheDocument();
  });

  it('should call onAction when button is clicked', () => {
    const mockAction = jest.fn();
    render(<ExampleComponent title="测试" onAction={mockAction} />);
    fireEvent.click(screen.getByText('执行操作'));
    expect(mockAction).toHaveBeenCalled();
  });
});
`
      }
    ];
  }

  async fixErrorsWithAI(errorOutput) {
    console.log('  [模拟] 调用 AI API 修复错误...');
    return true;
  }

  async getFixSuggestionWithAI(errorOutput) {
    console.log('  [模拟] 调用 AI API 获取修复建议...');
    return `
建议修复方案：
1. 检查类型定义是否正确
2. 确认导入路径是否正确
3. 运行 npm run eslint -- --fix 自动修复格式问题
`;
  }

  async applyFixWithAI(fixSuggestion) {
    console.log('  [模拟] 应用 AI 修复...');
    return true;
  }

  async generateTestsWithAI(filesChanged) {
    console.log('  [模拟] 调用 AI API 生成测试...');
    return [];
  }

  async generateCommitMessageWithAI() {
    console.log('  [模拟] 调用 AI API 生成提交信息...');
    
    const lines = this.workflowData.requirement.split('\n');
    const title = lines[0].slice(0, 50);
    
    let message = `feat: ${title}\n\n`;
    message += `需求描述:\n${this.workflowData.requirement}\n\n`;
    if (this.workflowData.aiAnalysis) {
      message += `AI 分析:\n${JSON.stringify(this.workflowData.aiAnalysis, null, 2)}\n\n`;
    }
    message += `变更文件:\n${this.workflowData.filesChanged.join('\n')}\n\n`;
    message += `流程: Prompt输入需求 -> 开发 -> 错误检查 -> 测试 -> 确认提交`;
    
    return message;
  }

  /**
   * 辅助方法
   */
  readMultilineInput(rl, initialText = '') {
    return new Promise((resolve) => {
      let text = initialText;
      let isFirstLine = initialText === '';
      
      const askNextLine = () => {
        rl.question(isFirstLine ? '' : '', (line) => {
          if (line.trim() === '' && text !== '') {
            resolve(text);
          } else {
            text += (text === '' ? '' : '\n') + line;
            isFirstLine = false;
            askNextLine();
          }
        });
      };
      
      askNextLine();
    });
  }

  extractCoverageInfo(output) {
    // 从测试输出中提取覆盖率信息
    const coverageMatch = output.match(/All files[^|]*\|[^|]*([\d.]+)/);
    if (coverageMatch) {
      return `总覆盖率: ${coverageMatch[1]}%`;
    }
    return '无法提取覆盖率信息';
  }
}

// 命令行接口
if (require.main === module) {
  const workflow = new AIAssistedDevWorkflow();
  
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
AI 辅助开发工作流

用法: node ai-dev-workflow.js [选项]

选项:
  --help, -h           显示帮助信息
  --no-ai              禁用 AI 辅助
  --skip-tests          跳过测试阶段
  --skip-checks        跳过错误检查阶段
  --auto-commit        自动提交（使用 AI 生成的提交信息）
  --config <path>      指定配置文件路径

示例:
  node ai-dev-workflow.js
  node ai-dev-workflow.js --no-ai
  node ai-dev-workflow.js --auto-commit
  node ai-dev-workflow.js --config ./my-config.js
    `);
    process.exit(0);
  }

  // 处理命令行参数
  if (args.includes('--no-ai')) {
    workflow.aiEnabled = false;
    console.log('⚠️  AI 辅助已禁用');
  }

  workflow.run().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = AIAssistedDevWorkflow;
