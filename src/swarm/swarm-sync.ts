/**
 * swarm-sync.ts — inventory check that swarm tech is actually synced.
 *
 * Answers: are charter prose, executable charter, Claude skills, worker skill
 * IDs, and pack MEMORY policy coherent enough to claim "synced"?
 *
 * Report-only. Never mutates. Fail-closed on missing load-bearing pieces.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { BENEVOLENCE_CHARTER } from './charter';
import { scanMemoryImport, type MemoryImportManifest } from './memory-import';
import { STREAMS } from './streams';

export const SWARM_SYNC_SCHEMA = 'starlight.swarm_sync.v1' as const;

export type SyncCheckStatus = 'ok' | 'warn' | 'fail';

export interface SyncCheck {
  id: string;
  status: SyncCheckStatus;
  detail: string;
}

export interface SwarmSyncReport {
  schema_version: typeof SWARM_SYNC_SCHEMA;
  checked_at: string;
  repository_root: string;
  overall: SyncCheckStatus;
  checks: SyncCheck[];
  memory_import: {
    skills: number;
    plugins: number;
    rules: number;
    hooks: number;
    agent_contracts: number;
    ready: number;
    refused: number;
  };
  worker_skills: string[];
  claude_skills: string[];
}

const CHARTER_CLAUSE_MARKERS = [
  'Fail closed',
  'Human gate on the irreversible',
  'Attribution honored',
  'Sovereignty is non-waivable',
  'Refusal is a first-class output',
  'No capability claim without a ledger entry',
] as const;

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function listClaudeSkillNames(repositoryRoot: string): string[] {
  const skillsRoot = join(repositoryRoot, '.claude', 'skills');
  if (!existsSync(skillsRoot)) return [];
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function overallStatus(checks: SyncCheck[]): SyncCheckStatus {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'ok';
}

export function assessSwarmSync(options: {
  repositoryRoot: string;
  now?: () => Date;
  memoryManifest?: MemoryImportManifest;
}): SwarmSyncReport {
  const repositoryRoot = resolve(options.repositoryRoot);
  const checks: SyncCheck[] = [];
  const now = options.now?.() ?? new Date();

  // 1. AGENTS.md exists and carries all six charter markers
  const agentsPath = join(repositoryRoot, 'AGENTS.md');
  const agents = readText(agentsPath);
  if (!agents) {
    checks.push({ id: 'agents-md', status: 'fail', detail: 'AGENTS.md missing — benevolence charter prose absent.' });
  } else {
    const missing = CHARTER_CLAUSE_MARKERS.filter((m) => !agents.includes(m));
    checks.push(
      missing.length === 0
        ? { id: 'agents-md', status: 'ok', detail: 'AGENTS.md contains all six benevolence charter clauses.' }
        : {
            id: 'agents-md',
            status: 'fail',
            detail: `AGENTS.md missing clause markers: ${missing.join(', ')}.`,
          },
    );
  }

  // 2. Executable charter module has six clauses
  const clauseCount = BENEVOLENCE_CHARTER.clauses.length;
  checks.push(
    clauseCount === 6
      ? {
          id: 'charter-module',
          status: 'ok',
          detail: `charter.ts exposes ${clauseCount} frozen clauses (${BENEVOLENCE_CHARTER.version}).`,
        }
      : {
          id: 'charter-module',
          status: 'fail',
          detail: `charter.ts expected 6 clauses, found ${clauseCount}.`,
        },
  );

  // 3. CLAUDE.md operating contract present
  const claudeMd = readText(join(repositoryRoot, 'CLAUDE.md'));
  checks.push(
    claudeMd
      ? { id: 'claude-md', status: 'ok', detail: 'CLAUDE.md operating contract present.' }
      : { id: 'claude-md', status: 'warn', detail: 'CLAUDE.md missing — Claude Code session contract absent.' },
  );

  // 4. Claude skills pack present
  const claudeSkills = listClaudeSkillNames(repositoryRoot);
  checks.push(
    claudeSkills.length > 0
      ? {
          id: 'claude-skills',
          status: 'ok',
          detail: `${claudeSkills.length} Claude Code skills under .claude/skills/.`,
        }
      : {
          id: 'claude-skills',
          status: 'warn',
          detail: 'No .claude/skills discovered — Cursor-parity skill sync will be empty.',
        },
  );

  // 5. Worker skill IDs declared (swarm runtime bindings)
  const workerSkills = Array.from(
    new Set(STREAMS.flatMap((s) => s.workers.map((w) => w.skill))),
  ).sort();
  checks.push(
    workerSkills.length > 0
      ? {
          id: 'worker-skills',
          status: 'ok',
          detail: `${workerSkills.length} distinct worker skill IDs declared in streams.ts.`,
        }
      : { id: 'worker-skills', status: 'fail', detail: 'No worker skills declared in streams.ts.' },
  );

  // 6. Pack MEMORY policy exists (generated or template via team-pack render contract)
  const packMemoryHint = join(repositoryRoot, 'runtime', 'generated', 'packs');
  let memoryPackOk = false;
  if (existsSync(packMemoryHint)) {
    try {
      const packs = readdirSync(packMemoryHint, { withFileTypes: true }).filter((e) => e.isDirectory());
      for (const pack of packs) {
        const mem = join(packMemoryHint, pack.name, 'MEMORY.md');
        if (existsSync(mem)) {
          const body = readText(mem) ?? '';
          if (body.includes('SIS/Postgres is canonical') && body.includes('No credentials')) {
            memoryPackOk = true;
            break;
          }
        }
      }
    } catch {
      memoryPackOk = false;
    }
  }
  checks.push(
    memoryPackOk
      ? {
          id: 'pack-memory',
          status: 'ok',
          detail: 'At least one compiled team pack MEMORY.md enforces SIS canonical + prohibitions.',
        }
      : {
          id: 'pack-memory',
          status: 'warn',
          detail:
            'No compiled pack MEMORY.md found — run npm run runtime:pack so durable memory policy is on disk.',
        },
  );

  // 7. Live funds hard stop still present in AGENTS / README
  const readme = readText(join(repositoryRoot, 'README.md')) ?? '';
  const hardStop =
    (agents ?? '').includes('never wired to live funds') ||
    readme.toLowerCase().includes('no live') ||
    readme.includes('never wired to live funds');
  checks.push(
    hardStop
      ? { id: 'no-live-funds', status: 'ok', detail: 'Live-funds hard stop is documented.' }
      : { id: 'no-live-funds', status: 'fail', detail: 'Live-funds hard stop documentation missing.' },
  );

  // 8. Memory import scan (Cursor parity surface)
  const manifest =
    options.memoryManifest ??
    scanMemoryImport({
      repositoryRoot,
      includeChats: false,
      now: () => now,
    });

  checks.push(
    manifest.counts.ready > 0
      ? {
          id: 'memory-import-ready',
          status: 'ok',
          detail: `Memory import scan found ${manifest.counts.ready} promotable candidates (${manifest.counts.skills} skills).`,
        }
      : {
          id: 'memory-import-ready',
          status: 'warn',
          detail: 'Memory import scan found 0 promotable candidates.',
        },
  );

  return {
    schema_version: SWARM_SYNC_SCHEMA,
    checked_at: now.toISOString(),
    repository_root: repositoryRoot,
    overall: overallStatus(checks),
    checks,
    memory_import: {
      skills: manifest.counts.skills,
      plugins: manifest.counts.plugins,
      rules: manifest.counts.rules,
      hooks: manifest.counts.hooks,
      agent_contracts: manifest.counts.agent_contracts,
      ready: manifest.counts.ready,
      refused: manifest.counts.refused,
    },
    worker_skills: workerSkills,
    claude_skills: claudeSkills,
  };
}
