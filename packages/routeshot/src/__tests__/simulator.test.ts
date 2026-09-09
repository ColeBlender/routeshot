import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RouteshotError } from '../errors.js';
import { pickDeviceAsync, SimctlSimulator } from '../simulator.js';
import { FakeSimulator, makeFakePng } from '../testing/fake-simulator.js';
import type { SimulatorDevice } from '../types.js';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('@expo/spawn-async', () => ({ default: spawnMock }));

/** Shapes a resolved @expo/spawn-async result, including the `.child` the screenshot path reads. */
function resolves(stdout = '', stdoutBytes?: Uint8Array) {
  const stream = stdoutBytes ? Readable.from([Buffer.from(stdoutBytes)]) : null;
  const result = { stdout, stderr: '', status: 0, signal: null, output: [stdout, ''] };
  const promise = stream
    ? new Promise((resolve) => {
        stream.on('end', () => {
          resolve(result);
        });
      })
    : Promise.resolve(result);
  return Object.assign(promise, { child: { stdout: stream } });
}

function rejects(message: string, streams: { stdout?: string; stderr?: string } = {}) {
  const error = Object.assign(new Error(message), {
    stdout: streams.stdout ?? '',
    stderr: streams.stderr ?? '',
    status: 1,
    signal: null,
  });
  const promise = Promise.reject(error);
  promise.catch(() => {}); // keep the rejection handled until the code under test awaits it
  return Object.assign(promise, { child: { stdout: null } });
}

const DEVICE_LIST_JSON = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
      { udid: 'A1', name: 'iPhone 17 Pro', state: 'Booted', isAvailable: true },
      { udid: 'A2', name: 'iPhone 17', state: 'Shutdown', isAvailable: true },
      { udid: 'A3', name: 'iPhone Broken', state: 'Shutdown', isAvailable: false },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-18-4': [
      { udid: 'B1', name: 'iPhone 16', state: 'Shutdown', isAvailable: true },
    ],
    'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [
      { udid: 'W1', name: 'Apple Watch', state: 'Shutdown', isAvailable: true },
    ],
  },
});

function argvOf(callIndex: number): string[] {
  return spawnMock.mock.calls[callIndex]?.[1] as string[];
}

let sim: SimctlSimulator;

beforeEach(() => {
  spawnMock.mockReset();
  sim = new SimctlSimulator();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SimctlSimulator.listDevicesAsync', () => {
  it('lists iOS devices only, with parsed runtimes', async () => {
    spawnMock.mockReturnValue(resolves(DEVICE_LIST_JSON));

    const devices = await sim.listDevicesAsync();

    expect(spawnMock).toHaveBeenCalledWith('xcrun', ['simctl', 'list', 'devices', '--json'], {
      stdio: 'pipe',
    });
    expect(devices).toEqual([
      { udid: 'A1', name: 'iPhone 17 Pro', runtime: 'iOS 26.5', state: 'Booted' },
      { udid: 'A2', name: 'iPhone 17', runtime: 'iOS 26.5', state: 'Shutdown' },
      { udid: 'B1', name: 'iPhone 16', runtime: 'iOS 18.4', state: 'Shutdown' },
    ]);
  });

  it('throws SIMULATOR when simctl prints something that is not JSON', async () => {
    spawnMock.mockReturnValue(resolves('Please update the command line tools'));

    await expect(sim.listDevicesAsync()).rejects.toMatchObject({
      name: 'RouteshotError',
      code: 'SIMULATOR',
    });
  });
});

describe('SimctlSimulator.bootAsync', () => {
  it('boots and waits for the Booted state', async () => {
    spawnMock.mockReturnValueOnce(resolves('')).mockReturnValue(
      resolves(
        JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
              { udid: 'A2', name: 'iPhone 17', state: 'Booted', isAvailable: true },
            ],
          },
        })
      )
    );

    await sim.bootAsync('A2');

    expect(argvOf(0)).toEqual(['simctl', 'boot', 'A2']);
    expect(argvOf(1)).toEqual(['simctl', 'list', 'devices', '--json']);
  });

  it('is idempotent when the device is already booted', async () => {
    spawnMock
      .mockReturnValueOnce(
        rejects('exited with non-zero code: 149', {
          stderr: 'Unable to boot device in current state: Booted',
        })
      )
      .mockReturnValue(resolves(DEVICE_LIST_JSON));

    await expect(sim.bootAsync('A1')).resolves.toBeUndefined();
  });

  it('rethrows a real boot failure', async () => {
    spawnMock.mockReturnValue(rejects('boom', { stderr: 'Invalid device: nope' }));

    await expect(sim.bootAsync('nope')).rejects.toMatchObject({ code: 'SIMULATOR' });
  });
});

