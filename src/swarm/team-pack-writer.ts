import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { sha256Digest } from './runtime-digest';
import { resolveGeneratedPackDirectory } from './runtime-output';
import type { CompiledTeamPack } from './team-pack';

export interface WrittenTeamPack {
  output_directory: string;
  pack_digest_sha256: string;
  files_written: number;
}

function portableRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join('/');
}

function safePackFilePath(root: string, filePath: string): string {
  const destination = resolve(root, filePath);
  const rel = relative(root, destination);
  if (
    !filePath ||
    filePath.includes('\\') ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(filePath)
  ) {
    throw new Error(`Pack file escaped output directory: ${filePath}`);
  }
  return destination;
}

export function writeTeamPackAtomically(
  repositoryRoot: string,
  requestedOutput: string,
  pack: CompiledTeamPack,
): WrittenTeamPack {
  const root = resolve(repositoryRoot);
  const outputDirectory = resolveGeneratedPackDirectory(root, requestedOutput);
  const packsRoot = resolve(root, 'runtime', 'generated', 'packs');
  mkdirSync(packsRoot, { recursive: true });
  if (lstatSync(packsRoot).isSymbolicLink()) {
    throw new Error('Generated packs root cannot be a symbolic link.');
  }

  const temporaryDirectory = mkdtempSync(join(packsRoot, '.tmp-team-pack-'));
  const packDigest = sha256Digest({ manifest: pack.manifest, file_digests: pack.file_digests });

  try {
    for (const [filePath, content] of Object.entries(pack.files)) {
      const destination = safePackFilePath(temporaryDirectory, filePath);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    }

    const manifestPath = safePackFilePath(temporaryDirectory, 'manifest.json');
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...pack.manifest, pack_digest_sha256: packDigest }, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );

    if (existsSync(outputDirectory)) {
      throw new Error('Generated team packs are immutable; the destination already exists.');
    }
    renameSync(temporaryDirectory, outputDirectory);
  } catch (error) {
    if (existsSync(temporaryDirectory) && !lstatSync(temporaryDirectory).isSymbolicLink()) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    throw error;
  }

  return {
    output_directory: portableRelative(root, outputDirectory),
    pack_digest_sha256: packDigest,
    files_written: Object.keys(pack.files).length + 1,
  };
}
