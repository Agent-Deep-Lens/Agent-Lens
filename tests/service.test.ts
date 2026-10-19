import { expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { InventoryService } from '../packages/core/service';
it('coalesces active requests and reads changed files only on the next explicit scan', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'atm-demand-'));
  const service = new InventoryService({ home });
  try {
    const skill = path.join(home, '.agents/skills/example/SKILL.md');
    await fs.mkdir(path.dirname(skill), { recursive: true });
    await fs.writeFile(skill, '---\nname: original\n---\nOriginal');
    const first = service.scan();
    expect(service.scan()).toBe(first);
    const snapshot = await first;
    await fs.writeFile(skill, '---\nname: changed\n---\nChanged');
    expect(snapshot.resources[0].name).toBe('original');
    expect((await service.scan()).resources[0].name).toBe('changed');
  } finally { await service.close(); await fs.rm(home, { recursive: true, force: true }); }
});
