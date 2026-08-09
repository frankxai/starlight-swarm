import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

import { sha256Digest } from './runtime-digest';
import { parseTeamRuntimePlan } from './runtime-plan-contract';
import { parseRuntimePlanningPolicy } from './runtime-policy';
import { parseTeamProfile } from './runtime-planner';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const issuedVerificationResults = new WeakSet<object>();
const manifestSchema = z
  .object({
    schema_version: z.literal('starlight.team_pack.v1'),
    compiler_version: z.literal('starlight.team_pack.compiler.v2'),
    team_id: z.string().min(1),
    team_profile_version: z.string().min(1),
    generated_at: z.string().datetime({ offset: true }),
    source_profile_digest_sha256: digestSchema,
    source_profile_repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    source_profile_commit_sha: z.string().regex(/^(?!0{40}$)[a-f0-9]{40}$/),
    source_profile_path: z.string().regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/),
    runtime_policy_id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    source_runtime_policy_digest_sha256: digestSchema,
    plan_digest_sha256: digestSchema,
    activation_status: z.literal('planned-human-approval-required'),
    files: z
      .array(
        z
          .object({
            path: z.string().regex(/^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/),
            sha256: digestSchema,
            bytes: z.number().int().positive(),
          })
          .strict(),
      )
      .min(10),
    pack_digest_sha256: digestSchema,
  })
  .strict();

function collectFiles(root: string, current = root): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Team pack contains a symbolic link: ${relative(root, absolute)}`);
    }
    if (entry.isDirectory()) {
      result.push(...collectFiles(root, absolute));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Team pack contains an unsupported entry: ${relative(root, absolute)}`);
    }
    result.push(relative(root, absolute).split(sep).join('/'));
  }
  return result.sort();
}

