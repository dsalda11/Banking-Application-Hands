import type { CheckpointType } from '../domain/checkpoints.js';
import type { CapabilityActionType } from '../domain/actions.js';
import type { DiscoveryObservationType } from '../domain/discovery.js';
import type { EvidenceReferenceType } from '../domain/evidence.js';
import type { ExecutionContext } from '../execution/execution-context.js';
import type { SurfaceError } from './surface-errors.js';

export interface SurfaceStartOptions {
  readonly baseUrl: string;
  readonly headless?: boolean;
  readonly runId: string;
  readonly evidenceDirectory: string;
  readonly timeoutMs?: number;
  readonly viewport?: { readonly width: number; readonly height: number };
}
export interface ScreenshotOptions {
  readonly name?: string;
  readonly fullPage?: boolean;
}
export interface TraceOptions {
  readonly name?: string;
}
export interface SurfaceEvent {
  readonly timestamp: string;
  readonly runId?: string;
  readonly interventionId?: string;
  readonly generation?: number;
  readonly coordinatorRevision?: number;
  readonly eventType?: string;
  readonly stepId?: string;
  readonly action: string;
  readonly attempt?: number;
  readonly risk?: string;
  readonly policyDecision?: string;
  readonly policyId?: string;
  readonly policyVersion?: string;
  readonly policyHash?: string;
  readonly matchingRuleId?: string;
  readonly reason?: string;
  readonly expected?: unknown;
  readonly observed?: unknown;
  readonly recoveryId?: string;
  readonly locatorStrategy?: string;
  readonly durationMs?: number;
  readonly ok: boolean;
  readonly errorCode?: string;
}
export interface ResolvedTargetFacts {
  readonly strategy: string;
  readonly candidateIndex: number;
  readonly framePath: string[];
  readonly description: string;
}
export interface SurfaceActionResult {
  readonly ok: boolean;
  readonly action: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly url: string;
  readonly target?: ResolvedTargetFacts;
  readonly output?: { readonly name: string; readonly value: unknown };
  readonly evidence?: readonly EvidenceReferenceType[];
  readonly error?: SurfaceError;
}
export interface CheckpointEvaluationResult {
  readonly passed: boolean;
  readonly kind: string;
  readonly description: string;
  readonly observedState: unknown;
  readonly durationMs: number;
  readonly target?: ResolvedTargetFacts;
  readonly error?: SurfaceError;
}
export interface SurfaceAdapter {
  start(options: SurfaceStartOptions): Promise<void>;
  observe(): Promise<DiscoveryObservationType>;
  execute(action: CapabilityActionType, context: ExecutionContext): Promise<SurfaceActionResult>;
  evaluateCheckpoint(
    checkpoint: CheckpointType,
    context: ExecutionContext,
  ): Promise<CheckpointEvaluationResult>;
  captureScreenshot(options?: ScreenshotOptions): Promise<EvidenceReferenceType>;
  startTrace(options?: TraceOptions): Promise<void>;
  stopTrace(): Promise<EvidenceReferenceType | undefined>;
  writeObservation(observation: DiscoveryObservationType): Promise<EvidenceReferenceType>;
  writeResult(result: unknown): Promise<EvidenceReferenceType>;
  writeEventLog(events: readonly SurfaceEvent[]): Promise<EvidenceReferenceType>;
  close(): Promise<void>;
}
