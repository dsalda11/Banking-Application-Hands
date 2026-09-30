import { ErrorDetail, type ErrorDetailType } from '../domain/errors.js';

export type SurfaceErrorCode =
  | 'SURFACE_NOT_STARTED'
  | 'SURFACE_ALREADY_STARTED'
  | 'INVALID_SURFACE_STATE'
  | 'NAVIGATION_OUTSIDE_ALLOWED_ORIGIN'
  | 'NAVIGATION_TIMEOUT'
  | 'ACTION_TIMEOUT'
  | 'LOCATOR_NOT_FOUND'
  | 'LOCATOR_AMBIGUOUS'
  | 'UNSUPPORTED_LOCATOR_STRATEGY'
  | 'INVALID_LOCATOR'
  | 'ELEMENT_NOT_EDITABLE'
  | 'OPTION_NOT_FOUND'
  | 'INPUT_VALUE_MISSING'
  | 'SECRET_VALUE_MISSING'
  | 'EXTRACTION_FAILED'
  | 'TRANSFORM_FAILED'
  | 'CHECKPOINT_FAILED'
  | 'UNSUPPORTED_CHECKPOINT'
  | 'UNEXPECTED_DIALOG'
  | 'BROWSER_LAUNCH_FAILED'
  | 'SESSION_EXPIRED'
  | 'PERMISSION_DENIED';

export class SurfaceError extends Error {
  constructor(
    readonly code: SurfaceErrorCode,
    message: string,
    readonly retryable = false,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SurfaceError';
  }
  toErrorDetail(stepId?: string): ErrorDetailType {
    const category =
      this.code.includes('LOCATOR') || this.code.includes('ELEMENT')
        ? 'target'
        : this.code.includes('TIMEOUT')
          ? 'timeout'
          : this.code.includes('CHECKPOINT')
            ? 'checkpoint'
            : this.code.includes('SECRET') || this.code.includes('INPUT')
              ? 'session'
              : 'application';
    return ErrorDetail.parse({
      category,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      evidence: [],
      ...(stepId ? { stepId } : {}),
    });
  }
}
