/**
 * memory-import.ts — Cursor-parity import of local agent memories into swarm apps.
 *
 * Cursor's "Import from Claude Code" brings plugins/skills (and optionally chats)
 * into the IDE. Starlight mirrors that surface for swarm apps, with one hard
 * difference required by doctrine:
 *
 *   scan → candidate → human gate → promote (SIS)
 *
 * Local Claude Code / Cursor files are never a second canonical memory authority.
 * Raw transcripts are refused for promotion. Secrets redaction fails closed.
 *
 * Nothing here writes live SIS. Promotion targets SisVaultMcp (dry-run by default).
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

import type { SisVaultMcp, VaultEntry } from './integrations';
import { sha256Digest } from './runtime-digest';

export const MEMORY_IMPORT_SCHEMA = 'starlight.memory_import.v1' as const;

export type MemoryImportSource = 'claude-code' | 'cursor';
export type MemoryArtifactClass =
  | 'skill'
  | 'plugin'
  | 'rule'
  | 'hook'
  | 'agent-contract'
  | 'chat-excerpt'
  | 'memory-note';

export type Sensitivity = 'public' | 'internal' | 'private' | 'secret';
export type RetentionClass = 'ephemeral' | 'session' | 'durable-candidate' | 'refused';
export type CandidateStatus = 'ready' | 'needs-redaction' | 'refused';

const SECRET_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github-pat', re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { id: 'github-fine-grained', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { id: 'openai-key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9\-_]{20,}\b/ },
  { id: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/i },
  { id: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: 'generic-api-assignment', re: /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"]{8,}['"]/i },
];

const artifactClassSchema = z.enum([
  'skill',
  'plugin',
  'rule',
  'hook',
  'agent-contract',
  'chat-excerpt',
  'memory-note',
]);

export const memoryImportCandidateSchema = z
  .object({
    schema_version: z.literal(MEMORY_IMPORT_SCHEMA),
    id: z.string().min(8),
    source: z.enum(['claude-code', 'cursor']),
    artifact_class: artifactClassSchema,
    title: z.string().min(1),
    path: z.string().min(1),
    relative_path: z.string().min(1),
    content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    summary: z.string().min(1).max(480),
    sensitivity: z.enum(['public', 'internal', 'private', 'secret']),
    retention: z.enum(['ephemeral', 'session', 'durable-candidate', 'refused']),
    status: z.enum(['ready', 'needs-redaction', 'refused']),
    refuse_reason: z.string().optional(),
    redaction_hits: z.array(z.string()).default([]),
    promotable: z.boolean(),
    selected_by_default: z.boolean(),
    bytes: z.number().int().nonnegative(),
    mtime_iso: z.string().min(1),
  })
  .strict();

export type MemoryImportCandidate = z.infer<typeof memoryImportCandidateSchema>;

export const memoryImportManifestSchema = z
  .object({
    schema_version: z.literal(MEMORY_IMPORT_SCHEMA),
    scanned_at: z.string().min(1),
    roots: z.object({
      repository: z.string().min(1),
      claude: z.string().nullable(),
      cursor: z.string().nullable(),
    }),
    counts: z.object({
      skills: z.number().int().nonnegative(),
      plugins: z.number().int().nonnegative(),
      rules: z.number().int().nonnegative(),
      hooks: z.number().int().nonnegative(),
      agent_contracts: z.number().int().nonnegative(),
      chats: z.number().int().nonnegative(),
      memory_notes: z.number().int().nonnegative(),
      ready: z.number().int().nonnegative(),
      refused: z.number().int().nonnegative(),
      needs_redaction: z.number().int().nonnegative(),
    }),
    candidates: z.array(memoryImportCandidateSchema),
  })
  .strict();

export type MemoryImportManifest = z.infer<typeof memoryImportManifestSchema>;

export interface ScanMemoryImportOptions {
  repositoryRoot: string;
  /** Override Claude Code project root (defaults to repositoryRoot). */
  claudeRoot?: string;
  /** Override Cursor project root (defaults to repositoryRoot). */
  cursorRoot?: string;
  /** Include chat transcript paths if present. Still refused for promotion. */
  includeChats?: boolean;
  now?: () => Date;
}

export interface PromoteMemoryImportRequest {
  candidates: MemoryImportCandidate[];
  /** Explicit human approval — required. Silent / missing = refuse. */
  humanApproved: boolean;
  /** Optional operator note recorded on each vault entry. */
  note?: string;
  agent?: string;
  stream?: string;
}

export interface PromoteMemoryImportResult {
  ok: boolean;
  promoted: Array<{ candidate_id: string; vault_id: string }>;
  refused: Array<{ candidate_id: string; reason: string }>;
}