function resolveDeclaredFile(root: string, filePath: string): string {
  if (isAbsolute(filePath) || filePath.includes('\\')) {
    throw new Error(`Team-pack file path must be portable and relative: ${filePath}`);
  }
  const destination = resolve(root, filePath);
  const rel = relative(root, destination);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Team-pack file escaped its root: ${filePath}`);
  }
  return destination;
}

export interface TeamPackVerificationResult {
  status: 'verified-human-approval-required';
  team_id: string;
  plan_digest_sha256: string;
  source_profile_digest_sha256: string;
  source_runtime_policy_digest_sha256: string;
  pack_digest_sha256: string;
  compiler_version: 'starlight.team_pack.compiler.v2';
  files_verified: number;
}

export function isIssuedTeamPackVerificationResult(
  input: unknown,
): input is TeamPackVerificationResult {
  return typeof input === 'object' && input !== null && issuedVerificationResults.has(input);
}

export function verifyTeamPackDirectory(
  directory: string,
  untrustedPlan: unknown,
  untrustedProfile: unknown,
  untrustedRuntimePolicy: unknown,
): TeamPackVerificationResult {
  const plan = parseTeamRuntimePlan(untrustedPlan);
  const profile = parseTeamProfile(untrustedProfile);
  const runtimePolicy = parseRuntimePlanningPolicy(untrustedRuntimePolicy);
  const canonicalPlanDigest = sha256Digest(plan);
  const canonicalProfileDigest = sha256Digest(profile);
  const root = resolve(directory);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Team-pack path must be a real directory, not a symbolic link.');
  }

  const manifestPath = join(root, 'manifest.json');
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error('Team-pack manifest must be a regular file.');
  }
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));

  if (manifest.plan_digest_sha256 !== canonicalPlanDigest) {
    throw new Error('Team-pack manifest does not match the canonical plan digest.');
  }
  if (manifest.source_profile_digest_sha256 !== canonicalProfileDigest) {
    throw new Error('Team-pack manifest does not match the canonical profile digest.');
  }
  if (
    manifest.runtime_policy_id !== runtimePolicy.source.policy_id ||
    manifest.source_runtime_policy_digest_sha256 !== runtimePolicy.source_digest_sha256 ||
    plan.routing_policy.policy_id !== runtimePolicy.source.policy_id ||
    plan.routing_policy.policy_digest_sha256 !== runtimePolicy.source_digest_sha256
  ) {
    throw new Error('Team-pack manifest or plan does not match the canonical runtime policy digest.');
  }
  if (plan.source_profile.sha256 !== canonicalProfileDigest) {
    throw new Error('Runtime plan does not match the canonical profile digest.');
  }
  if (
    manifest.source_profile_repository !== plan.source_profile.repository ||
    manifest.source_profile_commit_sha !== plan.source_profile.commit_sha ||
    manifest.source_profile_path !== plan.source_profile.path ||
    plan.source_profile.repository !== runtimePolicy.source.team_profile_source.repository ||
    plan.source_profile.commit_sha !== runtimePolicy.source.team_profile_source.commit_sha ||
    plan.source_profile.path !== runtimePolicy.source.team_profile_source.path
  ) {
    throw new Error('Team-pack profile source provenance does not match the canonical plan and policy.');
  }
  if (manifest.team_id !== plan.team_id || manifest.team_id !== profile.team.id) {
    throw new Error('Team-pack team id does not match the canonical plan and profile.');
  }
  if (manifest.team_profile_version !== profile.ownership.version) {
    throw new Error('Team-pack profile version does not match the canonical profile.');
  }
  if (manifest.generated_at !== plan.generated_at) {
    throw new Error('Team-pack generation timestamp does not match the canonical plan.');
  }

  const declared = new Set<string>();
  const fileDigests: Record<string, string> = {};
  for (const file of manifest.files) {
    if (declared.has(file.path)) throw new Error(`Duplicate team-pack file declaration: ${file.path}`);
    declared.add(file.path);
    const absolute = resolveDeclaredFile(root, file.path);
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Team-pack artifact must be a regular file: ${file.path}`);
    }
    const content = readFileSync(absolute);
    const digest = sha256Digest(content.toString('utf8'));
    if (digest !== file.sha256) {
      throw new Error(`Team-pack artifact digest mismatch: ${file.path}`);
    }
    if (content.byteLength !== file.bytes) {
      throw new Error(`Team-pack artifact byte count mismatch: ${file.path}`);
    }
    fileDigests[file.path] = digest;
  }

  if (!declared.has('RUNTIME-POLICY.json')) {
    throw new Error('Team pack must declare its exact runtime policy source.');
  }
  const packagedPolicy = parseRuntimePlanningPolicy(
    JSON.parse(readFileSync(resolveDeclaredFile(root, 'RUNTIME-POLICY.json'), 'utf8')),
  );
  if (packagedPolicy.source_digest_sha256 !== runtimePolicy.source_digest_sha256) {
    throw new Error('Packaged runtime policy does not match the canonical runtime policy digest.');
  }

  const actualFiles = collectFiles(root);
  const expectedFiles = [...Array.from(declared), 'manifest.json'].sort();
  const undeclared = actualFiles.filter((path) => !expectedFiles.includes(path));
  const missing = expectedFiles.filter((path) => !actualFiles.includes(path));
  if (undeclared.length) throw new Error(`Team pack contains undeclared files: ${undeclared.join(', ')}`);
  if (missing.length) throw new Error(`Team pack is missing declared files: ${missing.join(', ')}`);

  const { pack_digest_sha256: expectedPackDigest, ...manifestWithoutPackDigest } = manifest;
  const actualPackDigest = sha256Digest({
    manifest: manifestWithoutPackDigest,
    file_digests: fileDigests,
  });
  if (actualPackDigest !== expectedPackDigest) {
    throw new Error('Team-pack manifest digest mismatch.');
  }

  const result = Object.freeze({
    status: 'verified-human-approval-required',
    team_id: manifest.team_id,
    plan_digest_sha256: manifest.plan_digest_sha256,
    source_profile_digest_sha256: manifest.source_profile_digest_sha256,
    source_runtime_policy_digest_sha256: manifest.source_runtime_policy_digest_sha256,
    pack_digest_sha256: actualPackDigest,
    compiler_version: manifest.compiler_version,
    files_verified: actualFiles.length,
  }) satisfies TeamPackVerificationResult;
  issuedVerificationResults.add(result);
  return result;
}
