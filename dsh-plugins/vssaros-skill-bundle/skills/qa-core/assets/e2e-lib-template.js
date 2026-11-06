/**
 * QA Agent E2E 共享 fixture — 团队共享，git 跟踪。
 *
 * 所有 @playwright/test spec 文件从此模块引用共享登录、导航等操作。
 * 配置从 config/env.shared（团队共享）→ local/.env（个人密钥）加载。
 *
 * 用法（在 .spec.ts 中）：
 *   const { test, loginAsQA } = require('../lib/e2e-fixture');
 *   test('TC-P1-011', async ({ page }) => {
 *     await loginAsQA(page);
 *     await page.goto('/box/1');
 *     // ... 断言 ...
 *   });
 */

const { test: base, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../../..');

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const result = {};
  for (const line of fs.readFileSync(filePath, 'utf-8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key) result[key] = val;
  }
  return result;
}

/** 加载分层配置到 process.env */
function loadEnv() {
  const shared = parseEnvFile(path.join(REPO_ROOT, '.qa-agent/config/env.shared'));
  const local = parseEnvFile(path.join(REPO_ROOT, '.qa-agent/local/.env'));
  Object.assign(process.env, shared, local);
}
loadEnv();

/** 从环境变量读取值（带默认） */
function getTestValue(key, defaultValue) {
  return process.env[key] || defaultValue;
}

/**
 * 登录 fixture：自动处理 Login → Sign In → 填表 → 提交。
 * 使用: test.extend({ authenticatedPage: loginAsQA })
 */
async function loginAsQA(page) {
  const email = process.env.QA_USER_USERNAME;
  const password = process.env.QA_USER_PASSWORD;
  if (!email || !password) throw new Error('QA_USER_USERNAME 或 QA_USER_PASSWORD 未配置');

  const baseUrl = process.env.QA_WEB_BASE_URL || 'http://127.0.0.1:3000';
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  // 点击顶部 Login
  const loginBtn = page.locator('button', { hasText: 'Login' }).first();
  if (await loginBtn.count() > 0) {
    await loginBtn.click();
    await page.waitForSelector('input[type="email"], textbox[name="Email"]', { timeout: 5000 }).catch(() => {});
  }

  // 如果弹出注册窗，切到 Sign In
  const signInBtn = page.locator('button', { hasText: 'Sign In' }).first();
  if (await signInBtn.isVisible().catch(() => false)) {
    await signInBtn.click();
    await page.waitForTimeout(500);
  }

  await page.locator('input[type="email"], textbox[name="Email"]').first().fill(email);
  await page.locator('input[type="password"], textbox[name="Password"]').first().fill(password);
  await page.locator('button', { hasText: 'SIGN IN' }).first().click();
  await page.waitForTimeout(2000);

  const token = await page.evaluate(() => localStorage.getItem('gemblit_access_token'));
  if (!token) throw new Error('登录失败');
}

module.exports = { test: base, expect, loginAsQA, getTestValue, loadEnv, REPO_ROOT };
