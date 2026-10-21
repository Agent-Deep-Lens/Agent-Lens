import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { build, Platform, Arch } from 'electron-builder';
import YAML from 'yaml';
import { currentTarget, outputDirectory, assetName, describeAsset, git, readJSON, writeJSON, run, validateVersion, configureSigningEnvironment } from './release-lib.mjs';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2).filter(arg => arg !== '--');
const { values } = parseArgs({ args, options: { arch: { type: 'string', default: process.arch }, dir: { type: 'boolean', default: false } } });
const target = currentTarget(values.arch);
const pkg = await readJSON('package.json');
validateVersion(pkg.version);
const output = outputDirectory(pkg.version, target);
const signed = process.env.AGENT_LENS_SIGN === 'true' && target.platform !== 'linux';
configureSigningEnvironment(process.env, signed);
if (signed) {
  const required = target.platform === 'mac'
    ? ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
    : ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD'];
  for (const key of required) if (!process.env[key]) throw new Error(`Signing requires ${key}`);
}
const info = {
  schemaVersion: 1, version: pkg.version, commit: git('rev-parse', 'HEAD'),
  dirty: git('status', '--porcelain').length > 0,
  target: target.id, builtAt: new Date().toISOString(),
  node: process.version, packageManager: process.env.npm_config_user_agent ?? 'direct node invocation',
  electron: require('electron/package.json').version,
  electronBuilder: require('electron-builder/package.json').version,
  runnerImage: process.env.ImageOS ? `${process.env.ImageOS}/${process.env.ImageVersion}` : null,
  signing: signed ? 'requested' : target.platform === 'mac' ? 'ad-hoc' : 'unsigned',
};

// Use Node entry points so the same command works in PowerShell, cmd and POSIX shells.
await run(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit']);
await run(process.execPath, [path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js'), 'build']);
await run(process.execPath, ['scripts/build.mjs']);

// The desktop bundle contains all JS dependencies. Stage a minimal app rather than
// letting electron-builder copy the Web server's production node_modules tree.
const stage = path.resolve('dist/package');
await fs.rm(stage, { recursive: true, force: true });
for (const part of ['web', 'desktop']) await fs.cp(`dist/${part}`, path.join(stage, 'dist', part), { recursive: true });
await writeJSON(path.join(stage, 'package.json'), Object.fromEntries(['name', 'version', 'description', 'main', 'author', 'repository'].map(key => [key, pkg[key]])));
await writeJSON(path.join(stage, 'build-info.json'), info);
await fs.rm(output, { recursive: true, force: true });

const config = YAML.parse(await fs.readFile('electron-builder.yml', 'utf8'));
// Linux targets expand ${arch} to x86_64 (AppImage) or amd64 (deb). Keep our
// public filenames consistent with the target IDs used in release manifests.
config.artifactName = config.artifactName.replaceAll('${arch}', target.arch);
config.directories.output = output;
config.electronVersion = info.electron;
// All runtime dependencies are already bundled. Returning false also prevents
// electron-builder from falling back to collecting the workspace's dependencies.
config.beforeBuild = async () => false;
config.forceCodeSigning = signed;
if (target.platform === 'mac') {
  config.mac = { ...config.mac, identity: signed ? undefined : '-', hardenedRuntime: signed, notarize: signed };
}
const platform = { mac: Platform.MAC, win: Platform.WINDOWS, linux: Platform.LINUX }[target.platform];
await build({ config, targets: platform.createTarget(values.dir ? ['dir'] : undefined, Arch[target.arch]), publish: 'never' });

if (signed && target.platform === 'mac') {
  const app = path.join(output, target.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Agent Lens.app');
  await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  await run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  await run('xcrun', ['stapler', 'validate', app]);
}
if (signed && target.platform === 'win') {
  const files = [path.join(output, 'win-unpacked', 'Agent Lens.exe')];
  if (!values.dir) files.push(path.join(output, assetName(pkg.version, target, 'exe')));
  for (const file of files) {
    await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', '$s = Get-AuthenticodeSignature -LiteralPath $env:AGENT_LENS_VERIFY_FILE; if ($s.Status -ne "Valid") { throw "Invalid Authenticode signature" }'], { env: { ...process.env, AGENT_LENS_VERIFY_FILE: file } });
  }
}
if (signed) info.signing = 'verified';
if (!values.dir) {
  const staging = path.join(output, 'artifacts');
  await fs.mkdir(staging, { recursive: true });
  info.assets = [];
  for (const format of target.formats) {
    const name = assetName(pkg.version, target, format);
    await fs.copyFile(path.join(output, name), path.join(staging, name));
    info.assets.push(await describeAsset(path.join(staging, name), target, format));
  }
  await writeJSON(path.join(staging, `build-info-${target.id}.json`), info);
}
console.log(`Packaged ${target.id}: ${output}`);
