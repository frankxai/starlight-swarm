/**
 * queen-cli.ts — the `starlight-queen` command. A thin shell over the kernel:
 * it validates Briefs, answers routing questions, classifies actions, and
 * verifies receipt ledgers. It runs nothing, dispatches nothing, and holds no
 * budget — the developer-machine runtime (hooks pack) and the private
 * controller call the same functions; this is the terminal view of them.
 *
 * Installed as a `starlight-*` bin so the Starlight CLI's extension dispatch
 * could reach it as `starlight queen`; note that SIS currently reserves
 * `queen` as a built-in, so until that built-in delegates, call this bin
 * directly: `starlight-queen <command>`.
 */

import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { join, resolve } from 'node:path';
import { BRIEF_SCHEMA, briefProblems } from './brief';
import { classify, riskTierOf } from './escalation';
import type { Action, ActionKind, StreamId } from './escalation';
import { DOMAIN_GENERAL_IDS, GENERALS_SOURCE, isDomainGeneralId } from './generals';
import type { SwarmModelTier } from './generals';
import { ModelRouter } from './router';
import { verifyLedger } from './receipts';

export const CLI_NAME = 'starlight-queen';

const HELP = `${CLI_NAME} — Starlight Queen kernel (open, MIT). Verifies, routes, classifies. Runs nothing.

  ${CLI_NAME} init [dir]                       write .starlight/queen/brief.example.json
  ${CLI_NAME} keygen <dir>                     write an Ed25519 receipt-signing keypair (private.pem 0600, public.pem)
  ${CLI_NAME} brief check <file>               validate a Brief; exit 1 with every problem listed
  ${CLI_NAME} route [--general id] [--tier t] [--high-risk] [--critical] [--unavailable m1,m2]
  ${CLI_NAME} classify --kind k --stream s [--amount n --cap n --moves-money --irreversible --cross-stream]
  ${CLI_NAME} receipt verify <ledger.jsonl> --key <public.pem>[,<public.pem>]
  ${CLI_NAME} generals                         list the Domain Generals and their source commit

Generals: ${DOMAIN_GENERAL_IDS.join(', ')}
Not here: run / watch. Dispatch lives in the queen-ops hooks pack and the private controller.`;

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
}

