import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { selectTargets, validateRelease, git, readJSON, assembleManifest, verifyDirectory, verifyChecksums } from './release-lib.mjs';

const command = process.argv[2];
const pkg = await readJSON('package.json');
const version = pkg.version;
const selection = process.env.RELEASE_PLATFORMS ?? 'all';
const selected = selectTargets(selection);
const publish = process.env.RELEASE_PUBLISH === 'true';
const prerelease = process.env.RELEASE_PRERELEASE !== 'false';
const ref = process.env.RELEASE_REF ?? 'main';
const commit = git('rev-parse', 'HEAD');
const repository = process.env.GITHUB_REPOSITORY ?? 'Agent-Deep-Lens/Agent-Lens';
const directory = path.resolve(process.env.RELEASE_DIRECTORY ?? 'release/artifacts');
const options = { version, commit, repository, prerelease, publish, requireSigned: publish && !prerelease };

async function api(endpoint, init = {}) {
  if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN is required for release publishing');
  const response = await fetch(`https://api.github.com/repos/${repository}${endpoint}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...init.headers },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${endpoint}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? true : response.json();
}

async function validateSource() {
  validateRelease({ version, ref, selection, publish, prerelease });
  if (publish) {
    if (git('status', '--porcelain')) throw new Error('Publishing requires a clean checkout');
    if (git('rev-parse', `refs/tags/v${version}^{commit}`) !== commit) throw new Error('Tag does not match the checked-out commit');
    // Check the remote again before publishing: the tag may have moved during builds.
    let tag = await api(`/git/ref/tags/v${version}`);
    if (!tag) throw new Error('Release tag must already exist on GitHub');
    let object = tag.object;
    for (let depth = 0; object.type === 'tag' && depth < 5; depth++) {
      const annotated = await api(`/git/tags/${object.sha}`);
      if (!annotated) throw new Error('Cannot resolve annotated tag');
      object = annotated.object;
    }
    if (object.type !== 'commit' || object.sha !== commit) throw new Error('Remote release tag has changed');
    const existing = await api(`/releases/tags/v${version}`);
    if (existing && !existing.draft) throw new Error('A published release is immutable; use a new version');
    if (existing && !existing.body?.includes(`<!-- agent-lens:${commit} -->`)) throw new Error('Existing draft was not created for this source commit');
  }
}

if (command === 'prepare') {
  await validateSource();
  const outputs = { commit, version, matrix: JSON.stringify({ include: selected }) };
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
  }
  console.log(JSON.stringify(outputs, null, 2));
} else if (command === 'assemble') {
  validateRelease({ version, ref, selection, publish, prerelease });
  await assembleManifest(directory, selected, options);
  await verifyChecksums(directory);
  console.log(`Verified ${selected.length} targets in ${directory}`);
} else if (command === 'verify') {
  const manifest = await readJSON(path.join(directory, 'release-manifest.json'));
  const actualTargets = manifest.builds.map(build => selectTargets(build.target)[0]);
  if (new Set(actualTargets.map(t => t.id)).size !== actualTargets.length || !actualTargets.length) throw new Error('Invalid manifest targets');
  const actual = await verifyDirectory(directory, actualTargets, { version: manifest.version, commit: manifest.commit, requireSigned: manifest.channel === 'stable' });
  if (manifest.assets.length !== actual.assets.length || actual.assets.some(asset => !manifest.assets.some(a => a.name === asset.name && a.sha256 === asset.sha256 && a.size === asset.size))) {
    throw new Error('Manifest asset mismatch');
  }
  await verifyChecksums(directory);
  console.log(`Release verified: ${manifest.version}, ${actualTargets.length} targets`);
} else if (command === 'publish') {
  if (!publish) throw new Error('Publishing is disabled; explicitly set RELEASE_PUBLISH=true');
  await validateSource();
  await verifyDirectory(directory, selected, options);
  await verifyChecksums(directory);
  const manifest = await readJSON(path.join(directory, 'release-manifest.json'));
  if (manifest.version !== version || manifest.commit !== commit || manifest.channel !== (prerelease ? 'prerelease' : 'stable')) throw new Error('Release manifest does not match publishing inputs');
  const tag = `v${version}`;
  let release = await api(`/releases/tags/${tag}`);
  if (!release) {
    const notes = await api('/releases/generate-notes', { method: 'POST', body: JSON.stringify({ tag_name: tag, target_commitish: commit }) });
    const unsigned = manifest.builds.filter(b => b.signing !== 'verified' && !b.target.startsWith('linux')).map(b => b.target);
    release = await api('/releases', { method: 'POST', body: JSON.stringify({
      tag_name: tag, target_commitish: commit, name: `Agent Lens ${tag}`, draft: true, prerelease,
      body: `${notes?.body ?? ''}\n\nSource: ${commit}\n${unsigned.length ? `\nPreview build: ${unsigned.join(', ')} do not have verified distribution signatures.\n` : ''}\n<!-- agent-lens:${commit} -->`,
    }) });
  }
  // A failed run may leave a partial draft. Replace its assets, never a public release.
  const oldAssets = await api(`/releases/${release.id}/assets?per_page=100`);
  for (const asset of oldAssets) await api(`/releases/assets/${asset.id}`, { method: 'DELETE' });
  const files = (await fs.readdir(directory)).sort();
  for (const name of files) {
    const file = path.join(directory, name);
    const size = (await fs.stat(file)).size;
    const url = `${release.upload_url.split('{')[0]}?name=${encodeURIComponent(name)}`;
    const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) }, body: createReadStream(file), duplex: 'half' });
    if (!response.ok) throw new Error(`Upload failed: ${name} (${response.status}); draft retained`);
  }
  const uploaded = await api(`/releases/${release.id}/assets?per_page=100`);
  if (uploaded.length !== files.length) throw new Error('Uploaded asset count mismatch; draft retained');
  // Verify the bytes stored by GitHub, including the manifest and checksum list.
  for (const name of files) {
    const asset = uploaded.find(a => a.name === name);
    const file = path.join(directory, name);
    if (!asset || asset.state !== 'uploaded' || asset.size !== (await fs.stat(file)).size) throw new Error(`Incomplete upload: ${name}`);
    const response = await fetch(`https://api.github.com/repos/${repository}/releases/assets/${asset.id}`, { headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/octet-stream', 'X-GitHub-Api-Version': '2022-11-28' } });
    if (!response.ok) throw new Error(`Cannot verify uploaded asset: ${name}`);
    const remoteHash = createHash('sha256');
    for await (const chunk of response.body) remoteHash.update(chunk);
    const localHash = createHash('sha256');
    for await (const chunk of createReadStream(file)) localHash.update(chunk);
    if (remoteHash.digest('hex') !== localHash.digest('hex')) throw new Error(`Uploaded checksum mismatch: ${name}`);
  }
  await validateSource();
  await api(`/releases/${release.id}`, { method: 'PATCH', body: JSON.stringify({ draft: false, prerelease, make_latest: prerelease ? 'false' : 'legacy' }) });
  console.log(`Published https://github.com/${repository}/releases/tag/${tag}`);
} else {
  throw new Error('Usage: node scripts/release.mjs prepare|assemble|verify|publish');
}
