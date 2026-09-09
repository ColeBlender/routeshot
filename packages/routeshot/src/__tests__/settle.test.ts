import { describe, expect, it } from 'vitest';

import { waitForSettledFrameAsync } from '../settle.js';
import { FakeSimulator, makeFakePng } from '../testing/fake-simulator.js';

const UDID = 'FAKE-UDID-0001';
const red = makeFakePng({ color: [255, 0, 0, 255] });
const green = makeFakePng({ color: [0, 255, 0, 255] });
const blue = makeFakePng({ color: [0, 0, 255, 255] });

/** A screen that never holds still: every screenshot comes back as a different frame. */
class SpinnerSimulator extends FakeSimulator {
  #tick = 0;

  override screenshotAsync(): Promise<Uint8Array> {
    this.#tick += 1;
    return Promise.resolve(makeFakePng({ color: [this.#tick, 0, 0, 255] }));
  }
}

describe('waitForSettledFrameAsync', () => {
  it('settles on the first pair of identical frames', async () => {
    const sim = new FakeSimulator({ frames: [red, green, blue, blue] });

    const frame = await waitForSettledFrameAsync(sim, UDID, {
      intervalMs: 1,
      stableFrames: 2,
      timeoutMs: 2000,
    });

    expect(frame.settled).toBe(true);
    expect([...frame.png]).toEqual([...blue]);
    // red, green, blue, blue: it cannot know blue is stable until it sees it twice.
    expect(sim.callsTo('screenshotAsync')).toHaveLength(4);
  });

  it('holds out for the requested number of identical frames', async () => {
    const sim = new FakeSimulator({ frames: [red, red, green, green, green] });

    const frame = await waitForSettledFrameAsync(sim, UDID, {
      intervalMs: 1,
      stableFrames: 3,
      timeoutMs: 2000,
    });

    expect(frame.settled).toBe(true);
    expect([...frame.png]).toEqual([...green]);
    expect(sim.callsTo('screenshotAsync')).toHaveLength(5);
  });

  it('settles immediately when a single frame is enough', async () => {
    const sim = new FakeSimulator({ frames: [red] });

    const frame = await waitForSettledFrameAsync(sim, UDID, {
      intervalMs: 50,
      stableFrames: 1,
      timeoutMs: 2000,
    });

    expect(frame.settled).toBe(true);
    expect(sim.callsTo('screenshotAsync')).toHaveLength(1);
  });

  it('returns the last frame with settled=false when the screen keeps moving', async () => {
    const sim = new SpinnerSimulator();

    const frame = await waitForSettledFrameAsync(sim, UDID, {
      intervalMs: 1,
      stableFrames: 2,
      timeoutMs: 30,
    });

    expect(frame.settled).toBe(false);
    expect(frame.elapsedMs).toBeGreaterThanOrEqual(30);
    expect(frame.png.byteLength).toBeGreaterThan(0);
  });

  it('propagates a simulator failure instead of returning a half frame', async () => {
    const sim = new FakeSimulator({ frames: [red] });
    sim.failNext('screenshotAsync', new Error('device is not booted'));

    await expect(
      waitForSettledFrameAsync(sim, UDID, { intervalMs: 1, stableFrames: 2, timeoutMs: 100 })
    ).rejects.toThrow('device is not booted');
  });
});