const EXAMPLE_BRIEF = {
  schema: BRIEF_SCHEMA,
  id: 'brief-example',
  objective: 'Survey the model routers in this repository and recommend the one to keep.',
  acceptance: ['Every router is named by file path.', 'The recommendation cites one measured number.'],
  output: { format: 'markdown', maxBytes: 20000 },
  tools: ['Read', 'Grep'],
  boundaries: ['No edits outside docs/.', 'No network calls.'],
  budget: { microUsd: 2000000, wallTimeMs: 600000, split: { collective: 30, workers: 40, scouts: 20, memory: 10 } },
  maker: { id: 'general:starlight-hermes', model: 'gemini-2.5-flash' },
  verifier: { id: 'checker:starlight-sentinel', model: 'claude-opus-4-6' },
  allowedChecks: ['npm test'],
  general: 'starlight-hermes',
  governance: 'hierarchical',
};

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export async function main(argv: string[], io: CliIo = { out: console.log, err: console.error }): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    io.out(HELP);
    return 0;
  }

  switch (cmd) {
    case 'generals': {
      for (const id of DOMAIN_GENERAL_IDS) io.out(id);
      io.out(`source: ${GENERALS_SOURCE.repo}@${GENERALS_SOURCE.commit.slice(0, 12)} ${GENERALS_SOURCE.path}`);
      return 0;
    }

    case 'init': {
      const dir = resolve(rest[0] ?? process.cwd(), '.starlight', 'queen');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'brief.example.json');
      if (existsSync(file)) {
        io.out(`exists: ${file}`);
      } else {
        writeFileSync(file, JSON.stringify(EXAMPLE_BRIEF, null, 2) + '\n');
        io.out(`wrote: ${file}`);
      }
      io.out(`next: ${CLI_NAME} brief check ${file}`);
      return 0;
    }

    case 'keygen': {
      const dir = rest[0];
      if (!dir) { io.err('keygen needs a directory'); return 1; }
      mkdirSync(dir, { recursive: true });
      const priv = join(dir, 'private.pem');
      const pub = join(dir, 'public.pem');
      if (existsSync(priv) || existsSync(pub)) { io.err(`refusing to overwrite keys in ${dir}`); return 1; }
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }));
      io.out(`wrote: ${priv} (0600)\nwrote: ${pub}`);
      return 0;
    }

    case 'brief': {
      const [sub, file] = rest;
      if (sub !== 'check' || !file) { io.err(`usage: ${CLI_NAME} brief check <file>`); return 1; }
      let brief: unknown;
      try { brief = readJson(file); } catch (e) { io.err(`cannot read ${file}: ${(e as Error).message}`); return 1; }
      const problems = briefProblems(brief);
      if (problems.length === 0) { io.out(`ok: ${file} is a complete Brief`); return 0; }
      io.err(`${file} is not dispatchable (${problems.length} problem${problems.length === 1 ? '' : 's'}):`);
      for (const p of problems) io.err(`  - ${p}`);
      return 1;
    }

    case 'route': {
      const { values } = parseArgs({
        args: rest,
        options: {
          general: { type: 'string' },
          tier: { type: 'string' },
          'high-risk': { type: 'boolean', default: false },
          critical: { type: 'boolean', default: false },
          unavailable: { type: 'string' },
          json: { type: 'boolean', default: false },
        },
      });
      if (values.general !== undefined && !isDomainGeneralId(values.general)) { io.err(`unknown general: ${values.general}`); return 1; }
      if (values.tier !== undefined && !['scout', 'build', 'council'].includes(values.tier)) { io.err(`unknown tier: ${values.tier}`); return 1; }
      const down = new Set((values.unavailable ?? '').split(',').map((s) => s.trim()).filter(Boolean));
      const router = new ModelRouter({ availability: (m) => !down.has(m) });
      const result = router.route({
        general: values.general as never,
        tier: values.tier as SwarmModelTier | undefined,
        highRisk: values['high-risk'],
        critical: values.critical,
      });
      if (values.json) io.out(JSON.stringify(result, null, 2));
      else {
        io.out(`tier       : ${result.tier}${result.critical ? ' (critical)' : ''}`);
        io.out(`model      : ${result.usedModel || '(none — refused)'}${result.wasFallback ? ' [fallback]' : ''}`);
        io.out(`reason     : ${result.reason}`);
        if (result.escalate) io.out(`escalate   : ${result.escalate}`);
      }
      return result.refused ? 2 : 0;
    }

    case 'classify': {
      const { values } = parseArgs({
        args: rest,
        options: {
          kind: { type: 'string' },
          stream: { type: 'string' },
          amount: { type: 'string' },
          cap: { type: 'string' },
          'moves-money': { type: 'boolean', default: false },
          irreversible: { type: 'boolean', default: false },
          'cross-stream': { type: 'boolean', default: false },
          json: { type: 'boolean', default: false },
        },
      });
      if (!values.kind || !values.stream) { io.err(`usage: ${CLI_NAME} classify --kind <kind> --stream <stream> [...]`); return 1; }
      const a: Action = {
        kind: values.kind as ActionKind,
        stream: values.stream as StreamId,
        irreversible: values.irreversible,
        movesMoney: values['moves-money'],
        crossStream: values['cross-stream'],
        ...(values.amount !== undefined ? { amount: Number(values.amount) } : {}),
        ...(values.cap !== undefined ? { cap: Number(values.cap) } : {}),
      };
      const c = classify(a);
      const risk = riskTierOf(c.decision);
      if (values.json) io.out(JSON.stringify({ ...c, riskTier: risk }, null, 2));
      else {
        io.out(`decision   : ${c.decision}  (risk tier: ${risk})`);
        io.out(`gates      : ${c.gates.join(' → ')}`);
        io.out(`reason     : ${c.reason}`);
      }
      return c.decision === 'human-gate' ? 3 : c.decision === 'founder-board' ? 2 : 0;
    }

    case 'receipt': {
      const [sub, file, ...flags] = rest;
      if (sub !== 'verify' || !file) { io.err(`usage: ${CLI_NAME} receipt verify <ledger.jsonl> --key <public.pem>`); return 1; }
      const { values } = parseArgs({ args: flags, options: { key: { type: 'string' } } });
      if (!values.key) { io.err('receipt verify needs --key <public.pem>[,<public.pem>]'); return 1; }
      let keysPem: string[];
      let text: string;
      try {
        keysPem = values.key.split(',').map((k) => readFileSync(k.trim(), 'utf8'));
        text = readFileSync(file, 'utf8');
      } catch (e) { io.err(`cannot read: ${(e as Error).message}`); return 1; }
      const entries = verifyLedger(text, keysPem);
      let bad = 0;
      for (const e of entries) {
        if (e.ok) io.out(`ok    line ${e.line}  ${e.receipt?.receiptId}  ${e.receipt?.verdict}  ${e.receipt?.run.id}`);
        else { bad += 1; io.err(`FAIL  line ${e.line}  ${e.reasons.join('; ')}`); }
      }
      io.out(`${entries.length - bad}/${entries.length} receipts verified`);
      return bad === 0 && entries.length > 0 ? 0 : 1;
    }

    default:
      io.err(`unknown command: ${cmd}\n`);
      io.err(HELP);
      return 1;
  }
}
