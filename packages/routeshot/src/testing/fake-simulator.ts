/**
 * In-memory `Simulator` for tests. Records every call, hands back scripted PNG frames, and never
 * shells out, so capture/settle/diff can be exercised without Xcode.
 */

import { Buffer } from 'node:buffer';
import zlib from 'node:zlib';

import { RouteshotError } from '../errors.js';
import type { LaunchOptions, Simulator, SimulatorDevice } from '../types.js';

export type FakeSimulatorMethod = keyof Simulator;

export interface FakeSimulatorCall {
  method: FakeSimulatorMethod;
  args: unknown[];
}

export interface FakeSimulatorOptions {
  devices?: SimulatorDevice[];
  /** Bundle ids that `isInstalledAsync` should report as present. */
  installed?: string[];
  /**
   * Frames handed out by successive `screenshotAsync` calls. The last frame repeats forever, so
   * `[a, a, b, b, b]` settles on `b` and `[a]` is a screen that never changes.
   */
  frames?: Uint8Array[];
}

const DEFAULT_DEVICES: SimulatorDevice[] = [
  { udid: 'FAKE-UDID-0001', name: 'iPhone 17 Pro', runtime: 'iOS 26.5', state: 'Shutdown' },
  { udid: 'FAKE-UDID-0002', name: 'iPhone 17', runtime: 'iOS 26.5', state: 'Shutdown' },
  { udid: 'FAKE-UDID-0003', name: 'iPhone 16', runtime: 'iOS 18.4', state: 'Shutdown' },
];

export class FakeSimulator implements Simulator {
  readonly calls: FakeSimulatorCall[] = [];
  devices: SimulatorDevice[];

  readonly #installed: Set<string>;
  #frames: Uint8Array[];
  #frameIndex = 0;
  readonly #failures = new Map<FakeSimulatorMethod, Error>();

  constructor(options: FakeSimulatorOptions = {}) {
    this.devices = (options.devices ?? DEFAULT_DEVICES).map((device) => ({ ...device }));
    this.#installed = new Set(options.installed ?? []);
    this.#frames = options.frames ?? [makeFakePng({ color: [10, 20, 30, 255] })];
  }

  /**
   * Replace the scripted frame sequence and rewind. `[a, a, b, b]` models a screen that changes
   * once and then holds still, which is what settle detection is looking for.
   */
  setFrames(frames: Uint8Array[]): void {
    if (frames.length === 0) {
      throw new RouteshotError('CAPTURE', 'FakeSimulator needs at least one frame.');
    }
    this.#frames = frames;
    this.#frameIndex = 0;
  }

  /** Make the next call to `method` reject. Cleared once it fires. */
  failNext(method: FakeSimulatorMethod, error: Error): void {
    this.#failures.set(method, error);
  }

  /** Calls to one method, in order, for assertions like `fake.callsTo('openUrlAsync')`. */
  callsTo(method: FakeSimulatorMethod): FakeSimulatorCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  reset(): void {
    this.calls.length = 0;
    this.#frameIndex = 0;
  }

  #record(method: FakeSimulatorMethod, ...args: unknown[]): void {
    this.calls.push({ method, args });
    const failure = this.#failures.get(method);
    if (failure) {
      this.#failures.delete(method);
      throw failure;
    }
  }

  async listDevicesAsync(): Promise<SimulatorDevice[]> {
    this.#record('listDevicesAsync');
    return this.devices.map((device) => ({ ...device }));
  }

  async bootAsync(udid: string): Promise<void> {
    this.#record('bootAsync', udid);
    const device = this.devices.find((candidate) => candidate.udid === udid);
    if (!device) {
      throw new RouteshotError('NO_DEVICE', `FakeSimulator has no device ${udid}.`);
    }
    device.state = 'Booted';
  }

  async installAsync(udid: string, appPath: string): Promise<void> {
    this.#record('installAsync', udid, appPath);
  }

  async isInstalledAsync(udid: string, bundleId: string): Promise<boolean> {
    this.#record('isInstalledAsync', udid, bundleId);
    return this.#installed.has(bundleId);
  }

  async launchAsync(udid: string, bundleId: string, options?: LaunchOptions): Promise<void> {
    this.#record('launchAsync', udid, bundleId, options);
    this.#installed.add(bundleId);
  }

  async terminateAsync(udid: string, bundleId: string): Promise<void> {
    this.#record('terminateAsync', udid, bundleId);
  }

  async approveUrlSchemeAsync(udid: string, scheme: string, bundleId: string): Promise<void> {
    this.#record('approveUrlSchemeAsync', udid, scheme, bundleId);
  }

  async configureDevMenuAsync(udid: string, bundleId: string): Promise<void> {
    this.#record('configureDevMenuAsync', udid, bundleId);
  }

  async openUrlAsync(udid: string, url: string): Promise<void> {
    this.#record('openUrlAsync', udid, url);
  }

  async screenshotAsync(udid: string): Promise<Uint8Array> {
    this.#record('screenshotAsync', udid);
    const frame = this.#frames[Math.min(this.#frameIndex, this.#frames.length - 1)]!;
    this.#frameIndex++;
    return frame;
  }

  async setAppearanceAsync(udid: string, appearance: 'light' | 'dark'): Promise<void> {
    this.#record('setAppearanceAsync', udid, appearance);
  }

  async overrideStatusBarAsync(udid: string): Promise<void> {
    this.#record('overrideStatusBarAsync', udid);
  }
}

/**
 * A real, decodable solid-colour RGBA PNG, so tests can run these frames through sharp and
 * pixelmatch instead of asserting on opaque byte blobs.
 */
export function makeFakePng(options: {
  color: [number, number, number, number];
  width?: number;
  height?: number;
}): Uint8Array {
  const width = options.width ?? 8;
  const height = options.height ?? 8;

  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < width; x++) {
      raw.set(options.color, rowStart + 1 + x * 4);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
