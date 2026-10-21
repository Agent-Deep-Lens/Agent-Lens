import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { targets, selectTargets, validateRelease, validateVersion, assetName, describeAsset, writeJSON, assembleManifest, verifyDirectory, verifyChecksums, configureSigningEnvironment } from '../scripts/release-lib.mjs';

const commit = 'a'.repeat(40);
const version = '0.1.0';
const release = { version, ref: 'v0.1.0', selection: 'all', publish: true, prerelease: true };

test('build-only removes empty CI and inherited signing credentials', () => {
  const env = { CSC_LINK: '', CSC_KEY_PASSWORD: '', WIN_CSC_LINK: 'local.pfx', APPLE_ID: 'local-account', CSC_NAME: 'local identity', PATH: '/tools' };
  configureSigningEnvironment(env, false);
  assert.deepEqual(env, { PATH: '/tools', CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
});

test('signing keeps supplied credentials and removes empty unused inputs', () => {
  const env = { CSC_LINK: 'certificate.p12', CSC_KEY_PASSWORD: 'password', APPLE_TEAM_ID: 'team', WIN_CSC_LINK: '', WIN_CSC_KEY_PASSWORD: '' };
  configureSigningEnvironment(env, true);
  assert.deepEqual(env, { CSC_LINK: 'certificate.p12', CSC_KEY_PASSWORD: 'password', APPLE_TEAM_ID: 'team' });
});

async function fixture(t, selected = targets) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-lens-release-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const target of selected) {
    const assets = [];
    for (const format of target.formats) {
      const file = path.join(directory, assetName(version, target, format));
      await fs.writeFile(file, `test installer ${target.id} ${format}`);
      assets.push(await describeAsset(file, target, format));
    }
    await writeJSON(path.join(directory, `build-info-${target.id}.json`), {
      version, commit, target: target.id, dirty: false, signing: 'unsigned', assets,
    });
  }
  return directory;
}

