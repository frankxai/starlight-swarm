import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCheckedInAssessment, observatorySnapshot } from './observatory';
import { SUCCESS_CRITERIA, successOverview } from './success-criteria';

test('checked-in assessment is not admitted and keeps its blockers', () => {
  const assessment = loadCheckedInAssessment();
  assert.equal(assessment.admitted, false);
  assert.ok(assessment.blockers.length >= 3);
  assert.ok(assessment.blockers.some((b) => /railway-temporal/i.test(b)));
  assert.ok(assessment.blockers.some((b) => /hermes-local/i.test(b)));
  assert.ok(assessment.blockers.some((b) => /report-only|not implemented/i.test(b)));
});

test('observatory snapshot never projects admitted=true from a report-only assessor', () => {
  const snap = observatorySnapshot();
  assert.equal(snap.admitted, false);
  assert.equal(snap.posture, 'dry-run-only');
  assert.equal(snap.streams.length, 4);
  assert.ok(snap.kernel.kernel.some((m) => m.id === 'swarm'));
  assert.ok(snap.absorbed.count >= 8);
  assert.equal(snap.charter.clauses.length, 6);
  assert.equal(snap.admission.admitted, false);
  assert.match(snap.headline, /not admitted/i);
});

test('observatory refuses to launder an admitted caller snapshot', () => {
  assert.throws(
    () =>
      observatorySnapshot({
        admitted: true,
        approval_receipt_id: 'forged',
        budget_receipt_id: 'forged',
        blockers: [],
        warnings: [],
      }),
    /refuses to project an admitted snapshot/,
  );
});

test('success criteria are uniquely id-ed and leave Phase-1 work open', () => {
  const ids = SUCCESS_CRITERIA.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  const view = successOverview();
  assert.ok(view.met >= 10);
  assert.ok(view.open >= 3);
  assert.ok(SUCCESS_CRITERIA.some((c) => c.id === 'SC-11' && c.status === 'open'));
  assert.ok(SUCCESS_CRITERIA.some((c) => c.id === 'SC-10' && c.status === 'open'));
  assert.ok(SUCCESS_CRITERIA.some((c) => c.id === 'SC-12' && c.status === 'open'));
  assert.match(view.headline, /dry-run only/);
});