function fileSha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function clampSummary(text: string, max = 320): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
}

function detectSecrets(content: string): string[] {
  const hits: string[] = [];
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.re.test(content)) hits.push(pattern.id);
  }
  return hits;
}

function isUnderRoot(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith('..'));
}

function safeReadText(path: string, maxBytes = 512_000): string | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > maxBytes) return null;
    if (lstatSync(path).isSymbolicLink()) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function listFilesRecursive(dir: string, maxDepth = 4): string[] {
  if (!existsSync(dir) || maxDepth < 0) return [];
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    try {
      if (lstatSync(full).isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        out.push(...listFilesRecursive(full, maxDepth - 1));
      } else if (entry.isFile()) {
        out.push(full);
      }
    } catch {
      // skip unreadable entries — fail closed by omission
    }
  }
  return out;
}

function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  if (!content.startsWith('---')) return {};
  const end = content.indexOf('\n---', 3);
  if (end < 0) return {};
  const block = content.slice(3, end);
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  return { name, description };
}

function candidateId(source: MemoryImportSource, relativePath: string, contentSha: string): string {
  return sha256Digest({
    schema_version: MEMORY_IMPORT_SCHEMA,
    source,
    relative_path: relativePath.replace(/\\/g, '/'),
    content_sha256: contentSha,
  }).slice(0, 24);
}

function buildCandidate(input: {
  source: MemoryImportSource;
  artifact_class: MemoryArtifactClass;
  absolutePath: string;
  repositoryRoot: string;
  title: string;
  summary: string;
  content: string;
  forceRefuse?: string;
  selectedByDefault?: boolean;
}): MemoryImportCandidate {
  const relativePath = relative(input.repositoryRoot, input.absolutePath).replace(/\\/g, '/');
  const contentSha = fileSha256(input.content);
  const redactionHits = detectSecrets(input.content);
  const st = statSync(input.absolutePath);

  let status: CandidateStatus = 'ready';
  let retention: RetentionClass = 'durable-candidate';
  let sensitivity: Sensitivity = 'internal';
  let refuseReason: string | undefined;
  let promotable = true;

  if (input.artifact_class === 'chat-excerpt') {
    status = 'refused';
    retention = 'refused';
    sensitivity = 'private';
    promotable = false;
    refuseReason =
      input.forceRefuse ??
      'Raw chat transcripts are prohibited in shared durable memory (MEMORY.md lifecycle).';
  } else if (redactionHits.length > 0) {
    status = 'needs-redaction';
    retention = 'refused';
    sensitivity = 'secret';
    promotable = false;
    refuseReason = `Secret patterns detected: ${redactionHits.join(', ')}. Redact before promote.`;
  } else if (input.forceRefuse) {
    status = 'refused';
    retention = 'refused';
    promotable = false;
    refuseReason = input.forceRefuse;
  }

  const selected =
    input.selectedByDefault ??
    (promotable && (input.artifact_class === 'skill' || input.artifact_class === 'plugin' || input.artifact_class === 'rule'));

  return memoryImportCandidateSchema.parse({
    schema_version: MEMORY_IMPORT_SCHEMA,
    id: candidateId(input.source, relativePath, contentSha),
    source: input.source,
    artifact_class: input.artifact_class,
    title: input.title,
    path: resolve(input.absolutePath),
    relative_path: relativePath,
    content_sha256: contentSha,
    summary: clampSummary(input.summary),
    sensitivity,
    retention,
    status,
    refuse_reason: refuseReason,
    redaction_hits: redactionHits,
    promotable,
    selected_by_default: selected && promotable,
    bytes: st.size,
    mtime_iso: st.mtime.toISOString(),
  });
}

function scanClaudeSkills(claudeRoot: string, repositoryRoot: string): MemoryImportCandidate[] {
  const skillsRoot = join(claudeRoot, '.claude', 'skills');
  if (!existsSync(skillsRoot)) return [];
  const candidates: MemoryImportCandidate[] = [];
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMd = join(skillsRoot, entry.name, 'SKILL.md');
    const content = safeReadText(skillMd);
    if (!content) continue;
    const meta = parseSkillFrontmatter(content);
    candidates.push(
      buildCandidate({
        source: 'claude-code',
        artifact_class: 'skill',
        absolutePath: skillMd,
        repositoryRoot,
        title: meta.name ?? entry.name,
        summary: meta.description ?? clampSummary(content.replace(/^---[\s\S]*?---/, '').trim()),
        content,
        selectedByDefault: true,
      }),
    );
  }
  return candidates;
}