test('only manual dispatch is enabled; publishing is opt-in and isolated', async () => {
  const workflow = YAML.parse(await fs.readFile('.github/workflows/desktop.yml', 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false);
  assert.equal(workflow.on.workflow_dispatch.inputs.prerelease.default, true);
  assert.equal(workflow.jobs.publish.if, 'inputs.publish');
  assert.deepEqual(workflow.jobs.publish.needs, ['prepare', 'collect']);
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(workflow.jobs.publish.permissions.contents, 'write');
});

test('build-only permits a branch and one target', () => {
  validateRelease({ ...release, ref: 'main', selection: 'mac-arm64', publish: false });
  assert.equal(selectTargets('mac-arm64').length, 1);
  assert.equal(selectTargets('all').length, 4);
  assert.throws(() => selectTargets('../../tmp'));
});

test('publication requires an exact version tag and all targets', () => {
  validateRelease(release);
  assert.throws(() => validateRelease({ ...release, ref: 'main' }), /existing tag/);
  assert.throws(() => validateRelease({ ...release, ref: 'v0.2.0' }), /existing tag/);
  assert.throws(() => validateRelease({ ...release, selection: 'win-x64' }), /all platforms/);
  assert.throws(() => validateRelease({ ...release, version: '0.2.0-beta.1', ref: 'v0.2.0-beta.1', prerelease: false }), /cannot be published as stable/);
});

test('version and asset naming cannot introduce paths or shell syntax', () => {
  for (const bad of ['01.2.3', '0.1', '../0.1.0', '1.2.3\nBAD=1', '1.2.3;echo', '1.2.3-beta.01']) assert.throws(() => validateVersion(bad));
  validateVersion('1.2.3-rc.2');
  assert.equal(assetName('0.1.0', targets[0], 'dmg'), 'Agent-Lens-0.1.0-mac-arm64.dmg');
});

test('complete builds assemble downloadable manifests and comprehensive checksums', async t => {
  const directory = await fixture(t);
  const manifest = await assembleManifest(directory, targets, { version, commit, repository: 'owner/repo', publish: true, prerelease: true });
  assert.equal(manifest.assets.length, 7);
  assert.equal(manifest.channel, 'prerelease');
  assert.match(manifest.assets[0].url, /releases\/download\/v0.1.0\//);
  await verifyChecksums(directory);
  const cli = spawnSync(process.execPath, ['scripts/release.mjs', 'verify'], { env: { ...process.env, RELEASE_DIRECTORY: directory }, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
});

test('build-only manifests do not advertise a nonexistent release', async t => {
  const selected = selectTargets('win-x64');
  const directory = await fixture(t, selected);
  const manifest = await assembleManifest(directory, selected, { version, commit, repository: 'owner/repo', publish: false });
  assert.equal(manifest.channel, 'build');
  assert.equal(manifest.releaseNotesUrl, null);
  assert.equal(manifest.assets[0].url, null);
});

test('missing platform or installer blocks collection', async t => {
  const directory = await fixture(t);
  await fs.unlink(path.join(directory, assetName(version, targets[0], 'zip')));
  await assert.rejects(verifyDirectory(directory, targets, { version, commit }));
});

test('modified installer is rejected even when its size is unchanged', async t => {
  const directory = await fixture(t);
  const file = path.join(directory, assetName(version, targets[0], 'dmg'));
  const bytes = await fs.readFile(file);
  bytes[0] ^= 1;
  await fs.writeFile(file, bytes);
  await assert.rejects(verifyDirectory(directory, targets, { version, commit }), /integrity mismatch/);
});

test('mixed source commits and dirty builds cannot be released', async t => {
  const directory = await fixture(t);
  const file = path.join(directory, 'build-info-win-x64.json');
  const info = JSON.parse(await fs.readFile(file, 'utf8'));
  await writeJSON(file, { ...info, commit: 'b'.repeat(40) });
  await assert.rejects(verifyDirectory(directory, targets, { version, commit }), /provenance mismatch/);
  await writeJSON(file, { ...info, dirty: true });
  await assert.rejects(verifyDirectory(directory, targets, { version, commit }), /provenance mismatch/);
});

test('stable release blocks unsigned macOS / Windows; previews remain possible', async t => {
  const directory = await fixture(t);
  await assert.rejects(verifyDirectory(directory, targets, { version, commit, requireSigned: true }), /verified signing/);
  for (const target of targets.filter(t => t.platform !== 'linux')) {
    const file = path.join(directory, `build-info-${target.id}.json`);
    const info = JSON.parse(await fs.readFile(file, 'utf8'));
    await writeJSON(file, { ...info, signing: 'verified' });
  }
  await verifyDirectory(directory, targets, { version, commit, requireSigned: true });
});

test('unexpected files and symlink assets are rejected', async t => {
  const directory = await fixture(t);
  await fs.writeFile(path.join(directory, 'accidental-secret.txt'), 'not for publication');
  await assert.rejects(verifyDirectory(directory, targets, { version, commit }), /Unexpected release file/);
  await fs.unlink(path.join(directory, 'accidental-secret.txt'));
  if (process.platform !== 'win32') {
    const file = path.join(directory, assetName(version, targets[0], 'dmg'));
    await fs.unlink(file);
    await fs.symlink('build-info-mac-arm64.json', file);
    await assert.rejects(verifyDirectory(directory, targets, { version, commit }), /Missing or empty asset/);
  }
});

test('manifest tampering and incomplete checksum lists fail verification', async t => {
  const directory = await fixture(t);
  await assembleManifest(directory, targets, { version, commit, repository: 'owner/repo', publish: false });
  await fs.appendFile(path.join(directory, 'release-manifest.json'), ' ');
  await assert.rejects(verifyChecksums(directory), /Checksum mismatch/);
  await assembleManifest(directory, targets, { version, commit, repository: 'owner/repo', publish: false });
  const file = path.join(directory, 'SHA256SUMS');
  const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
  await fs.writeFile(file, `${lines.slice(1).join('\n')}\n`);
  await assert.rejects(verifyChecksums(directory), /cover every file/);
});

test('publish CLI refuses to perform network requests unless explicitly enabled', () => {
  const cli = spawnSync(process.execPath, ['scripts/release.mjs', 'publish'], { env: { ...process.env, RELEASE_PUBLISH: 'false' }, encoding: 'utf8' });
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /Publishing is disabled/);
});

// Run the real publishing CLI against an in-process GitHub substitute. No network
// or credentials are used; this exercises the Draft -> verified -> public ordering.
async function mockGitHub() {
  const { writeFileSync } = await import('node:fs');
  const events = [];
  const scenario = process.env.MOCK_SCENARIO;
  let release = scenario === 'published' ? { id: 1, draft: false } : null;
  const assets = [];
  if (scenario === 'retry-draft') {
    release = { id: 1, draft: true, body: `<!-- agent-lens:${process.env.MOCK_COMMIT} -->`, upload_url: 'https://uploads.github.com/assets{?name}' };
    assets.push({ id: 99, name: 'partial-upload.dmg', size: 7, state: 'uploaded', bytes: Buffer.from('partial') });
  }
  process.on('exit', () => writeFileSync(process.env.MOCK_LOG, JSON.stringify(events)));
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    events.push(`${method} ${url.pathname}`);
    if (url.hostname === 'uploads.github.com') {
      if (scenario === 'upload-failure') return json({}, 500);
      const chunks = [];
      for await (const chunk of init.body) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const asset = { id: assets.length + 1, name: url.searchParams.get('name'), size: bytes.length, state: 'uploaded', bytes };
      assets.push(asset);
      return json({ id: asset.id });
    }
    const route = url.pathname.replace('/repos/owner/repo', '');
    if (route.startsWith('/git/ref/tags/')) return json({ object: { type: 'commit', sha: scenario === 'moved-tag' ? 'b'.repeat(40) : process.env.MOCK_COMMIT } });
    if (route.startsWith('/releases/tags/')) return release ? json(release) : json({}, 404);
    if (route === '/releases/generate-notes') return json({ body: 'Test release notes' });
    if (route === '/releases' && method === 'POST') {
      release = { ...JSON.parse(init.body), id: 1, upload_url: 'https://uploads.github.com/assets{?name}' };
      return json(release, 201);
    }
    if (route === '/releases/1/assets') return json(assets.map(({ bytes, ...asset }) => asset));
    if (route.startsWith('/releases/assets/')) {
      if (method === 'DELETE') {
        assets.splice(assets.findIndex(a => a.id === Number(route.split('/').at(-1))), 1);
        return new Response(null, { status: 204 });
      }
      const asset = assets.find(a => a.id === Number(route.split('/').at(-1)));
      return new Response(scenario === 'remote-corruption' ? 'corrupted' : asset.bytes);
    }
    if (route === '/releases/1' && method === 'PATCH') return json({ ...release, ...JSON.parse(init.body) });
    throw new Error(`Unexpected request: ${method} ${input}`);
  };
}

for (const scenario of ['success', 'retry-draft', 'published', 'moved-tag', 'upload-failure', 'remote-corruption']) {
  test(`publishing transaction: ${scenario}`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-lens-publish-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo);
    const git = (...args) => {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git('init');
    await writeJSON(path.join(repo, 'package.json'), { version });
    await fs.writeFile(path.join(repo, '.gitignore'), 'release/\n');
    git('add', '.');
    git('-c', 'user.name=Release Test', '-c', 'user.email=release-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'test fixture');
    git('tag', `v${version}`);
    const source = git('rev-parse', 'HEAD');
    const directory = path.join(repo, 'release/artifacts');
    await fs.mkdir(path.dirname(directory), { recursive: true });
    await fs.cp(await fixture(t), directory, { recursive: true });
    for (const target of targets) {
      const file = path.join(directory, `build-info-${target.id}.json`);
      const info = JSON.parse(await fs.readFile(file, 'utf8'));
      await writeJSON(file, { ...info, commit: source });
    }
    await assembleManifest(directory, targets, { version, commit: source, repository: 'owner/repo', publish: true, prerelease: true });
    const mock = path.join(root, 'mock.mjs');
    const log = path.join(root, 'requests.json');
    await fs.writeFile(mock, `await (${mockGitHub.toString()})();\n`);
    const cli = spawnSync(process.execPath, ['--import', pathToFileURL(mock).href, fileURLToPath(new URL('../scripts/release.mjs', import.meta.url)), 'publish'], {
      cwd: repo, encoding: 'utf8',
      env: { ...process.env, RELEASE_DIRECTORY: directory, RELEASE_REF: `v${version}`, RELEASE_PLATFORMS: 'all', RELEASE_PUBLISH: 'true', RELEASE_PRERELEASE: 'true', GITHUB_REPOSITORY: 'owner/repo', GH_TOKEN: 'test-only', MOCK_SCENARIO: scenario, MOCK_LOG: log, MOCK_COMMIT: source },
    });
    const events = JSON.parse(await fs.readFile(log, 'utf8'));
    if (scenario === 'success' || scenario === 'retry-draft') {
      assert.equal(cli.status, 0, cli.stderr);
      assert.equal(events.at(-1), 'PATCH /repos/owner/repo/releases/1');
      assert.equal(events.filter(e => e.startsWith('GET /repos/owner/repo/releases/assets/')).length, 13);
      if (scenario === 'retry-draft') assert.ok(events.includes('DELETE /repos/owner/repo/releases/assets/99'));
    } else {
      assert.notEqual(cli.status, 0);
      assert.equal(events.some(e => e.startsWith('PATCH ')), false, 'Failure must never publish a draft');
      if (['published', 'moved-tag'].includes(scenario)) assert.equal(events.some(e => e.startsWith('POST ')), false);
    }
  });
}
