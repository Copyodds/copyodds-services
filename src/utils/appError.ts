import { Code } from './response';

export type AppErrorOptions = {
  code: number;
  httpStatus: number;
  message: string;
  details?: unknown;
  expose?: boolean;
  cause?: unknown;
};

export class AppError extends Error {
  readonly code: number;
  readonly httpStatus: number;
  readonly details?: unknown;
  readonly expose: boolean;
  readonly cause?: unknown;

  constructor(options: AppErrorOptions) {
    super(options.message);
    this.name = 'AppError';
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.details = options.details;
    this.expose = options.expose ?? options.httpStatus < 500;
    this.cause = options.cause;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function createAppError(options: AppErrorOptions): AppError {
  return new AppError(options);
}

export function createValidationError(details?: unknown, message = 'Validation failed'): AppError {
  return createAppError({
    code: Code.VALIDATION_FAILED,
    httpStatus: 400,
    message,
    details,
  });
}

export function createConflictError(message: string, details?: unknown): AppError {
  return createAppError({
    code: Code.STATE_CONFLICT,
    httpStatus: 409,
    message,
    details,
  });
}

export function createForbiddenError(message: string, details?: unknown): AppError {
  return createAppError({
    code: Code.FORBIDDEN,
    httpStatus: 403,
    message,
    details,
  });
}