function scanClaudePlugins(claudeRoot: string, repositoryRoot: string): MemoryImportCandidate[] {
  const pluginRoots = [
    join(claudeRoot, '.claude', 'plugins'),
    join(claudeRoot, '.claude', 'marketplace'),
  ];
  const candidates: MemoryImportCandidate[] = [];
  for (const root of pluginRoots) {
    if (!existsSync(root)) continue;
    for (const file of listFilesRecursive(root, 3)) {
      const base = basename(file).toLowerCase();
      if (!base.endsWith('.json') && base !== 'plugin.md' && base !== 'readme.md') continue;
      const content = safeReadText(file);
      if (!content) continue;
      candidates.push(
        buildCandidate({
          source: 'claude-code',
          artifact_class: 'plugin',
          absolutePath: file,
          repositoryRoot,
          title: basename(dirname(file)),
          summary: clampSummary(content),
          content,
          selectedByDefault: true,
        }),
      );
    }
  }
  return candidates;
}

function scanClaudeHooks(claudeRoot: string, repositoryRoot: string): MemoryImportCandidate[] {
  const hooksRoot = join(claudeRoot, '.claude', 'hooks');
  if (!existsSync(hooksRoot)) return [];
  const candidates: MemoryImportCandidate[] = [];
  for (const file of listFilesRecursive(hooksRoot, 2)) {
    if (!/\.(js|mjs|cjs|ts|sh|json)$/i.test(file)) continue;
    const content = safeReadText(file);
    if (!content) continue;
    candidates.push(
      buildCandidate({
        source: 'claude-code',
        artifact_class: 'hook',
        absolutePath: file,
        repositoryRoot,
        title: basename(file),
        summary: clampSummary(content),
        content,
        selectedByDefault: false,
      }),
    );
  }
  return candidates;
}

function scanAgentContracts(root: string, source: MemoryImportSource, repositoryRoot: string): MemoryImportCandidate[] {
  const files = ['AGENTS.md', 'CLAUDE.md', 'AGENT.md'].map((name) => join(root, name));
  const candidates: MemoryImportCandidate[] = [];
  for (const file of files) {
    const content = safeReadText(file);
    if (!content) continue;
    candidates.push(
      buildCandidate({
        source,
        artifact_class: 'agent-contract',
        absolutePath: file,
        repositoryRoot,
        title: basename(file),
        summary: clampSummary(content),
        content,
        selectedByDefault: true,
      }),
    );
  }
  return candidates;
}

function scanCursorRules(cursorRoot: string, repositoryRoot: string): MemoryImportCandidate[] {
  const rulesRoot = join(cursorRoot, '.cursor', 'rules');
  const candidates: MemoryImportCandidate[] = [];
  if (existsSync(rulesRoot)) {
    for (const file of listFilesRecursive(rulesRoot, 3)) {
      if (!/\.(mdc|md|json)$/i.test(file)) continue;
      const content = safeReadText(file);
      if (!content) continue;
      candidates.push(
        buildCandidate({
          source: 'cursor',
          artifact_class: 'rule',
          absolutePath: file,
          repositoryRoot,
          title: basename(file),
          summary: clampSummary(content),
          content,
          selectedByDefault: true,
        }),
      );
    }
  }

  // Project-level Cursor rules file (legacy)
  const legacy = join(cursorRoot, '.cursorrules');
  const legacyContent = safeReadText(legacy);
  if (legacyContent) {
    candidates.push(
      buildCandidate({
        source: 'cursor',
        artifact_class: 'rule',
        absolutePath: legacy,
        repositoryRoot,
        title: '.cursorrules',
        summary: clampSummary(legacyContent),
        content: legacyContent,
        selectedByDefault: true,
      }),
    );
  }
  return candidates;
}

function scanCursorMemories(cursorRoot: string, repositoryRoot: string): MemoryImportCandidate[] {
  const memoryRoots = [
    join(cursorRoot, '.cursor', 'memories'),
    join(cursorRoot, '.cursor', 'memory'),
  ];
  const candidates: MemoryImportCandidate[] = [];
  for (const root of memoryRoots) {
    if (!existsSync(root)) continue;
    for (const file of listFilesRecursive(root, 3)) {
      if (!/\.(md|txt|json)$/i.test(file)) continue;
      const content = safeReadText(file);
      if (!content) continue;
      candidates.push(
        buildCandidate({
          source: 'cursor',
          artifact_class: 'memory-note',
          absolutePath: file,
          repositoryRoot,
          title: basename(file),
          summary: clampSummary(content),
          content,
          selectedByDefault: false,
        }),
      );
    }
  }
  return candidates;
}

