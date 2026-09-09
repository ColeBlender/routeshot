/**
 * One error class with a machine-readable code, in the spirit of @expo/cli's CommandError.
 * Commands throw; the CLI entry maps the code to an exit status. Never log-and-return.
 */
export type ErrorCode =
  | 'CONFIG'
  | 'NO_DEVICE'
  | 'SIMULATOR'
  | 'ROUTES'
  | 'CAPTURE'
  | 'COMPARE'
  | 'UPLOAD'
  | 'JUDGE'
  | 'DIFF_FOUND'
  | 'DEFECT_FOUND';

export class RouteshotError extends Error {
  override readonly name = 'RouteshotError';

  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
  }
}

export function isRouteshotError(value: unknown): value is RouteshotError {
  return value instanceof RouteshotError;
}
