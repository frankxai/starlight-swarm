/**
 * eval-cli.ts — run the governance evaluation and exit non-zero when it fails.
 *
 * Run:  npm run swarm:eval
 *
 * Exists so the suite is a command a human or a CI job can run, not a thing
 * buried inside a test runner's output. A red spine should be one line at the
 * bottom of a terminal, and it should stop a pipeline.
 */

import { evaluateGovernance, formatReport } from './eval-harness';
import { GOVERNANCE_SCENARIOS } from './eval-scenarios';

const report = evaluateGovernance(GOVERNANCE_SCENARIOS);
console.log('═══════════════════════════════════════════════════════════════');
console.log(formatReport(report));
console.log('═══════════════════════════════════════════════════════════════');

if (!report.ok) process.exit(1);
