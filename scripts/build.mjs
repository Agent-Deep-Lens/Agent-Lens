import { build } from 'esbuild';
await build({ entryPoints: ['packages/local-server/main.ts'], outfile: 'dist/server/main.js', bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node22' });
await build({ entryPoints: ['apps/desktop/main.ts'], outfile: 'dist/desktop/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node22' });
await build({ entryPoints: ['apps/desktop/preload.ts'], outfile: 'dist/desktop/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node22' });
