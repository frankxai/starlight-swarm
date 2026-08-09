import { existsSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function assertNoSymlinkPath(repositoryRoot: string, candidate: string): void {
  let cursor = candidate;
  while (isInside(repositoryRoot, cursor)) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error('Generated output path cannot contain a symbolic link.');
    }
    if (cursor === repositoryRoot) break;
    cursor = dirname(cursor);
  }
}

export function resolveGeneratedOutput(
  repositoryRoot: string,
  requestedPath: string,
  forceOverwrite: boolean,
): string {
  if (isAbsolute(requestedPath)) {
    throw new Error('Generated output path must be relative to the repository root.');
  }

  const root = resolve(repositoryRoot);
  const allowedRoot = resolve(root, 'runtime', 'generated');
  const candidate = resolve(root, requestedPath);
  if (!isInside(allowedRoot, candidate)) {
    throw new Error('Generated output must stay under runtime/generated.');
  }
  if (!candidate.toLowerCase().endsWith('.json')) {
    throw new Error('Generated runtime artifacts must use a .json extension.');
  }

  assertNoSymlinkPath(root, dirname(candidate));

  if (existsSync(candidate)) {
    if (lstatSync(candidate).isSymbolicLink()) {
      throw new Error('Generated output file cannot be a symbolic link.');
    }
    if (!forceOverwrite) {
      throw new Error('Generated output already exists; pass --force to overwrite it explicitly.');
    }
  }

  return candidate;
}

export function resolveGeneratedPackDirectory(
  repositoryRoot: string,
  requestedPath: string,
  _forceOverwrite = false,
): string {
  if (isAbsolute(requestedPath)) {
    throw new Error('Generated pack path must be relative to the repository root.');
  }

  const root = resolve(repositoryRoot);
  const allowedRoot = resolve(root, 'runtime', 'generated', 'packs');
  const candidate = resolve(root, requestedPath);
  if (!isInside(allowedRoot, candidate) || candidate === allowedRoot) {
    throw new Error('Generated team packs must stay under runtime/generated/packs/<pack-id>.');
  }

  assertNoSymlinkPath(root, candidate);
  if (existsSync(candidate)) {
    throw new Error('Generated team packs are immutable; the destination already exists.');
  }

  return candidate;
}
