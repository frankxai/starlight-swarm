import { z } from 'zod';
import { sha256Digest } from './runtime-digest';
import { cloudflareWorkflowOperationEnvelope, cloudflareWorkflowTargetSchema, isIssuedCloudflareWorkflowOperation } from './workflow-operation-context';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const workflowInstanceOwnershipSchema = z.object({
  schema_version: z.literal('starlight.workflow_instance_ownership.v1'),
  operation_id: z.string().min(3).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  binding_digest_sha256: digest, workflow_context_digest_sha256: digest,
  target_digest_sha256: digest, envelope_digest_sha256: digest,
  target: cloudflareWorkflowTargetSchema,
  workflow_context: z.object({
    schema_version: z.literal('starlight.workflow_operation_context.v1'),
    input_context_digest_sha256: digest,
    identity_state_owner: z.literal('cloudflare'), durable_engine: z.literal('cloudflare-workflows'),
    target: cloudflareWorkflowTargetSchema,
    team_id: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/),
    role_id: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/),
  }).strict(),
  activation_authority_granted: z.literal(false),
}).strict().superRefine((value, ctx) => {
  if (sha256Digest(value.target) !== value.target_digest_sha256) ctx.addIssue({ code: 'custom', message: 'Ownership target digest differs.' });
  if (sha256Digest(value.workflow_context) !== value.workflow_context_digest_sha256
    || sha256Digest(value.workflow_context.target) !== value.target_digest_sha256) {
    ctx.addIssue({ code: 'custom', message: 'Ownership target is not bound to the approved workflow context.' });
  }
  const envelope = { schema_version: 'starlight.workflow_operation_envelope.v1',
    operation_binding_digest_sha256: value.binding_digest_sha256,
    workflow_context_digest_sha256: value.workflow_context_digest_sha256, workflow_target: value.target };
  if (sha256Digest(envelope) !== value.envelope_digest_sha256) ctx.addIssue({ code: 'custom', message: 'Ownership envelope digest differs.' });
});
export type WorkflowInstanceOwnership = z.infer<typeof workflowInstanceOwnershipSchema>;

/** Strict immutable recovery data. Self-consistent JSON does not grant registration or execution. */
export function parseWorkflowInstanceOwnership(input: unknown): WorkflowInstanceOwnership {
  const parsed = workflowInstanceOwnershipSchema.parse(input);
  Object.freeze(parsed.target); Object.freeze(parsed.workflow_context.target);
  Object.freeze(parsed.workflow_context); return Object.freeze(parsed);
}
export function deriveWorkflowInstanceOwnership(operation: unknown): WorkflowInstanceOwnership {
  if (!isIssuedCloudflareWorkflowOperation(operation)) throw new Error('Workflow operation was not issued by the verified binding pipeline.');
  return parseWorkflowInstanceOwnership({ schema_version: 'starlight.workflow_instance_ownership.v1',
    operation_id: operation.binding.operation_id, binding_digest_sha256: sha256Digest(operation.binding),
    workflow_context_digest_sha256: operation.binding.context_digest_sha256,
    target_digest_sha256: sha256Digest(operation.context.target),
    envelope_digest_sha256: sha256Digest(cloudflareWorkflowOperationEnvelope(operation)),
    target: operation.context.target, workflow_context: operation.context, activation_authority_granted: false });
}
export type WorkflowInstanceOwnershipReadResult =
  | { found: true; ownership: WorkflowInstanceOwnership; registered_at: string;
    prepared_state: 'ready' | 'cancelled'; execution_authority_granted: false; blockers: [] }
  | { found: false; ownership: null; execution_authority_granted: false; blockers: string[] };
