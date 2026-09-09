/**
 * `xcrun simctl` driver.
 *
 * Ported from:
 *   - expo/expo packages/@expo/cli/src/start/platforms/ios/simctl.ts @ d461c0835dfdc9fad1688cf5c7c234a3c36b240e (MIT)
 *   - expo/expo packages/@expo/cli/src/start/platforms/ios/xcrun.ts   @ d461c0835dfdc9fad1688cf5c7c234a3c36b240e (MIT)
 *   - expo/orbit packages/eas-shared/src/run/ios/simulator.ts         @ 48826627396a4c40d218d2a7f6483cc09c86f5d1 (MIT)
 *
 * This is a port rather than a vendored copy: the device-list parsing, the "already Booted" and
 * "No such file or directory" error probes, the transient-state install retry, and the xcrun
 * license / xcode-select diagnostics come from those files; the surface is routeshot's `Simulator`
 * interface and every failure is raised as a RouteshotError.
 */

import spawnAsync from '@expo/spawn-async';
import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delayAsync } from 'node:timers/promises';

import { RouteshotError } from './errors.js';
import type { LaunchOptions, Simulator, SimulatorDevice } from './types.js';

/** simctl reports state as a free-form string; these are the ones we model. */
const DEVICE_STATES = new Set(['Booted', 'Shutdown', 'Shutting Down', 'Booting']);

const BOOT_TIMEOUT_MS = 120_000;
const BOOT_POLL_INTERVAL_MS = 500;
const INSTALL_MAX_ATTEMPTS = 3;
const INSTALL_RETRY_DELAY_MS = 2_000;
/** SpringBoard relaunches itself after `launchctl stop`; the home screen is back within ~2s. */
const SPRINGBOARD_RESTART_MS = 3_000;
const SCHEME_APPROVAL_DOMAIN = 'com.apple.launchservices.schemeapproval';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

interface SimctlDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable?: boolean;
}

export class SimctlSimulator implements Simulator {
  async listDevicesAsync(): Promise<SimulatorDevice[]> {
    const { stdout } = await xcrunAsync(['simctl', 'list', 'devices', '--json']);

    let parsed: { devices?: Record<string, SimctlDevice[]> };
    try {
      parsed = JSON.parse(stdout);
    } catch (error) {
      // Observed when Xcode wants the command line tools updated: simctl prints a prose prompt.
      throw new RouteshotError('SIMULATOR', `simctl returned malformed JSON:\n${stdout}`, {
        cause: error,
      });
    }

    const devices: SimulatorDevice[] = [];
    for (const [runtimeId, entries] of Object.entries(parsed.devices ?? {})) {
      // 'com.apple.CoreSimulator.SimRuntime.iOS-26-5' -> ['iOS', '26', '5']
      const suffix = runtimeId.split('com.apple.CoreSimulator.SimRuntime.').pop();
      const [osType, ...versionParts] = (suffix ?? '').split('-');
      if (osType !== 'iOS') {
        continue;
      }
      for (const entry of entries) {
        if (entry.isAvailable === false) {
          continue;
        }
        devices.push({
          udid: entry.udid,
          name: entry.name,
          runtime: `iOS ${versionParts.join('.')}`,
          state: DEVICE_STATES.has(entry.state)
            ? (entry.state as SimulatorDevice['state'])
            : 'Shutdown',
        });
      }
    }
    return devices;
  }

