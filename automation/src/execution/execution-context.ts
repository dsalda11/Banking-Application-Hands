import type { Logger } from 'pino';
import type { DataShapeType } from '../domain/data-shapes.js';

/** Runtime-only values supplied to one isolated surface run. */
export interface ExecutionContext {
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly secrets: Readonly<Record<string, string>>;
  readonly outputs: Record<string, unknown>;
  readonly baseUrl: string;
  readonly outputShapes?: Readonly<Record<string, DataShapeType>>;
  readonly runId: string;
  readonly stepId?: string;
  readonly logger?: Logger;
}
