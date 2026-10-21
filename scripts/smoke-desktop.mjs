import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { currentTarget, outputDirectory, readJSON } from './release-lib.mjs';

const target = currentTarget();
const pkg = await readJSON('package.json');
const output = outputDirectory(pkg.version, target);
const executable = {
  mac: path.join(output, target.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Agent Lens.app/Contents/MacOS/Agent Lens'),
  win: path.join(output, 'win-unpacked/Agent Lens.exe'),
  linux: path.join(output, 'linux-unpacked/agent-lens'),
}[target.platform];
await fs.access(executable);
// Windows TEMP may use an 8.3 alias (RUNNER~1), while the scanner displays real paths.
const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-lens-smoke-')));
const project = path.join(fixture, 'project');
await fs.mkdir(path.join(project, '.git'), { recursive: true });
const skill = path.join(project, '.agents/skills/packaged-smoke/SKILL.md');
await fs.mkdir(path.dirname(skill), { recursive: true });
await fs.writeFile(skill, '---\nname: packaged-smoke\ndescription: Packaged IPC verification\n---\nSmoke fixture.\n');
await fs.mkdir(path.join(project, '.claude'), { recursive: true });
await fs.writeFile(path.join(project, '.claude/settings.json'), '{broken json');
let app;
const timer = setTimeout(() => {
  app?.process().kill('SIGKILL');
  console.error('Packaged application smoke test timed out');
  process.exit(1);
}, 90_000);
try {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${path.join(fixture, 'user-data')}`], env, timeout: 30_000 });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.getByTestId('tool-search').waitFor();
  const runtimeVersion = await app.evaluate(({ app }) => app.getVersion());
  assert.equal(runtimeVersion, pkg.version);
  // Exercise the bundled dictionaries under file:// and the native dialog IPC.
  await page.getByRole('button', { name: /^(Settings|设置)$/ }).click();
  await page.getByRole('combobox', { name: /^(Language|语言)$/ }).selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  for (const [locale, title] of [['en', 'Choose a project directory'], ['zh-CN', '选择项目目录']]) {
    await page.getByRole('button', { name: /^(Settings|设置)$/ }).click();
    await page.getByRole('combobox', { name: /^(Language|语言)$/ }).selectOption(locale);
    await page.getByRole('button', { name: /^(Close|关闭)$/ }).click();
    // Substitute only the OS dialog; the renderer, preload, IPC and main handler are real.
    await app.evaluate(({ dialog }) => {
      const original = dialog.showOpenDialog;
      dialog.showOpenDialog = async (_window, options) => {
        globalThis.__agentLensDialogTitle = options.title;
        dialog.showOpenDialog = original;
        return { canceled: true, filePaths: [] };
      };
    });
    await page.getByRole('button', { name: /^(Open project|打开项目)/ }).click();
    await expect.poll(() => app.evaluate(() => globalThis.__agentLensDialogTitle)).toBe(title);
  }
  const result = await page.evaluate(async selectedProject => {
    if (!window.inventory) throw new Error('preload bridge is missing');
    const result = await window.inventory.scan(selectedProject);
    if (!result.ok) throw new Error('IPC scan failed');
    return result.value.resources.some(resource => resource.name === 'packaged-smoke' && resource.bindings.some(binding => binding.scope === 'project' && binding.reason.code === 'reason.standardDiscovery'));
  }, project);
  assert.equal(result, true, 'Packaged renderer must scan the fixture through IPC');
  const failures = await page.evaluate(async ({ missing, file }) => ({
    missing: await window.inventory.directories(missing),
    file: await window.inventory.scan(file),
    locale: await window.inventory.chooseDirectory('unsupported-locale'),
    resource: await window.inventory.reveal('unknown-id'),
  }), { missing: path.join(fixture, 'missing'), file: skill });
  for (const [kind, code] of [['missing', 'errors.pathNotFound'], ['file', 'errors.invalidProject'], ['locale', 'errors.invalidRequest'], ['resource', 'errors.resourceNotFound']]) {
    assert.deepEqual(failures[kind], { ok: false, error: { code, params: {} } });
  }
  const selectViaDialog = async selectedPath => {
    await app.evaluate(({ dialog }, selectedPath) => {
      const original = dialog.showOpenDialog;
      dialog.showOpenDialog = async () => {
        dialog.showOpenDialog = original;
        return { canceled: false, filePaths: [selectedPath] };
      };
    }, selectedPath);
    await page.getByRole('button', { name: /^(Open project|打开项目)/ }).click();
  };
  const setLanguage = async locale => {
    await page.getByRole('button', { name: /^(Settings|设置)$/ }).click();
    await page.getByRole('combobox', { name: /^(Language|语言)$/ }).selectOption(locale);
    await page.getByRole('button', { name: /^(Close|关闭)$/ }).click();
  };
  await selectViaDialog(project);
  await page.getByTestId('tool-search').fill('packaged-smoke');
  await page.locator('.resource-row').click();
  await expect(page.locator('.binding-card p')).toContainText('标准发现目录');
  await setLanguage('en');
  await expect(page.locator('.binding-card p')).toContainText('standard discovery directory');
  await page.getByRole('button', { name: /^Scan diagnostics/ }).click();
  const diagnostic = page.locator('.diagnostics article').filter({ hasText: path.join(project, '.claude/settings.json') });
  await expect(diagnostic).toContainText('Could not parse the configuration');
  await setLanguage('zh-CN');
  await expect(diagnostic).toContainText('配置无法解析');
  await setLanguage('en');
  await selectViaDialog(skill);
  await expect(page.getByRole('alert')).toContainText('Choose a valid project directory');
  await setLanguage('zh-CN');
  await expect(page.getByRole('alert')).toContainText('请选择有效的项目目录');
  await app.close();
  app = undefined;
  app = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${path.join(fixture, 'user-data')}`], env, timeout: 30_000 });
  const reopened = await app.firstWindow();
  await reopened.getByTestId('tool-search').waitFor();
  await expect(reopened.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await reopened.getByRole('button', { name: '设置', exact: true }).click();
  await expect(reopened.getByRole('combobox', { name: '语言', exact: true })).toHaveValue('zh-CN');
  await app.close();
  app = undefined;
  console.log(`Desktop smoke passed: ${target.id} v${runtimeVersion}`);
} finally {
  clearTimeout(timer);
  if (app) await app.close().catch(() => app.process().kill('SIGKILL'));
  await fs.rm(fixture, { recursive: true, force: true });
}
