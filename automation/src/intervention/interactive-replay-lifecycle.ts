import type { RunResultType } from '../domain/run-result.js';
import type { OperatorInterventionCoordinator } from './intervention-coordinator.js';

export type ShutdownSignal = 'SIGINT' | 'SIGTERM';

export interface SignalSource {
  on(signal: ShutdownSignal, listener: () => void): void;
  off(signal: ShutdownSignal, listener: () => void): void;
}

export interface InteractiveReplayLifecycleOptions {
  readonly signalSource: SignalSource;
  readonly createCoordinator: (
    onOperatorUrl: (url: string) => void,
  ) => OperatorInterventionCoordinator;
  readonly runReplay: (
    coordinator: OperatorInterventionCoordinator,
    cancellationSignal: AbortSignal,
    interruptionSource: () => ShutdownSignal | undefined,
  ) => Promise<RunResultType>;
  readonly outputOperatorUrl: (url: string) => void;
  readonly setExitCode: (code: number) => void;
}

/** Owns one interactive invocation, including signals and idempotent cleanup. */
export class InteractiveReplayLifecycle {
  private readonly cancellation = new AbortController();
  private coordinator: OperatorInterventionCoordinator | undefined;
  private interruptionSource: ShutdownSignal | undefined;
  private cleanupPromise: Promise<void> | undefined;
  private started = false;
  private readonly handlers: Record<ShutdownSignal, () => void>;

  constructor(private readonly options: InteractiveReplayLifecycleOptions) {
    this.handlers = {
      SIGINT: () => void this.requestShutdown('SIGINT'),
      SIGTERM: () => void this.requestShutdown('SIGTERM'),
    };
  }

  async run(): Promise<RunResultType> {
    if (this.started) throw new Error('Interactive replay lifecycle may run only once');
    this.started = true;
    this.options.signalSource.on('SIGINT', this.handlers.SIGINT);
    this.options.signalSource.on('SIGTERM', this.handlers.SIGTERM);
    this.coordinator = this.options.createCoordinator(this.options.outputOperatorUrl);
    try {
      const result = await this.options.runReplay(
        this.coordinator,
        this.cancellation.signal,
        () => this.interruptionSource,
      );
      this.options.setExitCode(this.exitCode(result));
      return result;
    } finally {
      await this.cleanup();
    }
  }

  async requestShutdown(source: ShutdownSignal): Promise<void> {
    if (this.interruptionSource) return;
    this.interruptionSource = source;
    this.cancellation.abort(source);
    await this.coordinator?.interrupt(source);
  }

  cleanup(): Promise<void> {
    this.cleanupPromise ??= (async () => {
      this.options.signalSource.off('SIGINT', this.handlers.SIGINT);
      this.options.signalSource.off('SIGTERM', this.handlers.SIGTERM);
      await this.coordinator?.close();
    })();
    return this.cleanupPromise;
  }

  private exitCode(result: RunResultType): number {
    if (result.status === 'interrupted') return result.signal === 'SIGINT' ? 130 : 143;
    if (result.status === 'failure') return 1;
    if (result.status === 'businessOutcome') return 2;
    if (result.status === 'permissionDenied') return 3;
    if (result.status === 'needsHuman') return 4;
    if (result.status === 'aborted') return 5;
    return 0;
  }
}

export const processSignalSource: SignalSource = {
  on: (signal, listener) => process.on(signal, listener),
  off: (signal, listener) => process.off(signal, listener),
};
