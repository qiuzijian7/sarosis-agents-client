import { test, expect } from '@playwright/test';

test('Diagnose Agent Studio editor error', async ({ page }) => {
  // 🌐 打开 VSCode Web
  await page.goto('http://localhost:9222');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(5_000);

  // 📸 截图：初始状态
  await page.screenshot({ 
    path: 'test-results/error-diag-01-initial.png',
    fullPage: true 
  });

  // 🎯 点击第一个 "Show Logs" 按钮
  const showLogsButton = page.locator('button:has-text("Show Logs")').first();
  
  if (await showLogsButton.count() > 0) {
    console.log('Found Show Logs button, clicking...');
    await showLogsButton.click();
    await page.waitForTimeout(3_000);
    
    // 📸 截图：日志内容
    await page.screenshot({ 
      path: 'test-results/error-diag-02-logs.png',
      fullPage: true 
    });
    
    // 🎯 尝试获取错误详情
    const errorText = await page.locator('.monaco-editor, .notification-toast, [class*="error"], [class*="message"]').first().textContent().catch(() => 'No error text found');
    console.log('Error details:', errorText.substring(0, 1000));
    
    // 🎯 获取页面所有文本内容
    const pageText = await page.evaluate(() => document.body.innerText);
    console.log('\n=== Page Text Content ===');
    console.log(pageText.substring(0, 2000));
  } else {
    console.log('Show Logs button not found');
  }

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
  
  // 🎯 点击 "Try Again" 按钮
  const tryAgainButton = page.locator('button:has-text("Try Again")').first();
  if (await tryAgainButton.count() > 0) {
    console.log('Found Try Again button, clicking...');
    await tryAgainButton.click();
    await page.waitForTimeout(5_000);
    
    // 📸 截图：重试后
    await page.screenshot({ 
      path: 'test-results/error-diag-03-after-retry.png',
      fullPage: true 
    });
  }
  
  // 📝 输出控制台日志
  console.log('\n=== Browser Console Logs ===');
  consoleLogs.forEach(log => {
    console.log(`[${log.type}] ${log.text.substring(0, 300)}`);
  });
  
  // 📝 输出页面错误
  console.log('\n=== Page Errors ===');
  pageErrors.forEach(err => {
    console.log(`[ERROR] ${err.substring(0, 300)}`);
  });
  
  // 📸 最终截图
  await page.screenshot({ 
    path: 'test-results/error-diag-04-final.png',
    fullPage: true 
  });
  
  expect(true).toBe(true);
});
