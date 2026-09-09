import pc from 'picocolors';

/**
 * All human-facing output goes to stderr so `--json` can own stdout.
 * Mirrors the shape of eas-cli's Log module: no console.log anywhere else in the package.
 */
let jsonMode = false;

export function enableJsonOutput(): void {
  jsonMode = true;
}

export function isJsonOutput(): boolean {
  return jsonMode;
}

function write(line: string): void {
  process.stderr.write(`${line}\n`);
}

export const Log = {
  log(message: string): void {
    write(message);
  },
  succeed(message: string): void {
    write(`${pc.green('✔')} ${message}`);
  },
  warn(message: string): void {
    write(pc.yellow(`⚠ ${message}`));
  },
  error(message: string): void {
    write(pc.red(`✖ ${message}`));
  },
  gray(message: string): void {
    write(pc.gray(message));
  },
  /** Machine-readable result. Only call once, at the end of a command. */
  json(value: unknown): void {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  },
};
