import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeDryRunVault } from './integrations';
import {
  importDialogSummary,
  promoteMemoryImport,
  scanMemoryImport,
  type MemoryImportCandidate,
} from './memory-import';

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'starlight-memory-import-'));
  mkdirSync(join(root, '.claude', 'skills', 'demo-skill'), { recursive: true });
  writeFileSync(
    join(root, '.claude', 'skills', 'demo-skill', 'SKILL.md'),
    `---
name: demo-skill
description: A harmless demo skill for import tests.
---

# Demo Skill

Do the demo thing carefully.
`,
    'utf8',
  );

  mkdirSync(join(root, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(root, '.claude', 'hooks', 'session-start.sh'), '#!/bin/sh\necho hi\n', 'utf8');

  mkdirSync(join(root, '.claude', 'plugins', 'demo-plugin'), { recursive: true });
  writeFileSync(
    join(root, '.claude', 'plugins', 'demo-plugin', 'plugin.json'),
    JSON.stringify({ name: 'demo-plugin', version: '1.0.0' }, null, 2),
    'utf8',
  );

  mkdirSync(join(root, '.cursor', 'rules'), { recursive: true });
  writeFileSync(
    join(root, '.cursor', 'rules', 'swarm.mdc'),
    '---\ndescription: Swarm rules\n---\nFail closed always.\n',
    'utf8',
  );

  mkdirSync(join(root, '.cursor', 'memories'), { recursive: true });
  writeFileSync(join(root, '.cursor', 'memories', 'note.md'), 'Prefer human gates for money.\n', 'utf8');

  writeFileSync(join(root, 'AGENTS.md'), '# Agents\nFail closed.\n', 'utf8');
  writeFileSync(join(root, 'CLAUDE.md'), '# Claude\nWeb release gate.\n', 'utf8');

  mkdirSync(join(root, '.claude', 'projects', 'chat-1'), { recursive: true });
  writeFileSync(
    join(root, '.claude', 'projects', 'chat-1', 'transcript.json'),
    JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    'utf8',
  );

  return root;
}

test('scanMemoryImport discovers skills, plugins, rules, and agent contracts', () => {
  const root = fixtureRepo();
  const manifest = scanMemoryImport({
    repositoryRoot: root,
    includeChats: true,
    now: () => new Date('2026-08-28T00:00:00.000Z'),
  });

  assert.equal(manifest.schema_version, 'starlight.memory_import.v1');
  assert.ok(manifest.counts.skills >= 1);
  assert.ok(manifest.counts.plugins >= 1);
  assert.ok(manifest.counts.rules >= 1);
  assert.ok(manifest.counts.hooks >= 1);
  assert.ok(manifest.counts.agent_contracts >= 1);
  assert.ok(manifest.counts.chats >= 1);
  assert.ok(manifest.counts.memory_notes >= 1);

  const skill = manifest.candidates.find((c) => c.artifact_class === 'skill');
  assert.ok(skill);
  assert.equal(skill!.status, 'ready');
  assert.equal(skill!.promotable, true);
  assert.equal(skill!.selected_by_default, true);

  const chat = manifest.candidates.find((c) => c.artifact_class === 'chat-excerpt');
  assert.ok(chat);
  assert.equal(chat!.status, 'refused');
  assert.equal(chat!.promotable, false);
});

test('scanMemoryImport refuses secret-bearing files', () => {
  const root = fixtureRepo();
  writeFileSync(
    join(root, '.claude', 'skills', 'demo-skill', 'SKILL.md'),
    `---
name: leaky
description: has a secret
---

api_key = "sk-abcdefghijklmnopqrstuvwxyz0123456789"
`,
    'utf8',
  );

  const manifest = scanMemoryImport({ repositoryRoot: root });
  const skill = manifest.candidates.find((c) => c.artifact_class === 'skill');
  assert.ok(skill);
  assert.equal(skill!.status, 'needs-redaction');
  assert.equal(skill!.promotable, false);
  assert.ok(skill!.redaction_hits.length > 0);
});

test('promoteMemoryImport requires human approval and refuses chats', async () => {
  const logs: string[] = [];
  const vault = makeDryRunVault((m) => logs.push(m));
  const root = fixtureRepo();
  const manifest = scanMemoryImport({ repositoryRoot: root, includeChats: true });

  const withoutApproval = await promoteMemoryImport(vault, {
    candidates: manifest.candidates.filter((c) => c.artifact_class === 'skill'),
    humanApproved: false,
  });
  assert.equal(withoutApproval.ok, false);
  assert.equal(withoutApproval.promoted.length, 0);
  assert.ok(withoutApproval.refused.length > 0);
  assert.equal(logs.length, 0);

  const chats = manifest.candidates.filter((c) => c.artifact_class === 'chat-excerpt');
  const chatPromote = await promoteMemoryImport(vault, {
    candidates: chats,
    humanApproved: true,
  });
  assert.equal(chatPromote.ok, false);
  assert.equal(chatPromote.promoted.length, 0);
  assert.ok(chatPromote.refused.every((r) => /chat|transcript|promotable|status/i.test(r.reason)));
});

test('promoteMemoryImport appends ready skills when human-approved', async () => {
  const logs: string[] = [];
  const vault = makeDryRunVault((m) => logs.push(m));
  const root = fixtureRepo();
  const manifest = scanMemoryImport({ repositoryRoot: root });
  const ready = manifest.candidates.filter((c) => c.promotable && c.status === 'ready');
  assert.ok(ready.length > 0);

  const result = await promoteMemoryImport(vault, {
    candidates: ready,
    humanApproved: true,
    note: 'operator sync',
  });

  assert.equal(result.ok, true);
  assert.equal(result.promoted.length, ready.length);
  assert.equal(result.refused.length, 0);
  assert.ok(logs.some((l) => l.includes('sis_append_entry')));
});

test('importDialogSummary mirrors Cursor bucket UX', () => {
  const root = fixtureRepo();
  const manifest = scanMemoryImport({ repositoryRoot: root, includeChats: true });
  const dialog = importDialogSummary(manifest);
  assert.equal(dialog.title, 'Import into Starlight Swarm');
  const plugins = dialog.buckets.find((b) => b.id === 'plugins-skills');
  const chats = dialog.buckets.find((b) => b.id === 'chats');
  assert.ok(plugins && plugins.count >= 1 && plugins.promotable);
  assert.ok(chats && chats.promotable === false);
});

test('invalid candidate schema is refused on promote', async () => {
  const vault = makeDryRunVault(() => undefined);
  const bogus = { id: 'x' } as unknown as MemoryImportCandidate;
  const result = await promoteMemoryImport(vault, {
    candidates: [bogus],
    humanApproved: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.promoted.length, 0);
  assert.equal(result.refused.length, 1);
});
