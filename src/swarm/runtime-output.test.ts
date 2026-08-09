import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveGeneratedOutput, resolveGeneratedPackDirectory } from './runtime-output';

test('generated output is confined to runtime/generated and requires explicit overwrite', () => {
  const repo = mkdtempSync(join(tmpdir(), 'starlight-runtime-output-'));
  mkdirSync(join(repo, 'runtime', 'generated'), { recursive: true });

  assert.equal(
    resolveGeneratedOutput(repo, 'runtime/generated/plan.json', false),
    resolve(repo, 'runtime/generated/plan.json'),
  );
  assert.throws(
    () => resolveGeneratedOutput(repo, '../outside.json', false),
    /runtime\/generated/i,
  );
  assert.throws(
    () => resolveGeneratedOutput(repo, resolve(repo, 'runtime/generated/absolute.json'), false),
    /relative/i,
  );

  writeFileSync(join(repo, 'runtime', 'generated', 'plan.json'), '{}', 'utf8');
  assert.throws(
    () => resolveGeneratedOutput(repo, 'runtime/generated/plan.json', false),
    /--force/i,
  );
  assert.equal(
    resolveGeneratedOutput(repo, 'runtime/generated/plan.json', true),
    resolve(repo, 'runtime/generated/plan.json'),
  );
});

test('generated output rejects a symlinked parent', () => {
  const repo = mkdtempSync(join(tmpdir(), 'starlight-runtime-symlink-'));
  const allowed = join(repo, 'runtime', 'generated');
  const external = join(repo, 'external');
  mkdirSync(allowed, { recursive: true });
  mkdirSync(external, { recursive: true });
  symlinkSync(external, join(allowed, 'escape'), 'junction');

  assert.throws(
    () => resolveGeneratedOutput(repo, 'runtime/generated/escape/plan.json', false),
    /symbolic link/i,
  );
});

test('generated team-pack directories are confined and immutable', () => {
  const repo = mkdtempSync(join(tmpdir(), 'starlight-pack-output-'));
  const packRoot = join(repo, 'runtime', 'generated', 'packs');
  mkdirSync(join(packRoot, 'platform-pack'), { recursive: true });

  assert.throws(
    () => resolveGeneratedPackDirectory(repo, '../escape', false),
    /runtime\/generated\/packs/i,
  );
  assert.throws(
    () =>
      resolveGeneratedPackDirectory(
        repo,
        'runtime/generated/packs/platform-pack',
        false,
      ),
    /already exists/i,
  );
  assert.throws(
    () => resolveGeneratedPackDirectory(repo, 'runtime/generated/packs/platform-pack', true),
    /immutable|already exists/i,
  );
});
