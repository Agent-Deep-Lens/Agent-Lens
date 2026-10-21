import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { _electron as electron } from '@playwright/test';
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
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-lens-smoke-'));
const project = path.join(fixture, 'project');
await fs.mkdir(path.join(project, '.git'), { recursive: true });
const skill = path.join(project, '.agents/skills/packaged-smoke/SKILL.md');
await fs.mkdir(path.dirname(skill), { recursive: true });
await fs.writeFile(skill, '---\nname: packaged-smoke\ndescription: Packaged IPC verification\n---\nSmoke fixture.\n');
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
  await page.getByRole('textbox', { name: '搜索工具' }).waitFor();
  const runtimeVersion = await app.evaluate(({ app }) => app.getVersion());
  assert.equal(runtimeVersion, pkg.version);
  const result = await page.evaluate(async selectedProject => {
    if (!window.inventory) throw new Error('preload bridge is missing');
    const snapshot = await window.inventory.scan(selectedProject);
    return snapshot.resources.some(resource => resource.name === 'packaged-smoke' && resource.bindings.some(binding => binding.scope === 'project'));
  }, project);
  assert.equal(result, true, 'Packaged renderer must scan the fixture through IPC');
  await app.close();
  app = undefined;
  console.log(`Desktop smoke passed: ${target.id} v${runtimeVersion}`);
} finally {
  clearTimeout(timer);
  if (app) await app.close().catch(() => app.process().kill('SIGKILL'));
  await fs.rm(fixture, { recursive: true, force: true });
}
