import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { parsePreparedWorkflowBundle, prepareWorkflowBundle } from './workflow-runtime-adapters';
import { workflowOperationFixture } from './workflow-operation-test-fixtures';

describe('workflow-runtime-adapters', () => {
  it('parsePreparedWorkflowBundle rejects missing version', () => {
    assert.throws(
      () => parsePreparedWorkflowBundle({ team_id: 'test' }),
      /invalid_type/,
      'Should reject missing version'
    );
  });

  it('prepareWorkflowBundle validates verification receipt issue status', () => {
    const fixture = workflowOperationFixture();
    try {
      const { plan, verification } = fixture;
      // Pass a fake object that fails isIssuedTeamPackVerificationResult
      assert.throws(
        () => prepareWorkflowBundle(plan, {} as any),
        /Pack verification receipt was not issued by the team-pack verifier/
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('prepareWorkflowBundle handles valid verification receipt', () => {
    const fixture = workflowOperationFixture();
    try {
      const { plan, verification } = fixture;
      const result = prepareWorkflowBundle(plan, verification);
      assert.equal(result.schema_version, 'starlight.prepared_runtime_bundle.v2');
      assert.equal(result.status, 'prepared-human-approval-required');
    } finally {
      fixture.cleanup();
    }
  });
});