  async bootAsync(udid: string): Promise<void> {
    try {
      await xcrunAsync(['simctl', 'boot', udid]);
    } catch (error) {
      // Booting an already-booted device is the normal case on a second `capture` run.
      if (!describeError(error).includes('Unable to boot device in current state: Booted')) {
        throw error;
      }
    }

    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const device = (await this.listDevicesAsync()).find((candidate) => candidate.udid === udid);
      if (device?.state === 'Booted') {
        return;
      }
      await delayAsync(BOOT_POLL_INTERVAL_MS);
    }
    throw new RouteshotError(
      'SIMULATOR',
      `Simulator ${udid} did not reach the Booted state within ${BOOT_TIMEOUT_MS / 1000}s.`
    );
  }

  async installAsync(udid: string, appPath: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await xcrunAsync(['simctl', 'install', udid, appPath]);
        return;
      } catch (error) {
        const message = describeError(error);
        const isTransient =
          /Unable to lookup in current state|Unable to boot device in current state|CoreSimulator\.SimError/.test(
            message
          );
        if (!isTransient || attempt >= INSTALL_MAX_ATTEMPTS) {
          throw error;
        }
        await delayAsync(INSTALL_RETRY_DELAY_MS);
      }
    }
  }

  async isInstalledAsync(udid: string, bundleId: string): Promise<boolean> {
    try {
      await xcrunAsync(['simctl', 'get_app_container', udid, bundleId]);
      return true;
    } catch (error) {
      if (/No such file or directory|not find|No such application/i.test(describeError(error))) {
        return false;
      }
      throw error;
    }
  }

  async launchAsync(udid: string, bundleId: string, options?: LaunchOptions): Promise<void> {
    // simctl passes environment through to the app only under the SIMCTL_CHILD_ prefix.
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(options?.env ?? {})) {
      childEnv[`SIMCTL_CHILD_${key}`] = value;
    }

    await xcrunAsync(
      [
        'simctl',
        'launch',
        '--terminate-running-processes',
        udid,
        bundleId,
        ...(options?.args ?? []),
      ],
      Object.keys(childEnv).length > 0 ? { env: { ...process.env, ...childEnv } } : undefined
    );
  }

  async terminateAsync(udid: string, bundleId: string): Promise<void> {
    try {
      await xcrunAsync(['simctl', 'terminate', udid, bundleId]);
    } catch (error) {
      // Terminating an app that is not running is the expected state before the first launch.
      if (!/found nothing to terminate|No such process|not running/i.test(describeError(error))) {
        throw error;
      }
    }
  }

  async openUrlAsync(udid: string, url: string): Promise<void> {
    await xcrunAsync(['simctl', 'openurl', udid, url]);
  }

  async screenshotAsync(udid: string): Promise<Uint8Array> {
    const streamed = await screenshotToStdoutAsync(udid);
    if (streamed) {
      return streamed;
    }

    // Xcode has shipped builds where `-` writes nothing to a piped stdout. Round-trip a temp file.
    const file = path.join(os.tmpdir(), `routeshot-${udid}-${Date.now()}.png`);
    await xcrunAsync(['simctl', 'io', udid, 'screenshot', '--type=png', file]);
    try {
      return await fs.readFile(file);
    } finally {
      await fs.rm(file, { force: true });
    }
  }

  async setAppearanceAsync(udid: string, appearance: 'light' | 'dark'): Promise<void> {
    await xcrunAsync(['simctl', 'ui', udid, 'appearance', appearance]);
  }

  async approveUrlSchemeAsync(udid: string, scheme: string, bundleId: string): Promise<void> {
    // iOS 26 asks "Open in <App>?" for every `simctl openurl` until the scheme is approved for
    // the CoreSimulatorBridge client. The approval lives in a defaults domain SpringBoard reads
    // once at launch, so a change only takes effect after SpringBoard restarts.
    const key = `com.apple.CoreSimulator.CoreSimulatorBridge-->${scheme}`;
    if ((await readDefaultAsync(udid, SCHEME_APPROVAL_DOMAIN, key)) === bundleId) {
      return;
    }
    await xcrunAsync([
      'simctl',
      'spawn',
      udid,
      'defaults',
      'write',
      SCHEME_APPROVAL_DOMAIN,
      key,
      '-string',
      bundleId,
    ]);
    await xcrunAsync(['simctl', 'spawn', udid, 'launchctl', 'stop', 'com.apple.SpringBoard']);
    await delayAsync(SPRINGBOARD_RESTART_MS);
  }

  async configureDevMenuAsync(udid: string, bundleId: string): Promise<void> {
    // expo-dev-menu keeps its preferences in the app's own defaults domain (DevMenuPreferences.swift).
    for (const [key, value] of [
      ['EXDevMenuIsOnboardingFinished', 'YES'],
      ['EXDevMenuShowFloatingActionButton', 'NO'],
    ] as const) {
      await xcrunAsync([
        'simctl',
        'spawn',
        udid,
        'defaults',
        'write',
        bundleId,
        key,
        '-bool',
        value,
      ]);
    }
  }

  async overrideStatusBarAsync(udid: string): Promise<void> {
    // Frozen clock, full bars, charged battery: everything here would otherwise diff every run.
    await xcrunAsync([
      'simctl',
      'status_bar',
      udid,
      'override',
      '--time',
      '9:41',
      '--dataNetwork',
      'wifi',
      '--wifiMode',
      'active',
      '--wifiBars',
      '3',
      '--cellularMode',
      'active',
      '--cellularBars',
      '4',
      '--batteryState',
      'charged',
      '--batteryLevel',
      '100',
    ]);
  }
}

