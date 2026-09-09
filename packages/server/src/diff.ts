import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/**
 * Per-pixel color tolerance handed to pixelmatch (its `threshold` option), not the ratio that
 * decides whether a route counts as changed. Anti-aliasing on the simulator moves single pixels
 * by a hair, so a small tolerance is what keeps identical screens at a ratio of exactly 0.
 */
const PIXEL_TOLERANCE = 0.1;

export type PixelDiff =
  | { status: 'ok'; diffPixels: number; diffRatio: number; png: Uint8Array }
  | { status: 'unverified'; reason: string };

/** Compares two PNGs and renders the mask. Never throws: a bad pair is an honest 'unverified'. */
export function diffPngs(before: Uint8Array, after: Uint8Array): PixelDiff {
  let baselineImage: PNG;
  let candidateImage: PNG;
  try {
    baselineImage = PNG.sync.read(Buffer.from(before));
    candidateImage = PNG.sync.read(Buffer.from(after));
  } catch (error) {
    return {
      status: 'unverified',
      reason: `could not decode screenshot: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (
    baselineImage.width !== candidateImage.width ||
    baselineImage.height !== candidateImage.height
  ) {
    return {
      status: 'unverified',
      reason:
        `screenshot sizes differ (${baselineImage.width}x${baselineImage.height} vs ` +
        `${candidateImage.width}x${candidateImage.height}); capture both runs on the same device`,
    };
  }

  const mask = new PNG({ width: baselineImage.width, height: baselineImage.height });
  const diffPixels = pixelmatch(
    baselineImage.data,
    candidateImage.data,
    mask.data,
    baselineImage.width,
    baselineImage.height,
    { threshold: PIXEL_TOLERANCE, includeAA: false, alpha: 0.2 }
  );

  return {
    status: 'ok',
    diffPixels,
    diffRatio: diffPixels / (baselineImage.width * baselineImage.height),
    png: PNG.sync.write(mask),
  };
}