function scanChatExcerpts(roots: string[], repositoryRoot: string): MemoryImportCandidate[] {
  const chatGlobs = ['.claude/projects', '.claude/conversations', '.cursor/chats', '.cursor/chat'];
  const candidates: MemoryImportCandidate[] = [];
  for (const root of roots) {
    for (const rel of chatGlobs) {
      const dir = join(root, rel);
      if (!existsSync(dir)) continue;
      const source: MemoryImportSource = rel.startsWith('.cursor') ? 'cursor' : 'claude-code';
      for (const file of listFilesRecursive(dir, 3)) {
        if (!/\.(json|jsonl|md|txt)$/i.test(file)) continue;
        const content = safeReadText(file, 64_000);
        if (!content) continue;
        candidates.push(
          buildCandidate({
            source,
            artifact_class: 'chat-excerpt',
            absolutePath: file,
            repositoryRoot,
            title: basename(file),
            summary: 'Chat transcript candidate — promotion refused by MEMORY policy.',
            content,
            selectedByDefault: false,
          }),
        );
      }
    }
  }
  return candidates;
}

function countByClass(candidates: MemoryImportCandidate[]): MemoryImportManifest['counts'] {
  const counts = {
    skills: 0,
    plugins: 0,
    rules: 0,
    hooks: 0,
    agent_contracts: 0,
    chats: 0,
    memory_notes: 0,
    ready: 0,
    refused: 0,
    needs_redaction: 0,
  };
  for (const c of candidates) {
    if (c.artifact_class === 'skill') counts.skills += 1;
    if (c.artifact_class === 'plugin') counts.plugins += 1;
    if (c.artifact_class === 'rule') counts.rules += 1;
    if (c.artifact_class === 'hook') counts.hooks += 1;
    if (c.artifact_class === 'agent-contract') counts.agent_contracts += 1;
    if (c.artifact_class === 'chat-excerpt') counts.chats += 1;
    if (c.artifact_class === 'memory-note') counts.memory_notes += 1;
    if (c.status === 'ready') counts.ready += 1;
    if (c.status === 'refused') counts.refused += 1;
    if (c.status === 'needs-redaction') counts.needs_redaction += 1;
  }
  return counts;
}

/**
 * Read-only scan of Claude Code + Cursor local artifacts into import candidates.
 * Never writes SIS. Never auto-promotes.
 */
export function scanMemoryImport(options: ScanMemoryImportOptions): MemoryImportManifest {
  const repositoryRoot = resolve(options.repositoryRoot);
  if (!existsSync(repositoryRoot)) {
    throw new Error(`Repository root does not exist: ${repositoryRoot}`);
  }

  const claudeRoot = resolve(options.claudeRoot ?? repositoryRoot);
  const cursorRoot = resolve(options.cursorRoot ?? repositoryRoot);
  if (!isUnderRoot(repositoryRoot, claudeRoot) && claudeRoot !== repositoryRoot) {
    // Allow sibling roots only when explicitly passed as absolute and existing;
    // still require they exist and are readable. Fail closed on missing.
  }
  if (!existsSync(claudeRoot)) {
    throw new Error(`Claude root does not exist: ${claudeRoot}`);
  }
  if (!existsSync(cursorRoot)) {
    throw new Error(`Cursor root does not exist: ${cursorRoot}`);
  }

  const candidates: MemoryImportCandidate[] = [
    ...scanClaudeSkills(claudeRoot, repositoryRoot),
    ...scanClaudePlugins(claudeRoot, repositoryRoot),
    ...scanClaudeHooks(claudeRoot, repositoryRoot),
    ...scanAgentContracts(claudeRoot, 'claude-code', repositoryRoot),
    ...scanCursorRules(cursorRoot, repositoryRoot),
    ...scanCursorMemories(cursorRoot, repositoryRoot),
    ...scanAgentContracts(cursorRoot, 'cursor', repositoryRoot),
  ];

  if (options.includeChats) {
    candidates.push(...scanChatExcerpts(Array.from(new Set([claudeRoot, cursorRoot])), repositoryRoot));
  }

  // Dedupe by id (same file may match agent-contract from both roots when identical)
  const byId = new Map<string, MemoryImportCandidate>();
  for (const c of candidates) {
    if (!byId.has(c.id)) byId.set(c.id, c);
  }
  const deduped = Array.from(byId.values()).sort((a, b) => {
    if (a.artifact_class !== b.artifact_class) return a.artifact_class.localeCompare(b.artifact_class);
    return a.relative_path.localeCompare(b.relative_path);
  });

  const now = options.now?.() ?? new Date();
  return memoryImportManifestSchema.parse({
    schema_version: MEMORY_IMPORT_SCHEMA,
    scanned_at: now.toISOString(),
    roots: {
      repository: repositoryRoot,
      claude: existsSync(join(claudeRoot, '.claude')) ? claudeRoot : null,
      cursor: existsSync(join(cursorRoot, '.cursor')) || existsSync(join(cursorRoot, '.cursorrules'))
        ? cursorRoot
        : null,
    },
    counts: countByClass(deduped),
    candidates: deduped,
  });
}

