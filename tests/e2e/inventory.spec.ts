import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
test('selecting a mixed project discovers both agents without an agent selection', async ({ page }) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'atm-ui-'));
  try {
    for (const [dir, name] of [['.claude', 'claude-fixture'], ['.agents', 'codex-fixture']]) {
      const p = path.join(project, dir, 'skills', name);
      await fs.mkdir(p, { recursive: true });
      await fs.writeFile(path.join(p, 'SKILL.md'), `---\nname: ${name}\ndescription: Mixed project test\n---\nInspect this project.`);
    }
    await page.goto('/');
    await page.getByRole('button', { name: '打开项目', exact: false }).click();
    await expect(page.getByRole('button', { name: '选择此目录', exact: true })).toBeEnabled();
    await page.getByRole('textbox', { name: '目录路径' }).fill(project);
    await page.getByRole('button', { name: '前往', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '目录路径' })).toHaveValue(await fs.realpath(project));
    await page.getByRole('button', { name: '选择此目录', exact: true }).click();
    await page.getByRole('combobox', { name: '筛选来源' }).selectOption('project');
    await expect(page.locator('.resource-row')).toHaveCount(2);
    await page.getByRole('textbox', { name: '搜索工具' }).fill('codex-fixture');
    await expect(page.locator('.resource-row')).toHaveCount(1);
    await page.locator('.resource-row').click();
    await page.getByRole('button', { name: '指令内容', exact: true }).click();
    await expect(page.locator('.markdown')).toContainText('Inspect this project.');
  } finally { await fs.rm(project, { recursive: true, force: true }); }
});
