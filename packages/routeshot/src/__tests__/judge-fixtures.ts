import { PNG } from 'pngjs';

import type { JudgeModel, JudgeRequest } from '../judge.js';

/** A solid-color PNG so the judge has real image bytes to encode. */
export function makePng(
  width: number,
  height: number,
  color: [number, number, number]
): Uint8Array {
  const png = new PNG({ width, height });
  for (let index = 0; index < width * height * 4; index += 4) {
    png.data[index] = color[0];
    png.data[index + 1] = color[1];
    png.data[index + 2] = color[2];
    png.data[index + 3] = 255;
  }
  return new Uint8Array(PNG.sync.write(png));
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
