import { test, expect } from '@playwright/test';

test('Diagnose Agent Studio editor error v2', async ({ page }) => {
  // 🌐 打开 VSCode Web
  await page.goto('http://localhost:9222');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(5_000);

  // 📸 截图：初始状态
  await page.screenshot({ 
    path: 'test-results/error-diag2-01-initial.png',
    fullPage: true 
  });

  // 🎯 获取页面 HTML 内容，查找按钮
  const buttons = await page.locator('button, [role="button"]').all();
  console.log(`Found ${buttons.length} buttons on page`);
  
  for (let i = 0; i < Math.min(buttons.length, 20); i++) {
    const text = await buttons[i].textContent();
    const ariaLabel = await buttons[i].getAttribute('aria-label');
    console.log(`Button ${i}: text="${text?.trim()}", aria-label="${ariaLabel}"`);
  }

  // 🎯 尝试多种方式点击 "Show Logs"
  // 方法1：通过文本内容
  const showLogsByText = page.getByText('Show Logs', { exact: false });
  if (await showLogsByText.count() > 0) {
    console.log('Found Show Logs by text, clicking...');
    await showLogsByText.first().click();
    await page.waitForTimeout(3_000);
  } else {
    // 方法2：通过 aria-label
    const showLogsByAria = page.locator('[aria-label*="log"], [aria-label*="Log"]');
    if (await showLogsByAria.count() > 0) {
      console.log('Found Show Logs by aria-label, clicking...');
      await showLogsByAria.first().click();
      await page.waitForTimeout(3_000);
    } else {
      console.log('Show Logs button not found by any method');
    }
  }
  
  // 📸 截图：点击后
  await page.screenshot({ 
    path: 'test-results/error-diag2-02-after-click.png',
    fullPage: true 
  });

  // 🎯 获取页面可见文本
  const visibleText = await page.evaluate(() => {
    return document.body.innerText;
  });
  console.log('\n=== Visible Page Text ===');
  console.log(visibleText.substring(0, 3000));

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
  
  // 🎯 获取网络请求错误
  const failedRequests: Array<string> = [];
  page.on('response', response => {
    if (response.status() >= 400) {
      failedRequests.push(`${response.status()} ${response.url()}`);
    }
  });
  
  // 等待一段时间收集日志
  await page.waitForTimeout(3_000);
  
  // 📝 输出控制台日志
  console.log('\n=== Browser Console Logs ===');
  consoleLogs.forEach(log => {
    console.log(`[${log.type}] ${log.text.substring(0, 500)}`);
  });
  
  // 📝 输出页面错误
  console.log('\n=== Page Errors ===');
  pageErrors.forEach(err => {
    console.log(`[ERROR] ${err.substring(0, 500)}`);
  });
  
  // 📝 输出失败请求
  console.log('\n=== Failed Network Requests ===');
  failedRequests.forEach(req => {
    console.log(`[FAILED] ${req}`);
  });
  
  // 📸 最终截图
  await page.screenshot({ 
    path: 'test-results/error-diag2-03-final.png',
    fullPage: true 
  });
  
  expect(true).toBe(true);
});
