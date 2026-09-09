import { PNG } from 'pngjs';

import type { JudgeModel, JudgeRequest } from '../judge.js';
import type { CaptureRun } from '../types.js';

/** A solid-color PNG, optionally with a rectangle painted in, so diffs have a known pixel count. */
export function makePng(
  width: number,
  height: number,
  color: [number, number, number],
  patch?: { x: number; y: number; w: number; h: number; color: [number, number, number] }
): Uint8Array {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inPatch =
        patch !== undefined &&
        x >= patch.x &&
        x < patch.x + patch.w &&
        y >= patch.y &&
        y < patch.y + patch.h;
      const [r, g, b] = inPatch ? patch.color : color;
      const index = (y * width + x) * 4;
      png.data[index] = r;
      png.data[index + 1] = g;
      png.data[index + 2] = b;
      png.data[index + 3] = 255;
    }
  }
  return new Uint8Array(PNG.sync.write(png));
}

export function makeRun(overrides: Partial<CaptureRun> = {}): CaptureRun {
  return {
    id: 'local-run-1',
    label: 'main',
    createdAt: '2026-09-09T20:15:03.000Z',
    device: { udid: 'UDID', name: 'iPhone 17 Pro', runtime: 'iOS 26.5', state: 'Booted' },
    app: { bundleId: 'dev.routeshot.example', scheme: 'routeshot' },
    updateUrl: undefined,
    git: { sha: 'abc1234', branch: 'main' },
    affected: undefined,
    routes: [
      {
        route: '/',
        file: 'index.png',
        code: undefined,
        status: 'captured',
        reason: undefined,
        settledMs: 420,
        settled: true,
      },
    ],
    ...overrides,
  };
}

export interface FakeJudge extends JudgeModel {
  requests: JudgeRequest[];
}

/** Returns canned JSON, either as structured output or as raw text, and records what it was sent. */
export function fakeJudge(
  reply: (request: JudgeRequest) => { parsedOutput?: unknown; text?: string } | Promise<never>
): FakeJudge {
  const requests: JudgeRequest[] = [];
  return {
    requests,
    async parseAsync(request) {
      requests.push(request);
      const result = await reply(request);
      return { parsedOutput: result.parsedOutput, text: result.text ?? '' };
    },
  };
}
