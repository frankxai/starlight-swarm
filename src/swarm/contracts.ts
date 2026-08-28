/**
 * contracts.ts — the public export surface other Starlight repos should import.
 *
 * This is the anti-monorepo move: publish the contract, pin the commit, keep
 * runtimes in their own repos. Nothing here activates a worker.
 */

export { classify, requiresHuman } from './escalation';
export type { Action, Classification, Decision, StreamId } from './escalation';

export {
  BENEVOLENCE_CHARTER,
  checkCharter,
  explain,
  raiseTo,
} from './charter';
export type { CharterContext, ClauseId } from './charter';

export { parseHandContract } from './hand-contract';

export { KERNEL_PIN, KERNEL_VERSION, canonicalL6, kernelOverview } from './kernel';
export type { KernelMember, KernelPin, WiringPosture } from './kernel';

export { ABSORPTION_LEDGER, absorptionOverview } from './absorption';
export type { AbsorbedPrimitive, AbsorptionDisposition } from './absorption';

export { SUCCESS_CRITERIA, successOverview } from './success-criteria';
export type { SuccessCriterion } from './success-criteria';

export { observatorySnapshot } from './observatory';
export type { ObservatorySnapshot } from './observatory';

export { swarmTree, STREAMS, FOUNDER } from './streams';