async function readDefaultAsync(
  udid: string,
  domain: string,
  key: string
): Promise<string | undefined> {
  try {
    const { stdout } = await xcrunAsync(['simctl', 'spawn', udid, 'defaults', 'read', domain, key]);
    return stdout.trim();
  } catch {
    // `defaults read` exits 1 when the key does not exist yet, which is the common first-run case.
    return undefined;
  }
}

/**
 * Choose the device to capture on: whatever is already booted, else the requested name, else the
 * newest iPhone runtime.
 */
export async function pickDeviceAsync(
  sim: Simulator,
  preferredName?: string
): Promise<SimulatorDevice> {
  const devices = await sim.listDevicesAsync();

  const booted = devices.find((device) => device.state === 'Booted');
  if (booted && (!preferredName || booted.name === preferredName)) {
    return booted;
  }

  if (preferredName) {
    const named = devices
      .filter((device) => device.name === preferredName)
      .sort((a, b) => compareRuntimes(b.runtime, a.runtime))[0];
    if (named) {
      return named;
    }
    throw new RouteshotError(
      'NO_DEVICE',
      `No iOS simulator named "${preferredName}".\n${formatDeviceList(devices)}`
    );
  }

  const newestIphone = devices
    .filter((device) => device.name.startsWith('iPhone'))
    .sort((a, b) => compareRuntimes(b.runtime, a.runtime))[0];
  if (newestIphone) {
    return newestIphone;
  }

  throw new RouteshotError(
    'NO_DEVICE',
    `No iOS simulators are available. Open Xcode > Settings > Components and install an iOS runtime.\n${formatDeviceList(devices)}`
  );
}

function formatDeviceList(devices: SimulatorDevice[]): string {
  if (devices.length === 0) {
    return 'xcrun simctl reported no available iOS devices.';
  }
  return ['Available devices:', ...devices.map((d) => `  ${d.name} (${d.runtime}) ${d.udid}`)].join(
    '\n'
  );
}

/** 'iOS 26.5' vs 'iOS 18.0', numerically, so 9 sorts below 18. */
function compareRuntimes(a: string, b: string): number {
  const parse = (value: string) => (value.match(/\d+/g) ?? []).map(Number);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/** Returns the PNG bytes, or undefined when stdout produced nothing usable. */
async function screenshotToStdoutAsync(udid: string): Promise<Uint8Array | undefined> {
  const args = ['simctl', 'io', udid, 'screenshot', '--type=png', '-'];
  const promise = spawnAsync('xcrun', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  // The result's `stdout` is utf8-decoded, which destroys PNG bytes, so read the raw stream.
  const chunks: Buffer[] = [];
  promise.child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));

  try {
    await promise;
  } catch (error) {
    throw toSimulatorError(error, args);
  }

  const bytes = Buffer.concat(chunks);
  return bytes.length > 8 && bytes.subarray(0, 4).equals(PNG_MAGIC) ? bytes : undefined;
}

async function xcrunAsync(
  args: string[],
  options?: { env?: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await spawnAsync('xcrun', args, { stdio: 'pipe', ...options });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    throw toSimulatorError(error, args);
  }
}

function toSimulatorError(error: unknown, args: string[]): RouteshotError {
  const { stdout, stderr } = readSpawnStreams(error);
  const combined = `${stdout}\n${stderr}`;

  if (/xcode/i.test(combined) && /license/i.test(combined)) {
    return new RouteshotError(
      'SIMULATOR',
      `Xcode's license has not been accepted. Run \`sudo xcodebuild -license\` and try again.\n${stderr.trim()}`,
      { cause: error }
    );
  }
  if (combined.includes('not a developer tool or in PATH')) {
    return new RouteshotError(
      'SIMULATOR',
      `xcrun cannot find simctl. Run \`sudo xcode-select -s /Applications/Xcode.app\` and try again.\n${stderr.trim()}`,
      { cause: error }
    );
  }

  const detail = stderr.trim() || stdout.trim() || describeError(error);
  return new RouteshotError('SIMULATOR', `xcrun ${args.join(' ')} failed.\n${detail}`, {
    cause: error,
  });
}

function readSpawnStreams(error: unknown): { stdout: string; stderr: string } {
  const candidate = error as { stdout?: unknown; stderr?: unknown };
  return {
    stdout: typeof candidate?.stdout === 'string' ? candidate.stdout : '',
    stderr: typeof candidate?.stderr === 'string' ? candidate.stderr : '',
  };
}

function describeError(error: unknown): string {
  const { stdout, stderr } = readSpawnStreams(error);
  const message = error instanceof Error ? error.message : String(error);
  return `${message}\n${stdout}\n${stderr}`;
}
