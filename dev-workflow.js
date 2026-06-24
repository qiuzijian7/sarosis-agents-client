#!/usr/bin/env node

/**
 * 完整开发流程自动化工具
 * Prompt输入需求 -> 开发 -> 错误检查 -> 测试 -> 确认提交
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

class DevWorkflow {
  constructor() {
    this.stages = [
      '需求输入',
      '开发实现',
      '错误检查',
      '测试验证',
      '确认提交'
    ];
    this.currentStage = 0;
    this.workflowData = {
      requirement: '',
      filesChanged: [],
      errors: [],
      testResults: null,
      commitMessage: ''
    };
  }

  /**
   * 阶段 1: 需求输入
   */
  async inputRequirement() {
    console.log('\n📝 阶段 1: 需求输入');
    console.log('='.repeat(50));
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve) => {
      rl.question('请描述您的需求（支持多行，输入空行结束）:\n', (firstLine) => {
        let requirement = firstLine;
        
        const askNextLine = () => {
          rl.question('', (line) => {
            if (line.trim() === '') {
              this.workflowData.requirement = requirement;
              console.log('\n✅ 需求已记录:');
              console.log('-'.repeat(50));
              console.log(requirement);
              console.log('-'.repeat(50));
              rl.close();
              resolve();
            } else {
              requirement += '\n' + line;
              askNextLine();
            }
          });
        };
        
        if (firstLine.trim() !== '') {
          askNextLine();
        } else {
          console.log('❌ 需求不能为空！');
          rl.close();
          process.exit(1);
        }
      });
    });
  }

  /**
   * 阶段 2: 开发实现
   */
  async develop() {
    console.log('\n🔧 阶段 2: 开发实现');
    console.log('='.repeat(50));
    
    console.log('需求分析:');
    console.log(this.workflowData.requirement);
    console.log('\n开始开发...\n');

    // 这里可以集成 AI 代码生成
    // 示例：根据需求自动生成代码
    try {
      // 检查项目结构
      const srcPath = path.join(__dirname, 'src');
      if (fs.existsSync(srcPath)) {
        console.log('✅ 找到 src 目录');
        
        // 示例：创建一个基于需求的新组件
        const componentName = this.extractComponentName(this.workflowData.requirement);
        if (componentName) {
          console.log(`📦 检测到需要创建组件: ${componentName}`);
          // 这里可以调用代码生成逻辑
        }
      }

      // 运行编译检查
      console.log('\n🔍 执行初始编译检查...');
      const compileResult = this.runCompileCheck();
      
      if (compileResult.success) {
        console.log('✅ 初始编译检查通过');
      } else {
        console.log('⚠️  初始编译检查发现问题:');
        console.log(compileResult.output);
      }

      this.currentStage = 1;
      return true;
    } catch (error) {
      console.error('❌ 开发阶段出错:', error.message);
      return false;
    }
  }

  /**
   * 阶段 3: 错误检查
   */
  async checkErrors() {
    console.log('\n🔍 阶段 3: 错误检查');
    console.log('='.repeat(50));

    const checks = [
      { name: 'TypeScript 类型检查', cmd: 'npm run compile-check-ts-native' },
      { name: 'ESLint 代码规范检查', cmd: 'npm run eslint' },
      { name: '代码格式检查', cmd: 'npm run hygiene' }
    ];

    let allPassed = true;

    for (const check of checks) {
      console.log(`\n正在执行: ${check.name}`);
      console.log('-'.repeat(50));
      
      try {
        const output = execSync(check.cmd, { 
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 120000 // 2分钟超时
        });
        console.log(`✅ ${check.name} 通过`);
      } catch (error) {
        console.log(`❌ ${check.name} 失败`);
        console.log('错误信息:');
        console.log(error.stdout || error.stderr || error.message);
        this.workflowData.errors.push({
          stage: check.name,
          error: error.stdout || error.stderr || error.message
        });
        allPassed = false;
        
        // 询问是否继续
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });
        
        const answer = await new Promise(resolve => {
          rl.question('\n是否要查看详细错误并修复？(y/n): ', resolve);
        });
        rl.close();
        
        if (answer.toLowerCase() === 'y') {
          console.log('\n请手动修复错误后按回车继续...');
          await new Promise(resolve => {
            const r = readline.createInterface({
              input: process.stdin,
              output: process.stdout
            });
            r.question('', () => {
              r.close();
              resolve();
            });
          });
        }
      }
    }

    if (allPassed) {
      console.log('\n✅ 所有错误检查通过！');
      return true;
    } else {
      console.log('\n⚠️  部分检查未通过，请修复后重新运行');
      return false;
    }
  }

  /**
   * 阶段 4: 测试验证
   */
  async runTests() {
    console.log('\n🧪 阶段 4: 测试验证');
    console.log('='.repeat(50));

    const testTypes = [
      { name: '单元测试', cmd: 'npm test -- --watchAll=false', optional: false },
      { name: '集成测试', cmd: 'npm run test-browser-no-install', optional: true },
      { name: 'E2E 测试', cmd: 'npm run test-extension', optional: true }
    ];

    for (const test of testTypes) {
      console.log(`\n正在执行: ${test.name}`);
      console.log('-'.repeat(50));
      
      try {
        const output = execSync(test.cmd, { 
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 300000 // 5分钟超时
        });
        console.log(`✅ ${test.name} 通过`);
        this.workflowData.testResults = 'passed';
      } catch (error) {
        if (test.optional) {
          console.log(`⚠️  ${test.name} 失败（可选测试）`);
          console.log('错误:', error.stdout || error.stderr || error.message);
        } else {
          console.log(`❌ ${test.name} 失败`);
          console.log('错误:', error.stdout || error.stderr || error.message);
          this.workflowData.testResults = 'failed';
          
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
          });
          
          const answer = await new Promise(resolve => {
            rl.question('\n测试失败，是否继续？(y/n): ', resolve);
          });
          rl.close();
          
          if (answer.toLowerCase() !== 'y') {
            return false;
          }
        }
      }
    }

    console.log('\n✅ 测试阶段完成');
    return true;
  }

  /**
   * 阶段 5: 确认提交
   */
  async confirmAndCommit() {
    console.log('\n✅ 阶段 5: 确认提交');
    console.log('='.repeat(50));

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

    // 生成提交信息
    const defaultCommitMessage = this.generateCommitMessage();
    console.log('\n📝 提交信息预览:');
    console.log('-'.repeat(50));
    console.log(defaultCommitMessage);
    console.log('-'.repeat(50));

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const answer = await new Promise(resolve => {
      rl.question('\n确认提交以上更改？(y/n/edit): ', resolve);
    });
    rl.close();

    if (answer.toLowerCase() === 'y') {
      this.workflowData.commitMessage = defaultCommitMessage;
      return this.doCommit();
    } else if (answer.toLowerCase() === 'edit') {
      const newMessage = await this.editCommitMessage(defaultCommitMessage);
      this.workflowData.commitMessage = newMessage;
      return this.doCommit();
    } else {
      console.log('❌ 提交已取消');
      return false;
    }
  }

  /**
   * 执行提交
   */
  doCommit() {
    try {
      console.log('\n📦 正在添加文件到 Git...');
      execSync('git add -A', { stdio: 'inherit' });
      
      console.log('\n💾 正在提交...');
      execSync(`git commit -m "${this.workflowData.commitMessage.replace(/"/g, '\\"')}"`, { 
        stdio: 'inherit' 
      });
      
      console.log('\n🚀 提交成功！');
      
      const pushAnswer = await new Promise(resolve => {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });
        rl.question('\n是否推送到远程仓库？(y/n): ', (answer) => {
          rl.close();
          resolve(answer);
        });
      });
      
      if (pushAnswer.toLowerCase() === 'y') {
        console.log('\n⬆️  正在推送...');
        execSync('git push', { stdio: 'inherit' });
        console.log('\n✅ 推送成功！');
      }
      
      return true;
    } catch (error) {
      console.error('❌ 提交失败:', error.message);
      return false;
    }
  }

  /**
   * 辅助方法
   */
  extractComponentName(requirement) {
    const match = requirement.match(/创建|新增|添加|实现|开发.*?(组件|页面|模块|功能)/i);
    if (match) {
      const words = requirement.split(/[，。、\s]+/);
      for (let i = 0; i < words.length; i++) {
        if (words[i].match(/组件|页面|模块|功能/)) {
          return words[i - 1] || 'NewComponent';
        }
      }
    }
    return null;
  }

  runCompileCheck() {
    try {
      const output = execSync('npm run compile-check-ts-native', { 
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 60000
      });
      return { success: true, output };
    } catch (error) {
      return { 
        success: false, 
        output: error.stdout || error.stderr || error.message 
      };
    }
  }

  generateCommitMessage() {
    const lines = this.workflowData.requirement.split('\n');
    const title = lines[0].slice(0, 50);
    const body = lines.slice(1).join('\n');
    
    let message = `feat: ${title}\n\n`;
    if (body) {
      message += `${body}\n\n`;
    }
    message += `流程: 需求输入 -> 开发 -> 错误检查 -> 测试 -> 确认提交`;
    
    return message;
  }

  async editCommitMessage(defaultMessage) {
    console.log('\n请输入新的提交信息（输入空行结束）:');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve) => {
      let message = '';
      const askNextLine = () => {
        rl.question('', (line) => {
          if (line.trim() === '') {
            rl.close();
            resolve(message || defaultMessage);
          } else {
            message += (message ? '\n' : '') + line;
            askNextLine();
          }
        });
      };
      askNextLine();
    });
  }

  /**
   * 运行完整流程
   */
  async run() {
    console.log('🚀 开始完整开发流程');
    console.log('='.repeat(50));

    try {
      // 阶段 1: 需求输入
      await this.inputRequirement();
      
      // 阶段 2: 开发实现
      const devSuccess = await this.develop();
      if (!devSuccess) {
        console.log('❌ 开发阶段失败');
        return;
      }
      
      // 阶段 3: 错误检查
      const checkSuccess = await this.checkErrors();
      if (!checkSuccess) {
        console.log('❌ 错误检查阶段失败');
        return;
      }
      
      // 阶段 4: 测试验证
      const testSuccess = await this.runTests();
      if (!testSuccess) {
        console.log('❌ 测试阶段失败');
        return;
      }
      
      // 阶段 5: 确认提交
      const commitSuccess = await this.confirmAndCommit();
      if (!commitSuccess) {
        console.log('❌ 提交阶段失败');
        return;
      }
      
      console.log('\n🎉 完整开发流程执行成功！');
      console.log('='.repeat(50));
      
    } catch (error) {
      console.error('\n❌ 流程执行出错:', error.message);
      console.error(error.stack);
    }
  }
}

// 命令行接口
if (require.main === module) {
  const workflow = new DevWorkflow();
  
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
用法: node dev-workflow.js [选项]

选项:
  --help, -h     显示帮助信息
  --skip-tests    跳过测试阶段
  --skip-checks   跳过错误检查阶段
  --auto-commit   自动提交（使用默认提交信息）

示例:
  node dev-workflow.js
  node dev-workflow.js --skip-tests
  node dev-workflow.js --auto-commit
    `);
    process.exit(0);
  }

  workflow.run().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = DevWorkflow;
