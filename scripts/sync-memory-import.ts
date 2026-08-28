/**
 * sync-memory-import.ts — CLI for Cursor-parity memory import into swarm apps.
 *
 *   npm run swarm:sync              # inventory + scan (no promote)
 *   npm run swarm:import -- --json  # print import manifest
 *   npm run swarm:import -- --promote --approve  # human-gated dry-run promote
 */

import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

import { makeDryRunVault } from '../src/swarm/integrations';
import {
  importDialogSummary,
  promoteMemoryImport,
  scanMemoryImport,
} from '../src/swarm/memory-import';
import { assessSwarmSync } from '../src/swarm/swarm-sync';

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

async function main(): Promise<void> {
  const repositoryRoot = resolve(argValue('--root') ?? process.cwd());
  const asJson = hasFlag('--json');
  const includeChats = hasFlag('--include-chats');
  const promote = hasFlag('--promote');
  const approve = hasFlag('--approve');
  const syncOnly = hasFlag('--sync-only') || process.argv[1]?.includes('swarm-sync');

  const sync = assessSwarmSync({ repositoryRoot });
  const manifest = scanMemoryImport({ repositoryRoot, includeChats });
  const dialog = importDialogSummary(manifest);

  if (asJson) {
    const payload = promote
      ? {
          sync,
          dialog,
          manifest,
          promote: await (async () => {
            const vault = makeDryRunVault((m) => console.error(m));
            const selected = manifest.candidates.filter((c) => c.selected_by_default && c.promotable);
            return promoteMemoryImport(vault, {
              candidates: selected,
              humanApproved: approve,
              note: 'cli swarm:import',
            });
          })(),
        }
      : { sync, dialog, manifest };
    const outPath = argValue('--output');
    const text = JSON.stringify(payload, null, 2);
    if (outPath) writeFileSync(outPath, `${text}\n`, 'utf8');
    else console.log(text);
    if (sync.overall === 'fail' || (promote && !approve)) process.exitCode = 1;
    return;
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  STARLIGHT SWARM — sync + memory import');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log(`  overall sync: ${sync.overall}`);
  for (const check of sync.checks) {
    console.log(`  [${check.status.padEnd(4)}] ${check.id.padEnd(22)} ${check.detail}`);
  }
  console.log('');
  console.log(`  ${dialog.title}`);
  console.log(`  ${dialog.subtitle}`);
  for (const bucket of dialog.buckets) {
    const mark = bucket.promotable ? (bucket.selected_by_default ? '✓' : '·') : '✕';
    console.log(`  ${mark} ${bucket.label.padEnd(28)} (${bucket.count})`);
  }
  console.log('');
  console.log(
    `  candidates: ${manifest.candidates.length}  ready=${manifest.counts.ready}  refused=${manifest.counts.refused}  needs_redaction=${manifest.counts.needs_redaction}`,
  );

  if (syncOnly) {
    if (sync.overall === 'fail') process.exitCode = 1;
    return;
  }

  if (promote) {
    const vault = makeDryRunVault((m) => console.log(m));
    const selected = manifest.candidates.filter((c) => c.selected_by_default && c.promotable);
    const result = await promoteMemoryImport(vault, {
      candidates: selected,
      humanApproved: approve,
      note: 'cli swarm:import',
    });
    console.log('');
    console.log(`  promote ok=${result.ok}  promoted=${result.promoted.length}  refused=${result.refused.length}`);
    for (const r of result.refused.slice(0, 8)) {
      console.log(`  ✕ ${r.candidate_id}: ${r.reason}`);
    }
    if (!result.ok) process.exitCode = 1;
  } else {
    console.log('');
    console.log('  Scan only. Re-run with --promote --approve to human-gate dry-run vault appends.');
  }

  if (sync.overall === 'fail') process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
