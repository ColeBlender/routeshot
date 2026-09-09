/**
 * One error class carrying an HTTP status and a machine-readable code, mirroring the CLI's
 * `RouteshotError`. Handlers throw; `createApp`'s onError maps the code to a JSON body.
 * Never log-and-return (the judge is the single documented exception, see judge.ts).
 */
export type ServerErrorCode =
  | 'UNAUTHORIZED'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'CONFIG'
  | 'STORAGE';

const STATUS: Record<ServerErrorCode, number> = {
  UNAUTHORIZED: 401,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  CONFIG: 500,
  STORAGE: 500,
};

export class ServerError extends Error {
  override readonly name = 'ServerError';
  readonly status: number;

  constructor(
    readonly code: ServerErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.status = STATUS[code];
  }
}

export function isServerError(value: unknown): value is ServerError {
  return value instanceof ServerError;
}
