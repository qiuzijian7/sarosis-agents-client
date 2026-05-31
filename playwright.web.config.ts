import { defineConfig } from '@playwright/test';
import path from 'path';

const config = defineConfig({
  testDir: './tests/web',
  timeout: 120_000, // Agent 测试可能需要更长时间
  retries: 0,
  
  use: {
    // 🎥 录像配置 - 始终录制
    video: 'on',
    videoSize: { width: 1920, height: 1080 },
    
    // 🔍 Trace 配置 - 失败时保留（包含截图、网络请求、操作记录）
    trace: 'retain-on-failure',
    
    // 📸 截图配置
    screenshot: 'only-on-failure',
    
    // ⏱️ 操作超时
    actionTimeout: 15_000,
    navigationTimeout: 60_000,
    
    // 🌐 基础 URL
    baseURL: 'http://localhost:9222',
  },
  
  // 🖥️ Web 服务器配置 - 启动 VSCode Web 模式
  webServer: {
    command: 'node scripts/code-sessions-web.js --port 9222 --skip-welcome --mock',
    url: 'http://localhost:9222',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  
  // 📊 报告器
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  
  // 📁 测试结果输出
  outputDir: 'test-results',
  
  // 🎯 项目配置
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        channel: 'chromium',
      },
    },
  ],
});

export default config;