describe('SimctlSimulator.installAsync', () => {
  it('installs with the expected argv', async () => {
    spawnMock.mockReturnValue(resolves(''));

    await sim.installAsync('A1', '/tmp/App.app');

    expect(argvOf(0)).toEqual(['simctl', 'install', 'A1', '/tmp/App.app']);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('retries a transient CoreSimulator failure', { timeout: 15_000 }, async () => {
    spawnMock
      .mockReturnValueOnce(
        rejects('boom', { stderr: 'Unable to lookup in current state: Shutdown' })
      )
      .mockReturnValue(resolves(''));

    await sim.installAsync('A1', '/tmp/App.app');

    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a real failure', async () => {
    spawnMock.mockReturnValue(rejects('boom', { stderr: 'Failed to install: bad signature' }));

    await expect(sim.installAsync('A1', '/tmp/App.app')).rejects.toMatchObject({
      code: 'SIMULATOR',
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe('SimctlSimulator.isInstalledAsync', () => {
  it('is true when the container resolves', async () => {
    spawnMock.mockReturnValue(resolves('/path/to/App.app\n'));

    await expect(sim.isInstalledAsync('A1', 'dev.routeshot.example')).resolves.toBe(true);
    expect(argvOf(0)).toEqual(['simctl', 'get_app_container', 'A1', 'dev.routeshot.example']);
  });

  it('is false when the app is missing', async () => {
    spawnMock.mockReturnValue(
      rejects('boom', { stderr: 'No such file or directory: dev.routeshot.example' })
    );

    await expect(sim.isInstalledAsync('A1', 'dev.routeshot.example')).resolves.toBe(false);
  });

  it('rethrows anything else', async () => {
    spawnMock.mockReturnValue(rejects('boom', { stderr: 'Invalid device: A1' }));

    await expect(sim.isInstalledAsync('A1', 'dev.routeshot.example')).rejects.toMatchObject({
      code: 'SIMULATOR',
    });
  });
});

describe('SimctlSimulator.launchAsync', () => {
  it('terminates a running process and forwards launch args', async () => {
    spawnMock.mockReturnValue(resolves(''));

    await sim.launchAsync('A1', 'dev.routeshot.example', {
      args: ['--routeshot-update-url', 'https://u.expo.dev/x/group/y'],
    });

    expect(argvOf(0)).toEqual([
      'simctl',
      'launch',
      '--terminate-running-processes',
      'A1',
      'dev.routeshot.example',
      '--routeshot-update-url',
      'https://u.expo.dev/x/group/y',
    ]);
  });

  it('passes env through the SIMCTL_CHILD_ prefix', async () => {
    spawnMock.mockReturnValue(resolves(''));

    await sim.launchAsync('A1', 'dev.routeshot.example', { env: { ROUTESHOT_LABEL: 'main' } });

    const options = spawnMock.mock.calls[0]?.[2] as { env: Record<string, string> };
    expect(options.env['SIMCTL_CHILD_ROUTESHOT_LABEL']).toBe('main');
    expect(options.env['PATH']).toBe(process.env['PATH']);
  });
});

describe('SimctlSimulator.terminateAsync', () => {
  it('sends terminate', async () => {
    spawnMock.mockReturnValue(resolves(''));

    await sim.terminateAsync('A1', 'dev.routeshot.example');

    expect(argvOf(0)).toEqual(['simctl', 'terminate', 'A1', 'dev.routeshot.example']);
  });

  it('ignores an app that was not running', async () => {
    spawnMock.mockReturnValue(
      rejects('boom', { stderr: 'found nothing to terminate for dev.routeshot.example' })
    );

    await expect(sim.terminateAsync('A1', 'dev.routeshot.example')).resolves.toBeUndefined();
  });
});

describe('SimctlSimulator device controls', () => {
  it('opens a deep link', async () => {
    spawnMock.mockReturnValue(resolves(''));

    await sim.openUrlAsync('A1', 'routeshot://settings/billing');

    expect(argvOf(0)).toEqual(['simctl', 'openurl', 'A1', 'routeshot://settings/billing']);
  });

  it('sets the appearance', async () => {
    spawnMock.mockReturnValue(resolves(''));

    await sim.setAppearanceAsync('A1', 'dark');

    expect(argvOf(0)).toEqual(['simctl', 'ui', 'A1', 'appearance', 'dark']);
  });

  it('freezes the status bar', async () => {
    spawnMock.mockReturnValue(resolves(''));

    await sim.overrideStatusBarAsync('A1');

    expect(argvOf(0)).toEqual([
      'simctl',
      'status_bar',
      'A1',
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
  });
});

describe('SimctlSimulator.screenshotAsync', () => {
  it('returns the PNG bytes streamed on stdout', async () => {
    const png = makeFakePng({ color: [255, 0, 0, 255] });
    spawnMock.mockReturnValue(resolves('', png));

    const bytes = await sim.screenshotAsync('A1');

    expect(argvOf(0)).toEqual(['simctl', 'io', 'A1', 'screenshot', '--type=png', '-']);
    expect(Buffer.from(bytes).equals(Buffer.from(png))).toBe(true);
  });

  it('falls back to a temp file when stdout yields no PNG', async () => {
    const png = makeFakePng({ color: [0, 255, 0, 255] });
    spawnMock.mockImplementation((_command: string, args: string[]) => {
      const target = args[args.length - 1]!;
      if (target === '-') {
        return resolves('');
      }
      return Object.assign(
        fs.writeFile(target, png).then(() => ({ stdout: '', stderr: '' })),
        {
          child: { stdout: null },
        }
      );
    });

    const bytes = await sim.screenshotAsync('A1');

    expect(Buffer.from(bytes).equals(Buffer.from(png))).toBe(true);
    const fallbackArgv = spawnMock.mock.calls[1]![1] as string[];
    const tempPath = fallbackArgv[5]!;
    expect(tempPath).toMatch(/routeshot-A1-\d+\.png$/);
    await expect(fs.access(tempPath)).rejects.toThrow();
  });
});

describe('xcrun error mapping', () => {
  it('explains an unaccepted Xcode license', async () => {
    spawnMock.mockReturnValue(
      rejects('boom', { stderr: 'Xcode license has not been agreed to. Agree to the license.' })
    );

    await expect(sim.openUrlAsync('A1', 'routeshot://')).rejects.toThrow(
      /sudo xcodebuild -license/
    );
  });

  it('explains a missing developer directory', async () => {
    spawnMock.mockReturnValue(
      rejects('boom', {
        stderr: 'xcrun: error: unable to find utility "simctl", not a developer tool or in PATH',
      })
    );

    await expect(sim.openUrlAsync('A1', 'routeshot://')).rejects.toThrow(/sudo xcode-select -s/);
  });

  it('includes stderr and the command in a generic failure', async () => {
    spawnMock.mockReturnValue(rejects('boom', { stderr: 'Invalid device: A9' }));

    const error = await sim.openUrlAsync('A9', 'routeshot://').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RouteshotError);
    expect((error as RouteshotError).message).toContain('xcrun simctl openurl A9 routeshot://');
    expect((error as RouteshotError).message).toContain('Invalid device: A9');
  });
});

describe('pickDeviceAsync', () => {
  const devices: SimulatorDevice[] = [
    { udid: 'B1', name: 'iPhone 16', runtime: 'iOS 18.4', state: 'Shutdown' },
    { udid: 'A2', name: 'iPhone 17', runtime: 'iOS 26.5', state: 'Shutdown' },
    { udid: 'IPAD', name: 'iPad Pro 13-inch', runtime: 'iOS 26.5', state: 'Shutdown' },
  ];

  it('prefers a booted device', async () => {
    const fake = new FakeSimulator({
      devices: [
        ...devices,
        { udid: 'HOT', name: 'iPhone 16', runtime: 'iOS 18.4', state: 'Booted' },
      ],
    });

    await expect(pickDeviceAsync(fake)).resolves.toMatchObject({ udid: 'HOT' });
  });

  it('honors a preferred name over a booted device', async () => {
    const fake = new FakeSimulator({
      devices: [
        ...devices,
        { udid: 'HOT', name: 'iPhone 16', runtime: 'iOS 18.4', state: 'Booted' },
      ],
    });

    await expect(pickDeviceAsync(fake, 'iPhone 17')).resolves.toMatchObject({ udid: 'A2' });
  });

  it('falls back to the newest iPhone runtime', async () => {
    const fake = new FakeSimulator({ devices });

    await expect(pickDeviceAsync(fake)).resolves.toMatchObject({ udid: 'A2' });
  });

  it('throws NO_DEVICE listing what is available', async () => {
    const fake = new FakeSimulator({ devices });

    const error = await pickDeviceAsync(fake, 'iPhone 99').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RouteshotError);
    expect((error as RouteshotError).code).toBe('NO_DEVICE');
    expect((error as RouteshotError).message).toContain('iPhone 16 (iOS 18.4) B1');
  });

  it('throws NO_DEVICE when nothing is installed', async () => {
    const fake = new FakeSimulator({ devices: [] });

    await expect(pickDeviceAsync(fake)).rejects.toMatchObject({ code: 'NO_DEVICE' });
  });
});
