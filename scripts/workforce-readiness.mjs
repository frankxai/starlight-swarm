import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const HOUR = 3_600_000;
const MAX_AGE = 15 * 60_000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)
  && Number.isFinite(Date.parse(value));

export function validatePortfolio(value) {
  if (!object(value) || value.schema !== 'starlight.workforce-projection/v1'
      || value.authority !== 'starlight-queen' || !nonempty(value.portfolio_id)
      || !Array.isArray(value.units) || value.units.length !== 12) {
    throw new Error('Expected one Starlight Queen and twelve business units.');
  }
  const ids = new Set();
  for (const unit of value.units) {
    if (!object(unit) || !/^[a-z][a-z0-9-]*$/.test(unit.id ?? '') || ids.has(unit.id)
        || !nonempty(unit.name) || typeof unit.pilot !== 'boolean'
        || !/^steward-[a-z-]+$/.test(unit.steward ?? '') || !nonempty(unit.repo)
        || !nonempty(unit.outcome)) throw new Error('Invalid or duplicate business unit.');
    ids.add(unit.id);
  }
  const pilots = value.units.filter(unit => unit.pilot).map(unit => unit.id).sort();
  if (JSON.stringify(pilots) !== JSON.stringify(['frankx', 'gencreator', 'starlight'])) {
    throw new Error('Initial pilots must be FrankX, GenCreator and Starlight.');
  }
  if (!object(value.budget) || !Number.isFinite(value.budget.planning_daily_usd)
      || value.budget.planning_daily_usd < 0 || value.budget.authorized_daily_usd !== 0
      || value.pilot_concurrency !== 1) {
    throw new Error('Projection cannot authorize spend or raise initial concurrency.');
  }
  if (JSON.stringify(value.roles) !== JSON.stringify([
    'coordinator', 'maker', 'independent-verifier', 'synthetic-user',
  ])) throw new Error('Cell requires a maker, independent verifier and synthetic user.');
  return value;
}

function freshness(timestamp, nowMs) {
  if (!iso(timestamp)) return 'unknown';
  const age = nowMs - Date.parse(timestamp);
  return age < -60_000 ? 'future' : age > MAX_AGE ? 'stale' : 'fresh';
}

