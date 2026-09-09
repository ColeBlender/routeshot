import { createHash } from 'node:crypto';

import type { Simulator } from './types.js';

export interface SettleOptions {
  intervalMs: number;
  stableFrames: number;
  timeoutMs: number;
}

export interface SettledFrame {
  /** PNG bytes of the last frame taken, settled or not. */
  png: Uint8Array;
  /** False when the timeout hit first: the screen was still moving. */
  settled: boolean;
  elapsedMs: number;
}

/**
 * Screenshot in a loop until the screen stops changing.
 *
 * Frames are compared by hashing the PNG bytes rather than by pixel: simctl re-encodes the same
 * framebuffer to byte-identical PNGs, so a hash match is a real "nothing moved" and costs
 * microseconds instead of a decode per frame. Anything that does animate forever (a spinner, a
 * blinking cursor) never settles and is reported as `settled: false` rather than silently passing,
 * because a screenshot of a moving screen is exactly the thing that produces phantom diffs later.
 */
export async function waitForSettledFrameAsync(
  sim: Simulator,
  udid: string,
  options: SettleOptions
): Promise<SettledFrame> {
  const startedAt = Date.now();
  let previousHash: string | undefined;
  let identicalFrames = 0;
  let png = await sim.screenshotAsync(udid);

  for (;;) {
    const hash = createHash('sha1').update(png).digest('hex');
    identicalFrames = hash === previousHash ? identicalFrames + 1 : 1;
    previousHash = hash;

    if (identicalFrames >= options.stableFrames) {
      return { png, settled: true, elapsedMs: Date.now() - startedAt };
    }
    if (Date.now() - startedAt >= options.timeoutMs) {
      return { png, settled: false, elapsedMs: Date.now() - startedAt };
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, options.intervalMs);
    });
    png = await sim.screenshotAsync(udid);
  }
}
