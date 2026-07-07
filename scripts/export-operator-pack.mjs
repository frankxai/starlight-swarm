import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const estateRoot = path.resolve(repoRoot, '..');
const packId = 'starlight-swarm-operator-pack';
const version = '0.1.0';
const outRoot = path.resolve(estateRoot, '_generated', 'operator-packs', packId);
const packageDirName = `${packId}-v${version}`;
const packageDir = path.join(outRoot, packageDirName);
const templatePath = path.join(repoRoot, 'packs', packId, 'starlight-pack.template.json');
const termsPath = path.join(repoRoot, 'packs', packId, 'LICENSE-TERMS.md');

const redactions = [
  [/C:\\Users\\frank\\starlight\\repos/gi, '<STARLIGHT_REPOS>'],
  [/C:\\Users\\frank/gi, '<USER_HOME>'],
  [/C:\/Users\/frank\/starlight\/repos/gi, '<STARLIGHT_REPOS>'],
  [/C:\/Users\/frank/gi, '<USER_HOME>'],
];

const secretPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /\bghp_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /C:\\Users\\frank/i,
  /C:\/Users\/frank/i,
];

const blockedPathSegments = new Set([
  '.git',
  '.next',
  'node_modules',
  '.agent-harness.json',
  '.env',
  '.env.local',
  'private',
]);

const textExtensions = new Set(['.md', '.json', '.ts', '.tsx', '.js', '.mjs', '.txt']);

