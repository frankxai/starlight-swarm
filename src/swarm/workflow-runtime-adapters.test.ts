import { describe, it, after } from 'node:test';
import * as assert from 'node:assert/strict';

import { parsePreparedWorkflowBundle, prepareWorkflowBundle } from './workflow-runtime-adapters';
import { workflowOperationFixture } from './workflow-operation-test-fixtures';
import { verifyTeamPackDirectory } from './team-pack-verifier';

describe('workflow-runtime-adapters', () => {
  const fixture = workflowOperationFixture();
  after(() => fixture.cleanup());

  it('compiles a prepared workflow bundle successfully', () => {
    const bundle = prepareWorkflowBundle(fixture.plan, fixture.verification);
    assert.equal(bundle.schema_version, 'starlight.prepared_runtime_bundle.v2');
    assert.equal(bundle.compiler_version, 'starlight.team_pack.compiler.v3');
    assert.equal(bundle.team_id, fixture.plan.team_id);
    assert.equal(bundle.status, 'prepared-human-approval-required');
  });

  it('parses a valid bundle', () => {
    const bundle = prepareWorkflowBundle(fixture.plan, fixture.verification);
    const parsed = parsePreparedWorkflowBundle(bundle);
    assert.equal(parsed.schema_version, 'starlight.prepared_runtime_bundle.v2');
    assert.deepEqual(parsed, bundle);
  });

  it('fails when verification team_id does not match the generated plan', () => {
    // We cannot just clone and change verification because `isIssuedTeamPackVerificationResult` checks object identity.
    // Instead we clone the plan, change team_id on the plan, and pass it with original verification
    const invalidPlan = { ...fixture.plan, team_id: 'tampered-team-id' };

    // We expect a different error message now if it fails the match check
    assert.throws(
      () => prepareWorkflowBundle(invalidPlan as any, fixture.verification),
      /Verified pack receipt does not bind the exact v2 plan, profile, policy and compiler./
    );
  });

  it('fails when verification is not issued by team-pack verifier', () => {
    const invalidVerification = { ...fixture.verification };
    assert.throws(
      () => prepareWorkflowBundle(fixture.plan, invalidVerification as any),
      /Pack verification receipt was not issued by the team-pack verifier./
    );
  });

  it('parse fails when a required field is flipped/missing', () => {
    const bundle = prepareWorkflowBundle(fixture.plan, fixture.verification);
    const flippedBundle = { ...bundle, team_id: 123 }; // Invalid type for team_id
    assert.throws(
      () => parsePreparedWorkflowBundle(flippedBundle),
      /expected string, received number/
    );
  });
});
