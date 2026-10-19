#!/usr/bin/env node
// starlight-queen — launcher for src/swarm/queen-cli.ts.
// The kernel ships as TypeScript; the CLI entry is started under tsx the same
// way the test suite runs (`node --import tsx`), so the bin works from a
// checkout or an npm install with no build step. All logic lives in the .ts.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const tsx = pathToFileURL(require.resolve('tsx')).href;
const entry = fileURLToPath(new URL('../src/swarm/queen-cli.entry.ts', import.meta.url));

const result = spawnSync(process.execPath, ['--import', tsx, entry, ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
