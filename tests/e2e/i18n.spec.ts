import { test, expect } from '@playwright/test';
import type { Snapshot } from '../../packages/contracts';
import { message } from '../../packages/contracts/messages';

test.use({ locale: 'en-US' });
const snapshot: Snapshot = {
  id: 'language-fixture', project: null, scannedAt: '2026-10-21T10:30:00.000Z', durationMs: 1200,
  agents: [{ id: 'codex', name: 'Codex', configFound: true, executableFound: true }], diagnostics: [
    { path: '/repo/config.toml', message: message('scan.configUnreadable') },
    { path: '/repo/nested', message: message('scan.nestedLimit', { directories: 3000, depth: 8 }) },
  ],
  resources: [
    { id: 'skill', kind: 'skill', name: 'fixture-skill', description: '原始用户描述', path: '/repo/.agents/skills/fixture/SKILL.md', content: '# 原始正文', metadata: {}, bindings: [{ id: 'project', agent: 'codex', scope: 'project', path: '/repo/.agents/skills/fixture/SKILL.md', status: 'available', reason: message('reason.standardDiscovery') }] },
    { id: 'global', kind: 'skill', name: 'global-skill', description: '', path: '/home/.agents/skills/global/SKILL.md', content: '', metadata: {}, bindings: [{ id: 'global', agent: 'codex', scope: 'user', path: '/home/.agents/skills/global/SKILL.md', status: 'conditional', reason: '' }] },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/scan', route => route.fulfill({ json: snapshot }));
  await page.route('**/api/directories*', route => route.fulfill({ json: { path: '/repo', parent: '/', entries: [] } }));
});

test('retranslates existing binding reasons and diagnostics without another scan', async ({ page }) => {
  let scans = 0;
  await page.route('**/api/scan', route => { scans++; return route.fulfill({ json: snapshot }); });
  await page.goto('/');
  await page.locator('.resource-row').click();
  await expect(page.locator('.binding-card p')).toContainText('standard discovery directory');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('.binding-card p')).toContainText('标准发现目录');
  await expect(page.locator('.detail-description')).toHaveText('原始用户描述');
  await page.getByRole('button', { name: /^扫描诊断/ }).click();
  await expect(page.locator('.diagnostics article').first()).toContainText('配置无法解析');
  await expect(page.locator('.diagnostics article').nth(1)).toContainText('3000 个目录或 8 层');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('combobox', { name: '语言', exact: true }).selectOption('en');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.diagnostics article').first()).toContainText('Could not parse the configuration');
  await expect(page.locator('.diagnostics article').nth(1)).toContainText('3000 directories or 8 levels');
  expect(scans).toBe(1);
});

test('retranslates an existing backend error without retrying the request', async ({ page }) => {
  let scans = 0;
  await page.route('**/api/scan', route => { scans++; return route.fulfill({ status: 500, json: { error: message('errors.permissionDenied') } }); });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Could not access the selected path');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('无法访问所选路径');
  expect(scans).toBe(1);
});

test('an open directory error follows system language changes without another request', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/directories*', route => { requests++; return route.fulfill({ status: 500, json: { error: message('errors.pathNotFound') } }); });
  await page.goto('/');
  await page.getByRole('button', { name: /^Open project/ }).click();
  await expect(page.getByRole('alert')).toContainText('The path does not exist');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'languages', { configurable: true, value: ['zh-CN'] });
    window.dispatchEvent(new Event('languagechange'));
  });
  await expect(page.getByRole('alert')).toContainText('路径不存在');
  await expect(page.getByRole('button', { name: '选择此目录', exact: true })).toBeDisabled();
  expect(requests).toBe(1);
});

test('switches the whole UI offline, preserves selection and restores language on reload', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('.skill-group-toggle').first()).toContainText('Project definitions · repo');
  await page.getByTestId('tool-search').fill('fixture');
  await page.locator('.resource-row').click();
  await expect(page.locator('.list-meta')).toContainText('1 item · 1 group');
  await expect(page.locator('.detail-description')).toHaveText('原始用户描述');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Language', exact: true })).toHaveValue('system');
  await context.setOffline(true);
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '搜索工具' })).toHaveValue('fixture');
  await expect(page.locator('.skill-group-toggle').first()).toContainText('项目内定义 · repo');
  await expect(page.locator('.detail-pane .status')).toHaveText('可发现');
  await page.getByRole('button', { name: '指令内容', exact: true }).click();
  await expect(page.locator('.markdown')).toContainText('原始正文');
  await context.setOffline(false);
  await page.reload();
  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '语言', exact: true })).toHaveValue('zh-CN');
  await page.getByRole('combobox', { name: '语言', exact: true }).selectOption('en');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('.list-meta')).toContainText('2 items · 2 groups');
  await expect(page.locator('.statusbar')).toContainText('2 resources');
  await expect(page.locator('.statusbar')).toContainText('1.2 s');
});

test('follows system language changes only when selected', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'languages', { configurable: true, value: ['zh-TW'] });
    window.dispatchEvent(new Event('languagechange'));
  });
  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('combobox', { name: '语言', exact: true }).selectOption('en');
  await page.evaluate(() => window.dispatchEvent(new Event('languagechange')));
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('system');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.getByRole('combobox', { name: '语言', exact: true })).toHaveValue('system');
  await page.reload();
  // The test browser reports en-US again on navigation; persist the mode, not its resolved language.
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Language', exact: true })).toHaveValue('system');
});

test('English directory picker and details fit the minimum desktop window', async ({ page }) => {
  await page.setViewportSize({ width: 880, height: 600 });
  await page.goto('/');
  await page.locator('.resource-row').click();
  await expect(page.getByRole('button', { name: 'Copy path', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open project', exact: false }).click();
  await expect(page.getByRole('heading', { name: 'Choose a project directory' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select directory', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  for (const selector of ['.workspace', '.page-heading', '.filterbar', '.statusbar', 'dialog', '.settings-body']) {
    expect(await page.locator(selector).evaluate(element => element.scrollWidth <= element.clientWidth + 1), selector).toBe(true);
  }
});
