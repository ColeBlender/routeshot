/**
 * One structured JSON line per event on stdout. Railway ships stdout to its log drain, and JSON
 * keeps the request log queryable there. This is the only module in the package allowed to write
 * to stdout; everything else takes a `Logger` so tests can capture output instead of printing it.
 */
export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

function emit(level: LogLevel, message: string, fields: Record<string, unknown> | undefined): void {
  process.stdout.write(
    `${JSON.stringify({ level, time: new Date().toISOString(), message, ...fields })}\n`
  );
}

export const Log: Logger = {
  info(message, fields) {
    emit('info', message, fields);
  },
  warn(message, fields) {
    emit('warn', message, fields);
  },
  error(message, fields) {
    emit('error', message, fields);
  },
};

/** Drops everything. Used by tests so a run does not spray JSON into the reporter. */
export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
