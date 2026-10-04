import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { sha256Digest } from './runtime-digest';
import { bindCloudflareWorkflowOperation, cloudflareWorkflowOperationEnvelope, isIssuedCloudflareWorkflowOperation } from './workflow-operation-context';
import { workflowOperationFixture } from './workflow-operation-test-fixtures';
import { OperationAuthority, signApprovalReceipt, signBudgetReceipt, type OperationAuthorityStore } from './operation-authority';

let fixture: ReturnType<typeof workflowOperationFixture>;
before(() => { fixture = workflowOperationFixture(); });
after(() => fixture?.cleanup());
const bound = () => bindCloudflareWorkflowOperation(fixture.plan, fixture.profile, fixture.verification, fixture.binding, fixture.target);

test('a real verified pack binds the exact workflow instance into the existing operation authority digest', () => {
  const result = bound();
  assert.equal(isIssuedCloudflareWorkflowOperation(result), true);
  assert.equal(isIssuedCloudflareWorkflowOperation(JSON.parse(JSON.stringify(result))), false);
  assert.equal(result.binding.context_digest_sha256, sha256Digest(result.context));
  assert.equal(result.context.input_context_digest_sha256, fixture.binding.context_digest_sha256);
  assert.equal(result.context.target.instance_id, fixture.target.instance_id);
  assert.equal(result.activation_authority_granted, false);
  assert.equal(Object.isFrozen(result.context.target), true);
  assert.throws(() => { result.context.target.instance_id = 'changed'; }, TypeError);
  assert.notEqual(result.binding.context_digest_sha256, fixture.binding.context_digest_sha256);
});

test('copied pack receipts cannot bind operations', () => {
  assert.throws(() => bindCloudflareWorkflowOperation(fixture.plan, fixture.profile, { ...fixture.verification }, fixture.binding, fixture.target), /issued/i);
});
test('provider correlation contains digests and target identity without private operation fields', () => {
  const input = { ...fixture.binding, effect: { ...fixture.binding.effect, resource: 'private/operator/source-document' } };
  const operation = bindCloudflareWorkflowOperation(fixture.plan, fixture.profile, fixture.verification, input, fixture.target);
  const payload = cloudflareWorkflowOperationEnvelope(operation);
  assert.equal(payload.operation_binding_digest_sha256, sha256Digest(operation.binding));
  assert.equal(JSON.stringify(payload).includes('private/operator/source-document'), false);
  assert.equal(JSON.stringify(payload).includes(fixture.binding.actor_id), false);
});

for (const field of ['plan_digest_sha256', 'policy_digest_sha256', 'pack_digest_sha256', 'compiler_version', 'lane_id', 'workload_id', 'runtime_id', 'budget_policy_id', 'role'] as const) {
  test(`a substituted ${field} is rejected`, () => {
    const input = { ...fixture.binding, [field]: field.endsWith('sha256') ? 'f'.repeat(64) : 'substituted' };
    assert.throws(() => bindCloudflareWorkflowOperation(fixture.plan, fixture.profile, fixture.verification, input, fixture.target));
  });
}
test('a substituted immutable profile, unscoped capability and over-budget operation are rejected', () => {
  for (const change of [
    { source_profile: { ...fixture.binding.source_profile, commit_sha: 'f'.repeat(40) } },
    { capabilities: ['undeclared-root-access'] }, { requested_cost_usd: 4.000001 }, { requested_cost_usd: 0.0000001 },
  ]) assert.throws(() => bindCloudflareWorkflowOperation(fixture.plan, fixture.profile, fixture.verification, { ...fixture.binding, ...change }, fixture.target));
});
test('a changed profile cannot inherit the original verified receipt', () => {
  const profile = JSON.parse(JSON.stringify(fixture.profile)); profile.roles[0].capabilities.push('root-access');
  assert.throws(() => bindCloudflareWorkflowOperation(fixture.plan, profile, fixture.verification, fixture.binding, fixture.target), /profile/i);
});
test('exact tenant, workflow version and instance changes alter the signed operation binding', () => {
  const original = bound();
  for (const change of [{ account_id: 'b'.repeat(32) }, { instance_id: 'mission-instance-two' }, { version_id: '33333333-3333-4333-8333-333333333333' }]) {
    const result = bindCloudflareWorkflowOperation(fixture.plan, fixture.profile, fixture.verification, fixture.binding, { ...fixture.target, ...change });
    assert.notEqual(sha256Digest(result.binding), sha256Digest(original.binding));
  }
});
test('a target outside the one canonical prepared owner is rejected', () => {
  for (const change of [{ workflow_id: 'other-workflow' }, { prepared_deployment_id: 'other-deployment' }, { instance_id: '../traversal' }, { endpoint: 'http://localhost' }, { instance_id: 'cf_' + 'a'.repeat(64) }]) {
    assert.throws(() => bindCloudflareWorkflowOperation(fixture.plan, fixture.profile, fixture.verification, fixture.binding, { ...fixture.target, ...change }));
  }
});
test('the existing cryptographic authority refuses an approval signed for another workflow instance before reserving', async () => {
  const original = bound();
  const changed = bindCloudflareWorkflowOperation(fixture.plan, fixture.profile, fixture.verification, fixture.binding, { ...fixture.target, instance_id: 'mission-instance-two' });
  const secret = 'test-only-authority-secret-32-characters';
  const now = Date.now();
  const receipt = { receipt_id: 'receipt-one', issuer: 'test-issuer', key_id: 'test-key', issued_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 60_000).toISOString(), binding_digest_sha256: sha256Digest(original.binding) };
  const approval = signApprovalReceipt({ ...receipt, schema_version: 'starlight.operation_approval.v1', scope: 'admit-bounded-operation', allowed_capabilities: original.binding.capabilities }, secret);
  const budget = signBudgetReceipt({ ...receipt, schema_version: 'starlight.operation_budget.v1', budget_policy_id: original.binding.budget_policy_id, hard_limit_usd: 2 }, secret);
  let attemptedReservation = false; let denialRecorded = false;
  // Signature rejection happens before mutable admission. This stub cannot authorize a reservation.
  const store = { durable: true, reserve: async () => { attemptedReservation = true; throw new Error('Reservation must not be reached.'); }, recordDenial: async () => { denialRecorded = true; } } as unknown as OperationAuthorityStore;
  const authority = new OperationAuthority(store, { approvalIssuers: { 'test-issuer': { 'test-key': secret } }, budgetIssuers: { 'test-issuer': { 'test-key': secret } } });
  const result = await authority.admit({ binding: changed.binding, approval_receipt: approval, budget_receipt: budget, reservation_duration_ms: 1000 });
  assert.equal(result.admitted, false); assert.equal(attemptedReservation, false); assert.equal(denialRecorded, true);
  assert.match(result.blockers.join(' '), /bound to another operation/);
});
