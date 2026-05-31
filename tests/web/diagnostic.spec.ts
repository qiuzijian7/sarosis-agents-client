import { test, expect } from '@playwright/test';

test.describe('Agent Studio Diagnostic Tests', () => {
  
  test('Diagnose WebView loading error', async ({ page }) => {
    // 🎯 收集浏览器控制台日志
    const consoleLogs: Array<{ type: string; text: string }> = [];
    page.on('console', msg => {
      consoleLogs.push({ type: msg.type(), text: msg.text() });
    });
    
    // 🚨 收集页面错误
    const pageErrors: Array<string> = [];
    page.on('pageerror', error => {
      pageErrors.push(error.message);
    });
    
    // 🌐 打开 VSCode Web
    await page.goto('http://localhost:9222');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(5_000); // 等待完全加载
    
    // 📸 截图：初始状态
    await page.screenshot({ 
      path: 'test-results/diag-01-initial.png',
      fullPage: true 
    });
    
    // 🔍 查找错误信息中的 "Show Logs" 按钮
    const showLogsButtons = page.locator('button:has-text("Show Logs")');
    const buttonCount = await showLogsButtons.count();
    console.log(`Found ${buttonCount} "Show Logs" buttons`);
    
    if (buttonCount > 0) {
      // 🖱️ 点击第一个 "Show Logs" 按钮
      await showLogsButtons.first().click();
      await page.waitForTimeout(2_000);
      
      // 📸 截图：日志内容
      await page.screenshot({ 
        path: 'test-results/diag-02-logs.png',
        fullPage: true 
      });
      
      // 🎯 尝试获取日志内容
      const logContent = await page.locator('.monaco-editor, .log-container, [class*="log"]').first().textContent().catch(() => 'No log content found');
      console.log('Log content:', logContent.substring(0, 500));
    }
    
    // 🎯 尝试点击 "Try Again" 按钮
    const tryAgainButtons = page.locator('button:has-text("Try Again")');
    const tryAgainCount = await tryAgainButtons.count();
    console.log(`Found ${tryAgainCount} "Try Again" buttons`);
    
    if (tryAgainCount > 0) {
      await tryAgainButtons.first().click();
      await page.waitForTimeout(5_000);
      
      // 📸 截图：重试后
      await page.screenshot({ 
        path: 'test-results/diag-03-after-retry.png',
        fullPage: true 
      });
    }
    
    // 🎯 检查页面是否有 WebView iframe
    const frames = page.frames();
    console.log(`Total frames: ${frames.length}`);
    for (let i = 0; i < frames.length; i++) {
      console.log(`Frame ${i}: ${frames[i].url()}`);
    }
    
    // 🎯 检查 iframe 元素
    const iframes = page.locator('iframe');
    const iframeCount = await iframes.count();
    console.log(`Found ${iframeCount} iframe elements`);
    
    for (let i = 0; i < iframeCount; i++) {
      const src = await iframes.nth(i).getAttribute('src');
      const name = await iframes.nth(i).getAttribute('name');
      console.log(`Iframe ${i}: src=${src}, name=${name}`);
    }
    
    // 📝 输出控制台日志
    console.log('\n=== Browser Console Logs ===');
    consoleLogs.forEach(log => {
      console.log(`[${log.type}] ${log.text.substring(0, 200)}`);
    });
    
    // 📝 输出页面错误
    console.log('\n=== Page Errors ===');
    pageErrors.forEach(err => {
      console.log(`[ERROR] ${err.substring(0, 200)}`);
    });
    
    // 📸 最终截图
    await page.screenshot({ 
      path: 'test-results/diag-04-final.png',
      fullPage: true 
    });
    
    // ✅ 测试通过（诊断目的）
    expect(true).toBe(true);
  });
  
  test('Check Agent Studio extension activation', async ({ page }) => {
    // 🌐 打开 VSCode Web
    await page.goto('http://localhost:9222');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3_000);
    
    // 🎯 打开命令面板
    await page.keyboard.press('Control+Shift+P');
    await page.waitForTimeout(1_000);
    
    // ⌨️ 输入 "Developer: Show Running Extensions"
    await page.keyboard.type('Developer: Show Running Extensions');
    await page.waitForTimeout(1_000);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3_000);
    
    // 📸 截图：运行中的扩展
    await page.screenshot({ 
      path: 'test-results/diag-05-extensions.png',
      fullPage: true 
    });
    
    // 🎯 检查是否有 sessions 或 agent studio 相关扩展
    const pageContent = await page.content();
    const hasSessions = pageContent.includes('sessions') || pageContent.includes('agent-studio');
    console.log(`Has sessions/agent-studio in page content: ${hasSessions}`);
    
    expect(true).toBe(true);
  });
});