/**
 * Human-gated promotion of ready candidates into the vault.
 * Fail-closed: missing approval, chats, secrets, or non-promotable → refuse.
 */
export async function promoteMemoryImport(
  vault: SisVaultMcp,
  request: PromoteMemoryImportRequest,
): Promise<PromoteMemoryImportResult> {
  const promoted: PromoteMemoryImportResult['promoted'] = [];
  const refused: PromoteMemoryImportResult['refused'] = [];

  if (!request.humanApproved) {
    for (const c of request.candidates) {
      refused.push({
        candidate_id: c.id,
        reason: 'Human approval required before memory promotion (charter: human-gate).',
      });
    }
    return { ok: false, promoted, refused };
  }

  for (const raw of request.candidates) {
    let candidate: MemoryImportCandidate;
    try {
      candidate = memoryImportCandidateSchema.parse(raw);
    } catch {
      refused.push({ candidate_id: (raw as { id?: string })?.id ?? 'unknown', reason: 'Invalid candidate schema.' });
      continue;
    }

    if (!candidate.promotable || candidate.status !== 'ready') {
      refused.push({
        candidate_id: candidate.id,
        reason: candidate.refuse_reason ?? `Candidate status is ${candidate.status}; not promotable.`,
      });
      continue;
    }

    if (candidate.artifact_class === 'chat-excerpt') {
      refused.push({
        candidate_id: candidate.id,
        reason: 'Chat transcripts cannot be promoted to durable swarm memory.',
      });
      continue;
    }

    if (candidate.redaction_hits.length > 0) {
      refused.push({
        candidate_id: candidate.id,
        reason: `Secret patterns remain: ${candidate.redaction_hits.join(', ')}.`,
      });
      continue;
    }

    const entry: VaultEntry = {
      agent: request.agent ?? 'memory-import',
      stream: request.stream ?? 'swarm',
      task: `promote:${candidate.artifact_class}:${candidate.relative_path}`,
      note: clampSummary(
        [
          request.note ?? 'human-approved memory import',
          `source=${candidate.source}`,
          `title=${candidate.title}`,
          `sha256=${candidate.content_sha256}`,
          `summary=${candidate.summary}`,
        ].join(' | '),
        480,
      ),
      timestamp: new Date().toISOString(),
    };

    const result = await vault.sis_append_entry(entry);
    promoted.push({ candidate_id: candidate.id, vault_id: result.id });
  }

  return {
    ok: refused.length === 0 && promoted.length > 0,
    promoted,
    refused,
  };
}

/** Dialog-shaped summary mirroring Cursor's Import from Claude Code buckets. */
export function importDialogSummary(manifest: MemoryImportManifest): {
  title: string;
  subtitle: string;
  buckets: Array<{ id: string; label: string; count: number; selected_by_default: boolean; promotable: boolean }>;
} {
  const pluginSkillCount = manifest.counts.skills + manifest.counts.plugins;
  const chatCount = manifest.counts.chats;
  const ruleCount = manifest.counts.rules + manifest.counts.hooks + manifest.counts.agent_contracts;
  const memoryCount = manifest.counts.memory_notes;

  return {
    title: 'Import into Starlight Swarm',
    subtitle:
      'Bring over skills, plugins, and rules as candidates. Sync promotes only after a human gate — chats stay refused.',
    buckets: [
      {
        id: 'plugins-skills',
        label: 'Plugins & skills',
        count: pluginSkillCount,
        selected_by_default: pluginSkillCount > 0,
        promotable: pluginSkillCount > 0,
      },
      {
        id: 'rules-contracts',
        label: 'Rules & agent contracts',
        count: ruleCount,
        selected_by_default: ruleCount > 0,
        promotable: ruleCount > 0,
      },
      {
        id: 'memory-notes',
        label: 'Memory notes',
        count: memoryCount,
        selected_by_default: false,
        promotable: memoryCount > 0,
      },
      {
        id: 'chats',
        label: 'Chats',
        count: chatCount,
        selected_by_default: false,
        promotable: false,
      },
    ],
  };
}
