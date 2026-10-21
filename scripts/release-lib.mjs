import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

export const targets = [
  { id: 'mac-arm64', platform: 'mac', arch: 'arm64', runner: 'macos-15', formats: ['dmg', 'zip'] },
  { id: 'mac-x64', platform: 'mac', arch: 'x64', runner: 'macos-15-intel', formats: ['dmg', 'zip'] },
  { id: 'win-x64', platform: 'win', arch: 'x64', runner: 'windows-2022', formats: ['exe'] },
  { id: 'linux-x64', platform: 'linux', arch: 'x64', runner: 'ubuntu-22.04', formats: ['AppImage', 'deb'] },
];

export function selectTargets(selection = 'all') {
  if (selection === 'all') return targets;
  const target = targets.find(t => t.id === selection);
  if (!target) throw new Error(`Unsupported target: ${selection}`);
  return [target];
}

export function currentTarget(arch = process.arch) {
  const platform = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform];
  return selectTargets(`${platform}-${arch}`)[0];
}

export function validateVersion(version) {
  // Keep the release convention intentionally narrow and sortable.
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/.test(version)) {
    throw new Error('Version must be X.Y.Z or X.Y.Z-(alpha|beta|rc).N');
  }
}

export function validateRelease({ version, ref, selection, publish, prerelease }) {
  validateVersion(version);
  selectTargets(selection);
  if (!publish) return;
  if (selection !== 'all') throw new Error('Publishing requires all platforms');
  if (ref !== `v${version}`) throw new Error(`Publishing requires the existing tag v${version}`);
  if (!prerelease && version.includes('-')) throw new Error('A prerelease version cannot be published as stable');
}

export const assetName = (version, target, format) => `Agent-Lens-${version}-${target.id}.${format}`;
export const outputDirectory = (version, target) => path.resolve('release', version, target.id);
export const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
export const readJSON = async file => JSON.parse(await fs.readFile(file, 'utf8'));
export const writeJSON = (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} failed (${signal ?? code})`)));
  });
}

export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const data of createReadStream(file)) hash.update(data);
  return hash.digest('hex');
}

export async function describeAsset(file, target, format) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Missing or empty asset: ${file}`);
  return { name: path.basename(file), target: target.id, platform: target.platform, arch: target.arch, format, size: stat.size, sha256: await sha256(file) };
}

// Recompute hashes and check exact names/targets. Do not trust downloaded metadata alone.
export async function verifyDirectory(directory, selected, { version, commit, requireSigned = false } = {}) {
  validateVersion(version);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Expected a full source commit SHA');
  const assets = [];
  const builds = [];
  const allowed = new Set(['SHA256SUMS', 'release-manifest.json']);
  for (const target of selected) {
    const infoName = `build-info-${target.id}.json`;
    allowed.add(infoName);
    const info = await readJSON(path.join(directory, infoName));
    if (info.version !== version || info.commit !== commit || info.target !== target.id || info.dirty !== false) {
      throw new Error(`Build provenance mismatch: ${target.id}`);
    }
    if (requireSigned && target.platform !== 'linux' && info.signing !== 'verified') {
      throw new Error(`Stable release requires verified signing: ${target.id}`);
    }
    if (!Array.isArray(info.assets) || info.assets.length !== target.formats.length) throw new Error(`Incomplete assets: ${target.id}`);
    for (const format of target.formats) {
      const name = assetName(version, target, format);
      allowed.add(name);
      const actual = await describeAsset(path.join(directory, name), target, format);
      const recorded = info.assets.find(asset => asset.name === name);
      if (!recorded || recorded.sha256 !== actual.sha256 || recorded.size !== actual.size) throw new Error(`Asset integrity mismatch: ${name}`);
      assets.push(actual);
    }
    builds.push(info);
  }
  for (const file of await fs.readdir(directory)) {
    if (!allowed.has(file)) throw new Error(`Unexpected release file: ${file}`);
  }
  return { assets, builds };
}

export async function assembleManifest(directory, selected, options) {
  const { assets, builds } = await verifyDirectory(directory, selected, options);
  const { version, commit, repository, prerelease, publish } = options;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid repository');
  const base = `https://github.com/${repository}/releases`;
  const manifest = {
    schemaVersion: 1, version, commit, channel: publish ? (prerelease ? 'prerelease' : 'stable') : 'build',
    generatedAt: new Date().toISOString(),
    releaseNotesUrl: publish ? `${base}/tag/v${version}` : null,
    builds: builds.map(({ assets: _, ...build }) => build),
    assets: assets.map(asset => ({ ...asset, url: publish ? `${base}/download/v${version}/${asset.name}` : null, mirrors: [] })),
  };
  await writeJSON(path.join(directory, 'release-manifest.json'), manifest);
  const files = [...assets.map(a => a.name), ...selected.map(t => `build-info-${t.id}.json`), 'release-manifest.json'].sort();
  const sums = await Promise.all(files.map(async name => `${await sha256(path.join(directory, name))}  ${name}`));
  await fs.writeFile(path.join(directory, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  return manifest;
}

export async function verifyChecksums(directory) {
  const text = await fs.readFile(path.join(directory, 'SHA256SUMS'), 'utf8');
  const seen = new Set();
  for (const line of text.trim().split('\n')) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
    if (!match || seen.has(match[2]) || match[2] === 'SHA256SUMS') throw new Error('Invalid checksum list');
    seen.add(match[2]);
    if (await sha256(path.join(directory, match[2])) !== match[1]) throw new Error(`Checksum mismatch: ${match[2]}`);
  }
  const files = (await fs.readdir(directory)).filter(name => name !== 'SHA256SUMS');
  if (files.length !== seen.size || files.some(name => !seen.has(name))) throw new Error('Checksum list does not cover every file');
}
