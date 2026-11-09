/**
 * 登录态 seed 模板。
 *
 * init-project 会把它落到 .qa-agent/fixtures/seed.spec.ts。正式使用时复制到
 * tests/<scope>/seed.spec.ts，并把 storageState 路径填进 playwright.config。
 *
 * 目的：让回归套件共用一份登录态，避免每轮重跑登录流程、也避免模型参与准备阶段。
 */
import { test as setup, expect } from '@playwright/test';

const AUTH_FILE = '.qa-agent/local/storageState.json';

setup('prepare login state', async ({ page, baseURL }) => {
  if (!baseURL) {
    throw new Error('playwright.config 必须提供 use.baseURL');
  }

  const username = process.env.QA_USER_USERNAME;
  const password = process.env.QA_USER_PASSWORD;
  setup.skip(!username || !password, 'QA_USER_USERNAME / QA_USER_PASSWORD 未配置');

  await page.goto(baseURL);
  await page.getByRole('link', { name: /log in|登录/i }).click();
  await page.getByLabel(/user(name)?|用户名/i).fill(String(username));
  await page.getByLabel(/password|密码/i).fill(String(password));
  await page.getByRole('button', { name: /sign in|登录/i }).click();

  await expect(page).toHaveURL(/\/(dashboard|home)?/);
  await page.context().storageState({ path: AUTH_FILE });
});
