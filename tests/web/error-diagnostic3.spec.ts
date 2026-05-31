import { test, expect } from '@playwright/test';

test('Diagnose Agent Studio editor error v3', async ({ page, context }) => {
  // 🎯 在页面加载前设置监听器（捕获所有日志）
  const consoleLogs: Array<{ type: string; text: string; time: string }> = [];
  const pageErrors: Array<string> = [];
  const failedRequests: Array<{ status: number; url: string }> = [];
  
  page.on('console', msg => {
    consoleLogs.push({ 
      type: msg.type(), 
      text: msg.text(),
      time: new Date().toISOString()
    });
  });
  
  page.on('pageerror', error => {
    pageErrors.push(error.message);
    console.log(`[PAGE ERROR] ${error.message}`);
  });
  
  page.on('response', response => {
    if (response.status() >= 400) {
      failedRequests.push({ status: response.status(), url: response.url() });
      console.log(`[FAILED REQUEST] ${response.status()} ${response.url()}`);
    }
  });

  // 🌐 打开 VSCode Web
  await page.goto('http://localhost:9222');
  
  // ⏳ 等待页面加载并收集日志
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(10_000); // 给足够的时间让错误发生

  // 📸 截图：初始状态
  await page.screenshot({ 
    path: 'test-results/error-diag3-01-initial.png',
    fullPage: true 
  });

  // 🎯 点击 "Show Logs" 按钮（第一个）
  const showLogsButton = page.getByText('Show Logs', { exact: false }).first();
  if (await showLogsButton.count() > 0) {
    console.log('Clicking Show Logs button...');
    await showLogsButton.click();
    await page.waitForTimeout(5_000); // 等待日志显示
    
    // 📸 截图：点击后
    await page.screenshot({ 
      path: 'test-results/error-diag3-02-after-show-logs.png',
      fullPage: true 
    });
  }

  // 🎯 点击 "Try Again" 按钮（第一个）
  const tryAgainButton = page.getByText('Try Again', { exact: false }).first();
  if (await tryAgainButton.count() > 0) {
    console.log('Clicking Try Again button...');
    await tryAgainButton.click();
    await page.waitForTimeout(10_000); // 等待重试完成
    
    // 📸 截图：重试后
    await page.screenshot({ 
      path: 'test-results/error-diag3-03-after-retry.png',
      fullPage: true 
    });
  }

  // 🎯 检查是否有 notification toast
  const toasts = await page.locator('.notification-toast, .monaco-notification-toast').all();
  console.log(`Found ${toasts.length} notification toasts`);
  for (let i = 0; i < toasts.length; i++) {
    const text = await toasts[i].textContent();
    console.log(`Toast ${i}: ${text}`);
  }

  // 🎯 获取所有可见的错误信息
  const errorElements = await page.locator('[class*="error"], [class*="alert"], [class*="danger"]').all();
  console.log(`Found ${errorElements.length} error elements`);
  for (let i = 0; i < errorElements.length; i++) {
    const text = await errorElements[i].textContent();
    console.log(`Error element ${i}: ${text?.substring(0, 200)}`);
  }

  // 📝 输出所有控制台日志
  console.log('\n========== ALL CONSOLE LOGS ==========');
  consoleLogs.forEach(log => {
    const prefix = `[${log.type.toUpperCase()}]`;
    const text = log.text.length > 500 ? log.text.substring(0, 500) + '...' : log.text;
    console.log(`${prefix} ${text}`);
  });
  
  // 📝 输出所有页面错误
  console.log('\n========== ALL PAGE ERRORS ==========');
  pageErrors.forEach(err => {
    console.log(`[ERROR] ${err}`);
  });
  
  // 📝 输出所有失败请求
  console.log('\n========== ALL FAILED REQUESTS ==========');
  failedRequests.forEach(req => {
    console.log(`[${req.status}] ${req.url}`);
  });

  // 📸 最终截图
  await page.screenshot({ 
    path: 'test-results/error-diag3-04-final.png',
    fullPage: true 
  });
  
  // 🎯 获取页面完整文本内容
  const fullText = await page.evaluate(() => document.body.innerText);
  console.log('\n========== PAGE FULL TEXT ==========');
  console.log(fullText.substring(0, 4000));

  expect(true).toBe(true);
});
