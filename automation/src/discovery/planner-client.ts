import type {
  DiscoveryGoalType,
  DiscoveryObservationType,
  DiscoveryProposalType,
} from '../domain/discovery.js';
import { DiscoveryProposal } from '../domain/discovery.js';

export type PlannerFailureCode =
  'AUTHENTICATION' | 'RATE_LIMIT' | 'TIMEOUT' | 'REFUSAL' | 'MALFORMED_OUTPUT' | 'PROVIDER_ERROR';

export class PlannerFailure extends Error {
  constructor(
    readonly code: PlannerFailureCode,
    message: string,
    readonly retryable: boolean,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'PlannerFailure';
  }
}

export interface PlannerRequest {
  readonly goal: DiscoveryGoalType;
  readonly observation: DiscoveryObservationType;
  readonly previousResult?: Readonly<Record<string, unknown>>;
  readonly remaining: {
    readonly modelCalls: number;
    readonly actions: number;
    readonly timeMs: number;
  };
  readonly traceSummary: readonly string[];
}

export interface PlannerResponse {
  readonly proposal: DiscoveryProposalType;
  readonly provider: string;
  readonly model: string;
  readonly requestId?: string;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
}

export interface PlannerClient {
  propose(request: PlannerRequest, signal?: AbortSignal): Promise<PlannerResponse>;
}

export class ScriptedPlannerClient implements PlannerClient {
  private index = 0;
  constructor(
    private readonly decisions:
      readonly unknown[] | ((request: PlannerRequest, call: number) => unknown | Promise<unknown>),
  ) {}

  async propose(request: PlannerRequest): Promise<PlannerResponse> {
    const call = this.index++;
    const raw =
      typeof this.decisions === 'function'
        ? await this.decisions(request, call)
        : this.decisions[call];
    if (raw instanceof PlannerFailure) throw raw;
    const parsed = DiscoveryProposal.safeParse(raw);
    if (!parsed.success)
      throw new PlannerFailure(
        'MALFORMED_OUTPUT',
        'Scripted planner returned invalid output',
        false,
      );
    return { proposal: parsed.data, provider: 'scripted', model: 'deterministic-test' };
  }
}