/** A read-only projection. Never issues an admission receipt or mutates a queue. */
export function assessWorkforce(portfolioInput, graph, now = new Date().toISOString()) {
  const portfolio = validatePortfolio(portfolioInput);
  if (!iso(now)) throw new Error('Evaluation time must be an ISO timestamp with timezone.');
  const nowMs = Date.parse(now);
  const blockers = [];
  const add = (code, reason, owner, next) => blockers.push({ code, reason, owner, next });
  const valid = object(graph) && graph.schema === 'starlight.systems-graph/v1'
    && Array.isArray(graph.nodes) && object(graph.findings) && object(graph.sources);
  if (!valid) add('invalid-systems-graph', 'Systems graph is missing or has an unsupported shape.',
    'steward-substrate', 'Read a current graph/systems.graph.json from the estate generator.');
  const findings = valid ? graph.findings : {};
  const nodes = valid ? graph.nodes.filter(object) : [];
  const sources = valid ? graph.sources : {};
  const graphFreshness = freshness(valid ? graph.generatedAt : null, nowMs);
  if (graphFreshness !== 'fresh') add('systems-evidence-' + graphFreshness,
    'Systems evidence is ' + graphFreshness + '; runtime checks require evidence within 15 minutes.',
    'steward-infra', 'Refresh existing collectors and regenerate the systems graph.');
  const sourceStates = Object.fromEntries(['windows', 'hermes', 'loops', 'railway', 'n8n'].map(name =>
    [name, freshness(sources[name]?.capturedAt, nowMs)]));
  for (const [name, state] of Object.entries(sourceStates)) {
    if (state !== 'fresh') add('source-' + name + '-' + state,
      name + ' source is ' + state + '; regenerating a graph does not refresh its sources.',
      'steward-infra', 'Collect fresh ' + name + ' execution evidence.');
  }
  for (const name of ['hermes', 'loops']) {
    if (findings[name]?.planeStalled !== false) add(name + '-not-proven-running',
      name + ' plane is stalled or its liveness is unknown.', 'steward-infra',
      'Repair the existing dispatcher and verify a completed job plus fresh heartbeat.');
  }
  // Transport prose and a successful deployment are insufficient to assert reachability.
  add('cloud-queue-proof-required', 'No authenticated remote claim/complete canary is verified by this projection.',
    'steward-substrate', 'Reconcile agentic-ops bridge-hardening; prove one durable shared queue with laptop asleep.');
  if (!(Number.isInteger(findings.n8n?.heartbeatFiles) && findings.n8n.heartbeatFiles > 0)) {
    add('n8n-run-proof-missing', 'Active workflow flags do not establish recent execution.',
      'steward-infra', 'Join n8n execution IDs and completion timestamps to the existing health collector.');
  }
  add('trusted-admission-required', 'Runtime admission remains report-only; a registry cannot authorize a worker.',
    'steward-substrate', 'Complete trusted pack-bound approval, budget and lease verification in the runtime.');
  const warnings = [
    'Business units and functional stewards are distinct; this file is a planning projection of existing identities.',
    'Provider deployment success is not a verified completed job.',
    'The daily planning estimate is not a spend authorization.',
  ];
  const duplicateIds = nodes.map(node => node.id).filter((id, i, all) => !nonempty(id) || all.indexOf(id) !== i);
  if (duplicateIds.length) add('ambiguous-node-identities', 'Systems graph has missing or duplicate node IDs.',
    'steward-substrate', 'Repair collector identities before joining worker evidence.');
  const units = portfolio.units.map(unit => {
    const stewardNodes = nodes.filter(node => node.plane === 'agent-corps' && node.name === unit.steward);
    const node = stewardNodes.length === 1 ? stewardNodes[0] : undefined;
    // heartbeatAgeH is relative to graph generation, so age it again at read time.
    const heartbeatAgeMs = typeof node?.heartbeatAgeH === 'number' && Number.isFinite(node.heartbeatAgeH)
      ? node.heartbeatAgeH * HOUR + Math.max(0, nowMs - Date.parse(graph.generatedAt)) : NaN;
    const evidence = graphFreshness === 'fresh' && node?.state === 'live'
      && heartbeatAgeMs >= 0 && heartbeatAgeMs <= MAX_AGE
      && freshness(node?.lastObserved, nowMs) === 'fresh' ? 'recent-steward-evidence' : 'unverified';
    return { ...unit, stage: unit.pilot ? 'pilot-candidate' : 'registered', steward_evidence: evidence,
      admitted: false, active_workers: null };
  });
  return {
    schema: 'starlight.workforce-readiness/v1', evaluated_at: now, portfolio_id: portfolio.portfolio_id,
    authority: portfolio.authority, admitted: false, mode: 'report-only',
    systems_generated_at: valid && iso(graph.generatedAt) ? graph.generatedAt : null,
    systems_freshness: graphFreshness, source_freshness: sourceStates,
    budget: { ...portfolio.budget }, pilot_concurrency: portfolio.pilot_concurrency,
    counts: { registered_units: units.length, pilot_candidates: units.filter(unit => unit.pilot).length,
      verified_active_workers: null }, units, blockers, warnings,
    observations: {
      hermes_stalled: typeof findings.hermes?.planeStalled === 'boolean' ? findings.hermes.planeStalled : null,
      loops_stalled: typeof findings.loops?.planeStalled === 'boolean' ? findings.loops.planeStalled : null,
      queue_transport: typeof findings.queues?.bridgeTransport === 'string' ? findings.queues.bridgeTransport : null,
    },
  };
}

const cell = value => String(value).replace(/[|\r\n]/g, ' ');
export function renderWorkforceMarkdown(report) {
  return [
    '# Autonomous workforce readiness', '',
    `Evaluated: ${report.evaluated_at}. Source graph: ${report.systems_generated_at ?? 'unknown'} (${report.systems_freshness}).`, '',
    'One Queen · twelve business units · three pilot candidates · activation not authorized.', '',
    '| Business unit | Functional steward | Stage | Steward evidence |',
    '| --- | --- | --- | --- |',
    ...report.units.map(unit => `| ${cell(unit.name)} | ${cell(unit.steward)} | ${unit.stage} | ${unit.steward_evidence} |`), '',
    '## Activation work', '',
    ...report.blockers.map(item => `- ${cell(item.code)}: ${cell(item.reason)} Next: ${cell(item.next)} Owner: ${cell(item.owner)}.`), '',
    ...report.warnings.map(warning => `- ${warning}`), '',
  ].join('\n');
}

export function main(args) {
  if (args.length < 1 || args.length > 2 || (args[1] && args[1] !== '--markdown')) {
    throw new Error('Usage: npm run workforce:check -- <systems.graph.json> [--markdown]');
  }
  const portfolio = JSON.parse(readFileSync(new URL('../runtime/policies/estate-workforce.json', import.meta.url), 'utf8'));
  const graph = JSON.parse(readFileSync(resolve(args[0]), 'utf8'));
  const result = assessWorkforce(portfolio, graph);
  process.stdout.write(args[1] === '--markdown' ? renderWorkforceMarkdown(result) : JSON.stringify(result, null, 2) + '\n');
  return result.blockers.length ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`workforce: ${error.message}\n`); process.exitCode = 1; }
}
