import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const required = [
  '.github/dependabot.yml',
  '.github/workflows/ci.yml',
  '.node-version',
  'AGENTS.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'compose.yaml',
  'docs/api.md',
  'docs/architecture.md',
  'docs/closed-book-contract.md',
  'docs/decisions/0001-postgresql-authority-redis-projection.md',
  'docs/operations.md',
  'docs/requirements.md',
  'docs/research-log.md',
  'docs/threat-model.md',
  'docs/verification.md',
  'package-lock.json',
  'package.json',
  'scripts/crash-worker.mjs',
  'scripts/infra-benchmark.mjs',
  'scripts/infra-smoke.mjs',
  'scripts/repo-check.mjs',
  'sql/schema.sql',
  'src/contracts.js',
  'src/http.js',
  'src/model.js',
  'src/projection.js',
  'src/repository.js',
  'src/runtime.js',
  'src/service.js',
  'test/integration/crash.test.js',
  'test/integration/postgresql-redis.test.js',
  'test/unit/contracts.test.js',
  'test/unit/http.test.js',
  'test/unit/model.test.js',
];

async function filesUnder(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.tmp', 'coverage'].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(path));
    else found.push(path);
  }
  return found;
}

for (const path of required) await readFile(resolve(root, path));

const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
assert.deepEqual(packageJson.dependencies, { pg: '8.23.0', redis: '6.2.1' });
assert.equal(packageJson.engines.node, '>=22');

const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
assert.equal(lock.lockfileVersion, 3);
assert.equal(lock.packages[''].dependencies.pg, '8.23.0');
assert.equal(lock.packages[''].dependencies.redis, '6.2.1');

const workflow = await readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8');
assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/);
assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/);
assert.match(workflow, /node: \[22, 24, 26\]/);
assert.match(workflow, /postgres:17\.11-alpine@sha256:[0-9a-f]{64}/);
assert.match(workflow, /redis:7\.4-alpine@sha256:[0-9a-f]{64}/);

const allFiles = await filesUnder(root);
const unwantedTrailer = new RegExp(['Co', 'Authored', 'By:'].join('-'), 'i');
for (const path of allFiles) {
  const name = relative(root, path);
  if (/\.(png|jpe?g|gif|webp|pdf|zip)$/i.test(name)) {
    throw new Error(`unexpected binary or copied media: ${name}`);
  }
  const text = await readFile(path, 'utf8');
  assert.doesNotMatch(text, /\/Users\//, `${name} contains a local absolute path`);
  assert.doesNotMatch(text, unwantedTrailer, `${name} contains an unwanted trailer`);
  assert.doesNotMatch(text, /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/, `${name} contains key material`);
  assert.doesNotMatch(text, /AKIA[0-9A-Z]{16}/, `${name} contains a credential-shaped value`);
  if (name.startsWith('test/')) {
    assert.doesNotMatch(text, /\b(?:test|it|describe)\.(?:skip|todo)\b/, `${name} contains a skipped test`);
  }
}

const research = await readFile(resolve(root, 'docs/research-log.md'), 'utf8');
assert.match(research, /9d8388721e7231442763ad37398b8d82224aa68f/);
assert.match(research, /e1841806d61b3d17f5d40766ce54a947a4ae4521/);
assert.match(research, /attested=false/);
assert.match(research, /tracefetch_failed/);

const readme = await readFile(resolve(root, 'README.md'), 'utf8');
assert.match(readme, /1c1de55ef4e08ce53f3ee6a72fa54b4caf2b9577/);
assert.match(readme, /32211354123/);
assert.match(readme, /95944540292/);
assert.match(readme, /95944540123/);
assert.match(readme, /95944540153/);

process.stdout.write(`${JSON.stringify({ checkedFiles: allFiles.length, skippedTests: 0, copiedMedia: 0 })}\n`);