async function main() {
  const generatedAt = new Date().toISOString();
  assertSafeOutputPath();
  await rm(outRoot, { recursive: true, force: true });
  await mkdir(packageDir, { recursive: true });

  const sourceCommit = git(['rev-parse', 'HEAD']) || 'unknown';
  const sourceBranch = git(['branch', '--show-current']) || 'unknown';
  const sourceStatus = git(['status', '--short']);
  const sourceDirty = sourceStatus.trim().length > 0;
  const sourceStatusHash = createHash('sha256').update(sourceStatus).digest('hex');

  await copyDirectory(path.join(repoRoot, 'src', 'swarm'), path.join(packageDir, 'runtime', 'src', 'swarm'));
  await copyText(path.join(repoRoot, 'README.md'), path.join(packageDir, 'docs', 'README.md'));
  await copyText(path.join(repoRoot, 'docs', 'SWARM-ARCHITECTURE.md'), path.join(packageDir, 'docs', 'SWARM-ARCHITECTURE.md'));
  await copyText(path.join(repoRoot, 'docs', 'OPERATOR-PACK.md'), path.join(packageDir, 'docs', 'OPERATOR-PACK.md'));
  await copyText(termsPath, path.join(packageDir, 'LICENSE-TERMS.md'));

  await copySkill('swarm-queen-coordination');
  await copySkill('payments-mandate');
  await copySkill('agentic-income');
  await copySkill('affiliate-audit');

  await writeRuntimePackage(sourceCommit);
  await writeAttribution(sourceCommit, sourceBranch, sourceDirty, sourceStatusHash);
  await writeInstallNotes();
  await writeProof(sourceCommit, sourceBranch, sourceDirty, sourceStatusHash);

  await verifyPackageContent(packageDir);
  const files = await listFiles(packageDir);
  const inventory = await buildInventory(files);
  const packageHash = hashInventory(inventory);
  const manifest = await buildManifest(sourceCommit, packageHash);
  manifest.sourceDirty = sourceDirty;
  manifest.sourceStatusHash = sourceStatusHash;
  manifest.releaseStatus = sourceDirty ? 'release-candidate-dirty-source' : 'release-candidate-clean-source';
  manifest.packageHashScope = 'payload-files-excluding-starlight-pack.json';
  manifest.includedAssets = manifest.includedAssets.concat([
    'SOURCE_ATTRIBUTION.md',
    'INSTALL.md',
    'LICENSE-TERMS.md',
    'runtime/package.json',
    'runtime/tsconfig.json',
    'runtime/README.md',
    'starlight-pack.json',
  ]);
  manifest.fileInventory = inventory;

  const manifestPath = path.join(packageDir, 'starlight-pack.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const manifestHash = createHash('sha256').update(await readFile(manifestPath)).digest('hex');
  const archivePath = await writeArchive();

  const summary = {
    packId,
    version,
    packageDir,
    archivePath,
    packageHash,
    packageHashScope: manifest.packageHashScope,
    manifestHash,
    manifestHashAlgorithm: 'sha256-file-v1',
    sourceCommit,
    sourceDirty,
    sourceStatusHash,
    generatedAt,
    payloadFileCount: inventory.length,
    packageFileCount: inventory.length + 1,
  };
  await writeFile(path.join(outRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}

function assertSafeOutputPath() {
  const generatedRoot = path.resolve(estateRoot, '_generated');
  const relative = path.relative(generatedRoot, outRoot);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside generated root: ${outRoot}`);
  }
}

async function copyDirectory(from, to) {
  await cp(from, to, {
    recursive: true,
    filter: (src) => !isBlockedPath(src),
  });
  await sanitizeTextFiles(to);
}

async function copyText(from, to) {
  const raw = await readFile(from, 'utf8');
  await mkdir(path.dirname(to), { recursive: true });
  await writeFile(to, sanitize(raw));
}

async function copySkill(skillName) {
  const from = path.resolve(estateRoot, 'starlight-agent-skills', 'skills', skillName, 'SKILL.md');
  const to = path.join(packageDir, 'skills', skillName, 'SKILL.md');
  await copyText(from, to);
}

async function writeRuntimePackage(sourceCommit) {
  const pkg = {
    name: '@starlight/swarm-operator-runtime',
    version,
    private: false,
    description: 'Packaged Starlight Swarm dry-run runtime and fail-closed escalation model.',
    type: 'module',
    sourceCommit,
    scripts: {
      typecheck: 'tsc --noEmit',
      test: 'tsc --noEmit && node --test --import tsx src/swarm/*.test.ts',
      'swarm:dry-run': 'tsx src/swarm/index.ts',
    },
    dependencies: {
      '@modelcontextprotocol/sdk': 'latest',
      zod: 'latest',
    },
    devDependencies: {
      '@types/node': '^20.12.7',
      tsx: '^4.19.2',
      typescript: '^5.4.5',
    },
  };
  await writeFile(path.join(packageDir, 'runtime', 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  await copyText(path.join(repoRoot, 'tsconfig.json'), path.join(packageDir, 'runtime', 'tsconfig.json'));
  await writeFile(
    path.join(packageDir, 'runtime', 'README.md'),
    [
      '# Starlight Swarm Operator Runtime',
      '',
      'This is the packaged dry-run runtime extracted from `starlight-swarm`.',
      '',
      'Run:',
      '',
      '```bash',
      'npm install',
      'npm test',
      'npm run swarm:dry-run',
      '```',
      '',
      'No live action fires and no money moves from this runtime.',
      '',
    ].join('\n'),
  );
}

async function writeAttribution(sourceCommit, sourceBranch, sourceDirty, sourceStatusHash) {
  const lines = [
    '# Source Attribution',
    '',
    `Pack: ${packId} v${version}`,
    `Source repo: frankxai/starlight-swarm`,
    `Source branch: ${sourceBranch}`,
    `Source commit: ${sourceCommit}`,
    `Source dirty at pack time: ${sourceDirty ? 'yes' : 'no'}`,
    `Source status hash: ${sourceStatusHash}`,
    '',
    'Included source paths:',
    '',
    '- `starlight-swarm/src/swarm/**`',
    '- `starlight-swarm/README.md`',
    '- `starlight-swarm/docs/SWARM-ARCHITECTURE.md`',
    '- `starlight-swarm/docs/OPERATOR-PACK.md`',
    '- `starlight-agent-skills/skills/swarm-queen-coordination/SKILL.md`',
    '- `starlight-agent-skills/skills/payments-mandate/SKILL.md`',
    '- `starlight-agent-skills/skills/agentic-income/SKILL.md`',
    '- `starlight-agent-skills/skills/affiliate-audit/SKILL.md`',
    '',
    'Excluded by design: private memory, credentials, repo-local agent harness metadata, build artifacts, dependency folders, and local machine paths.',
    '',
    sourceDirty
      ? 'Release note: this is a release candidate from a dirty worktree. Promote only after the included file inventory is accepted or the source tree is committed and repackaged.'
      : 'Release note: the source worktree was clean at pack time.',
    '',
  ];
  await writeFile(path.join(packageDir, 'SOURCE_ATTRIBUTION.md'), lines.join('\n'));
}

async function writeInstallNotes() {
  const lines = [
    '# Install',
    '',
    'This package has two install surfaces.',
    '',
    '## Runtime dry-run',
    '',
    '```bash',
    'cd runtime',
    'npm install',
    'npm test',
    'npm run swarm:dry-run',
    '```',
    '',
    '## Agent skills',
    '',
    'Copy the selected `skills/*/SKILL.md` files into the target agent skill directory supported by your harness. Preserve `SOURCE_ATTRIBUTION.md` beside the install notes when redistributing internally.',
    '',
    '## Payment boundary',
    '',
    'The packaged runtime exposes verification interfaces only. Do not connect it to live payment rails until the payment governance package, contracts, and marketplace entitlement resolver have all passed review.',
    '',
  ];
  await writeFile(path.join(packageDir, 'INSTALL.md'), lines.join('\n'));
}

async function writeProof(sourceCommit, sourceBranch, sourceDirty, sourceStatusHash) {
  const lines = [
    '# Health Proof',
    '',
    `Pack generated from branch: ${sourceBranch}`,
    `Pack generated from commit: ${sourceCommit}`,
    `Source dirty at pack time: ${sourceDirty ? 'yes' : 'no'}`,
    `Source status hash: ${sourceStatusHash}`,
    '',
    'Required release checks:',
    '',
    '- `npm test` in `starlight-swarm`',
    '- `npm run build` in `starlight-swarm`',
    '- `npm run swarm:dry-run` in `starlight-swarm`',
    '- `npm run pack:operator` in `starlight-swarm`',
    '',
    'The pack is only a release candidate until these commands are run and recorded by the release operator.',
    sourceDirty
      ? 'Dirty-source release candidates must not be promoted to paid/mainnet distribution until provenance is reviewed.'
      : 'Clean-source release candidates may proceed to the next release gate after review.',
    '',
  ];
  await mkdir(path.join(packageDir, 'proof'), { recursive: true });
  await writeFile(path.join(packageDir, 'proof', 'HEALTH.md'), lines.join('\n'));
}

async function buildManifest(sourceCommit, packageHash) {
  const raw = await readFile(templatePath, 'utf8');
  const manifest = JSON.parse(raw);
  manifest.sourceCommit = sourceCommit;
  manifest.packageHash = packageHash;
  manifest.packageHashAlgorithm = 'sha256-manifest-v1';
  manifest.licenseTermsUri = 'local://LICENSE-TERMS.md';
  manifest.manifestUri = 'local://starlight-pack.json';
  return manifest;
}

async function sanitizeTextFiles(dir) {
  for (const file of await listFiles(dir)) {
    if (textExtensions.has(path.extname(file).toLowerCase())) {
      const raw = await readFile(file, 'utf8');
      const clean = sanitize(raw);
      if (clean !== raw) await writeFile(file, clean);
    }
  }
}

function sanitize(value) {
  return redactions.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function isBlockedPath(filePath) {
  const segments = filePath.split(path.sep);
  return segments.some((segment) => blockedPathSegments.has(segment));
}

async function verifyPackageContent(dir) {
  const files = await listFiles(dir);
  for (const file of files) {
    if (isBlockedPath(file)) {
      throw new Error(`Blocked path entered package: ${path.relative(dir, file)}`);
    }
    const ext = path.extname(file).toLowerCase();
    if (!textExtensions.has(ext)) continue;
    const text = await readFile(file, 'utf8');
    for (const pattern of secretPatterns) {
      if (pattern.test(text)) {
        throw new Error(`Secret/local-path pattern found in ${path.relative(dir, file)}: ${pattern}`);
      }
    }
  }
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files.sort((a, b) => path.relative(dir, a).localeCompare(path.relative(dir, b)));
}

async function buildInventory(files) {
  const inventory = [];
  for (const file of files) {
    const buf = await readFile(file);
    inventory.push({
      path: path.relative(packageDir, file).replaceAll(path.sep, '/'),
      bytes: (await stat(file)).size,
      sha256: createHash('sha256').update(buf).digest('hex'),
    });
  }
  return inventory;
}

function hashInventory(inventory) {
  const h = createHash('sha256');
  for (const item of inventory) {
    h.update(item.path);
    h.update('\0');
    h.update(item.sha256);
    h.update('\0');
    h.update(String(item.bytes));
    h.update('\n');
  }
  return h.digest('hex');
}

async function writeArchive() {
  const archivePath = path.join(outRoot, `${packageDirName}.zip`);
  if (existsSync(archivePath)) await rm(archivePath, { force: true });
  const tar = spawnSync('tar', ['-a', '-cf', archivePath, '-C', outRoot, packageDirName], {
    cwd: outRoot,
    encoding: 'utf8',
  });
  if (tar.status === 0 && existsSync(archivePath)) {
    return archivePath;
  }

  const ps = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      [
        '$ErrorActionPreference = "Stop"',
        `$source = ${JSON.stringify(path.join(outRoot, packageDirName))}`,
        `$destination = ${JSON.stringify(archivePath)}`,
        'if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Force }',
        'Compress-Archive -LiteralPath $source -DestinationPath $destination -Force',
      ].join('; '),
    ],
    { cwd: outRoot, encoding: 'utf8' },
  );

  if (ps.status !== 0 || !existsSync(archivePath)) {
    const note = [
      'Archive creation skipped because both `tar -a` and PowerShell Compress-Archive failed.',
      '',
      'tar stdout:',
      tar.stdout || '<empty>',
      '',
      'tar stderr:',
      tar.stderr || '<empty>',
      '',
      'Compress-Archive stdout:',
      ps.stdout || '<empty>',
      '',
      'Compress-Archive stderr:',
      ps.stderr || '<empty>',
      '',
    ].join('\n');
    await writeFile(path.join(outRoot, 'ARCHIVE-NOT-CREATED.txt'), note);
    return null;
  }
  return archivePath;
}

function git(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) return '';
  return result.stdout.trim();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
