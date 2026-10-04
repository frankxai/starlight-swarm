import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { deriveWorkflowInstanceOwnership, parseWorkflowInstanceOwnership } from './workflow-instance-ownership';
import { bindCloudflareWorkflowOperation, cloudflareWorkflowOperationEnvelope } from './workflow-operation-context';
import { workflowOperationFixture } from './workflow-operation-test-fixtures';
import { sha256Digest } from './runtime-digest';

let fixture: ReturnType<typeof workflowOperationFixture>;
before(() => { fixture = workflowOperationFixture(); });
after(() => fixture?.cleanup());
const bound = () => bindCloudflareWorkflowOperation(fixture.plan, fixture.profile, fixture.verification, fixture.binding, fixture.target);
test('ownership derives exact durable identity and digest-only provider correlation from a verified operation', () => {
  const operation = bound(); const ownership = deriveWorkflowInstanceOwnership(operation);
  assert.equal(ownership.binding_digest_sha256, sha256Digest(operation.binding));
  assert.equal(ownership.workflow_context_digest_sha256, operation.binding.context_digest_sha256);
  assert.equal(ownership.envelope_digest_sha256, sha256Digest(cloudflareWorkflowOperationEnvelope(operation)));
  assert.equal(ownership.target_digest_sha256, sha256Digest(operation.context.target));
  assert.equal(ownership.activation_authority_granted, false);
  assert.equal(Object.isFrozen(ownership.target), true);
  assert.equal(JSON.stringify(ownership).includes(fixture.binding.actor_id), false);
  assert.equal(JSON.stringify(ownership).includes(fixture.binding.effect.resource), false);
});
test('a serialized or caller-authored bound operation cannot register ownership', () => {
  assert.throws(() => deriveWorkflowInstanceOwnership(JSON.parse(JSON.stringify(bound()))), /issued/i);
});
for (const field of ['binding_digest_sha256', 'workflow_context_digest_sha256', 'target_digest_sha256', 'envelope_digest_sha256'] as const) {
  test(`persisted ${field} corruption cannot be used for recovery`, () => {
    const ownership = deriveWorkflowInstanceOwnership(bound());
    assert.throws(() => parseWorkflowInstanceOwnership({ ...ownership, [field]: 'f'.repeat(64) }));
  });
}
test('strict ownership rejects authority flags, unknown fields and changed targets', () => {
  const ownership = deriveWorkflowInstanceOwnership(bound());
  for (const changed of [{ activation_authority_granted: true }, { ready: true }, { target: { ...ownership.target, instance_id: 'other-instance' } }]) {
    assert.throws(() => parseWorkflowInstanceOwnership({ ...ownership, ...changed }));
  }
});
