import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_JUDGE_MODEL,
  JUDGE_SYSTEM_PROMPT,
  buildJudgeRequest,
  createAnthropicJudgeModel,
  judgeRouteAsync,
  judgeRoutesAsync,
  levelForScore,
  type JudgeDeps,
  type JudgeInput,
  type JudgeRequest,
} from '../judge.js';
import { fakeJudge, makePng } from './fixtures.js';

const thresholds = { yellow: 40, red: 75 };

function input(route = '/settings/billing'): JudgeInput {
  return {
    route,
    before: makePng(4, 4, [0, 0, 0]),
    after: makePng(4, 4, [255, 255, 255]),
    diff: makePng(4, 4, [255, 0, 0]),
    diffRatio: 0.0234,
  };
}

function deps(overrides: Partial<JudgeDeps> = {}): JudgeDeps {
  return {
    anthropic: fakeJudge(() => ({
      parsedOutput: { score: 10, defect: 'none', region: null, caption: 'fine' },
    })),
    model: DEFAULT_JUDGE_MODEL,
    thresholds,
    timeoutMs: 1_000,
    concurrency: 4,
    quota: undefined,
    now: () => new Date('2026-09-09T12:00:00.000Z'),
    ...overrides,
  };
}

describe('levelForScore', () => {
  it('maps scores to levels at the threshold boundaries', () => {
    expect(levelForScore(0, 'none', thresholds)).toBe('green');
    expect(levelForScore(39, 'clipped', thresholds)).toBe('green');
    expect(levelForScore(40, 'clipped', thresholds)).toBe('yellow');
    expect(levelForScore(74, 'clipped', thresholds)).toBe('yellow');
    expect(levelForScore(75, 'clipped', thresholds)).toBe('red');
    expect(levelForScore(100, 'blank', thresholds)).toBe('red');
  });

  it('caps a no-defect answer at yellow however high the score is', () => {
    expect(levelForScore(100, 'none', thresholds)).toBe('yellow');
  });
});

describe('buildJudgeRequest', () => {
  it('sends the system prompt, the route, the change size and three PNG images in order', () => {
    const request = buildJudgeRequest(input(), 'claude-sonnet-5');

    expect(request.model).toBe('claude-sonnet-5');
    expect(request.system).toBe(JUDGE_SYSTEM_PROMPT);
    expect(request.maxTokens).toBeLessThanOrEqual(300);
    expect(request.content.map((block) => block.type)).toEqual([
      'text',
      'image',
      'text',
      'image',
      'text',
      'image',
    ]);
    const first = request.content[0];
    expect(first).toMatchObject({ type: 'text' });
    expect(first?.type === 'text' ? first.text : '').toContain('/settings/billing');
    expect(first?.type === 'text' ? first.text : '').toContain('2.34% of pixels changed');
    for (const block of request.content.filter((item) => item.type === 'image')) {
      expect(block.source.media_type).toBe('image/png');
      expect(block.source.data.length).toBeGreaterThan(0);
    }
  });
});

describe('judgeRouteAsync', () => {
  it('drops quotes wrapping the whole caption but keeps a quoted word at the start', async () => {
    const captionFor = async (caption: string): Promise<string> =>
      (
        await judgeRouteAsync(
          input(),
          deps({
            anthropic: fakeJudge(() => ({
              parsedOutput: { score: 80, defect: 'overlap', region: null, caption },
            })),
          })
        )
      ).caption;

    expect(await captionFor('"badge covers the caption"')).toBe('badge covers the caption');
    expect(await captionFor("'Saved' button overlaps the caption")).toBe(
      "'Saved' button overlaps the caption"
    );
  });

  it('maps a structured answer onto a verdict', async () => {
    const verdict = await judgeRouteAsync(
      input(),
      deps({
        anthropic: fakeJudge(() => ({
          parsedOutput: {
            score: 88,
            defect: 'clipped',
            region: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 },
            caption: 'primary button clipped at the right edge',
          },
        })),
      })
    );

    expect(verdict).toEqual({
      route: '/settings/billing',
      level: 'red',
      score: 88,
      defect: 'clipped',
      region: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 },
      caption: 'primary button clipped at the right edge',
    });
  });

  it('falls back to parsing JSON out of the text when structured output is absent', async () => {
    const verdict = await judgeRouteAsync(
      input(),
      deps({
        anthropic: fakeJudge(() => ({
          text: 'Here you go:\n{"score": 50, "defect": "overlap", "region": null, "caption": "labels overlap"}',
        })),
      })
    );

    expect(verdict.level).toBe('yellow');
    expect(verdict.defect).toBe('overlap');
    expect(verdict.region).toBeUndefined();
  });

  it('returns unverified when the answer cannot be parsed', async () => {
    const verdict = await judgeRouteAsync(
      input(),
      deps({ anthropic: fakeJudge(() => ({ text: 'looks fine to me' })) })
    );

    expect(verdict.level).toBe('unverified');
    expect(verdict.score).toBeUndefined();
    expect(verdict.caption).toBe('judge returned unparseable output');
  });

  it('returns unverified rather than throwing when the model call fails', async () => {
    const verdict = await judgeRouteAsync(
      input(),
      deps({
        anthropic: fakeJudge(() => Promise.reject(new Error('overloaded'))),
      })
    );

    expect(verdict.level).toBe('unverified');
    expect(verdict.caption).toContain('overloaded');
  });

  it('times out into an unverified verdict', async () => {
    const verdict = await judgeRouteAsync(
      input(),
      deps({
        timeoutMs: 5,
        anthropic: {
          async parseAsync(_request, signal) {
            await new Promise((resolve, reject) => {
              signal.addEventListener('abort', () => {
                reject(signal.reason as Error);
              });
            });
            throw new Error('unreachable');
          },
        },
      })
    );

    expect(verdict.level).toBe('unverified');
    expect(verdict.caption).toBe('judge timed out');
  });
});

describe('judgeRoutesAsync', () => {
  it('never runs more than the configured number of calls at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const verdicts = await judgeRoutesAsync(
      Array.from({ length: 12 }, (_unused, index) => input(`/route-${index}`)),
      deps({
        anthropic: {
          async parseAsync() {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 1));
            inFlight -= 1;
            return {
              parsedOutput: { score: 5, defect: 'none', region: null, caption: 'ok' },
              text: '',
            };
          },
        },
      })
    );

    expect(verdicts).toHaveLength(12);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('spends only what the daily cap leaves and marks the rest unverified', async () => {
    const recorded: number[] = [];
    const verdicts = await judgeRoutesAsync(
      [input('/a'), input('/b'), input('/c')],
      deps({
        quota: {
          cap: 10,
          countAsync: async () => 8,
          recordAsync: async (_day, count) => {
            recorded.push(count);
          },
        },
      })
    );

    expect(recorded).toEqual([2]);
    expect(verdicts.map((item) => item.level)).toEqual(['green', 'green', 'unverified']);
    expect(verdicts[2]?.caption).toBe('daily judge cap reached');
  });

  it('refunds the reservation for calls that never reached the model', async () => {
    const recorded: number[] = [];
    const verdicts = await judgeRoutesAsync(
      [input('/a'), input('/b')],
      deps({
        anthropic: fakeJudge(() => Promise.reject(new Error('socket hang up'))),
        quota: {
          cap: 10,
          countAsync: async () => 8,
          recordAsync: async (_day, count) => {
            recorded.push(count);
          },
        },
      })
    );

    expect(recorded).toEqual([2, -2]);
    expect(verdicts.map((item) => item.level)).toEqual(['unverified', 'unverified']);
  });

  it('refunds a timed out call but keeps the spend for an answer it could not parse', async () => {
    const recorded: number[] = [];
    await judgeRoutesAsync(
      [input('/a')],
      deps({
        timeoutMs: 5,
        anthropic: {
          async parseAsync(_request, signal) {
            await new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => {
                reject(signal.reason as Error);
              });
            });
            throw new Error('unreachable');
          },
        },
        quota: {
          cap: 10,
          countAsync: async () => 0,
          recordAsync: async (_day, count) => {
            recorded.push(count);
          },
        },
      })
    );
    expect(recorded).toEqual([1, -1]);

    const garbage: number[] = [];
    await judgeRoutesAsync(
      [input('/a')],
      deps({
        anthropic: fakeJudge(() => ({ text: 'no idea' })),
        quota: {
          cap: 10,
          countAsync: async () => 0,
          recordAsync: async (_day, count) => {
            garbage.push(count);
          },
        },
      })
    );
    // The model answered, so those tokens are spent however useless the answer was.
    expect(garbage).toEqual([1]);
  });

  it('spends nothing once the cap is used up', async () => {
    const judge = fakeJudge(() => ({ parsedOutput: { score: 0, defect: 'none', caption: 'ok' } }));
    const verdicts = await judgeRoutesAsync(
      [input('/a')],
      deps({
        anthropic: judge,
        quota: { cap: 5, countAsync: async () => 5, recordAsync: async () => {} },
      })
    );

    expect(judge.requests).toHaveLength(0);
    expect(verdicts[0]).toMatchObject({ level: 'unverified', caption: 'daily judge cap reached' });
  });
});

describe('createAnthropicJudgeModel', () => {
  const request: JudgeRequest = {
    model: DEFAULT_JUDGE_MODEL,
    maxTokens: 300,
    system: 'system',
    content: [{ type: 'text', text: 'hi' }],
  };

  function badRequest(message: string, body?: unknown): Error {
    return Object.assign(new Error(message), { status: 400, error: body });
  }

  function fakeClient(messages: {
    parse: () => Promise<unknown>;
    create: () => Promise<unknown>;
  }): Anthropic {
    return { messages } as unknown as Anthropic;
  }

  it('latches structured output off when the API rejects the parameter itself', async () => {
    let parseCalls = 0;
    let createCalls = 0;
    const model = createAnthropicJudgeModel(
      fakeClient({
        parse: async () => {
          parseCalls += 1;
          throw badRequest('400 invalid_request_error', {
            error: { message: 'output_config: unexpected parameter' },
          });
        },
        create: async () => {
          createCalls += 1;
          return { content: [{ type: 'text', text: '{"score":1}' }] };
        },
      })
    );

    const first = await model.parseAsync(request, new AbortController().signal);
    expect(first.parsedOutput).toBeUndefined();
    expect(first.text).toBe('{"score":1}');

    await model.parseAsync(request, new AbortController().signal);
    // Latched: the second call never retries the unsupported parameter.
    expect(parseCalls).toBe(1);
    expect(createCalls).toBe(2);
  });

  it('rethrows an unrelated 400 and keeps structured output on for the next route', async () => {
    let parseCalls = 0;
    let createCalls = 0;
    const model = createAnthropicJudgeModel(
      fakeClient({
        parse: async () => {
          parseCalls += 1;
          if (parseCalls === 1) {
            throw badRequest('400 image exceeds 5 MB maximum');
          }
          return { parsed_output: { score: 3 }, content: [] };
        },
        create: async () => {
          createCalls += 1;
          return { content: [] };
        },
      })
    );

    await expect(model.parseAsync(request, new AbortController().signal)).rejects.toThrow(
      'image exceeds 5 MB'
    );
    const second = await model.parseAsync(request, new AbortController().signal);

    expect(second.parsedOutput).toEqual({ score: 3 });
    expect(parseCalls).toBe(2);
    expect(createCalls).toBe(0);
  });

  it('turns an unrelated 400 into one unverified route carrying the reason', async () => {
    const model = createAnthropicJudgeModel(
      fakeClient({
        parse: async () => {
          throw badRequest('400 image exceeds 5 MB maximum');
        },
        create: async () => ({ content: [] }),
      })
    );

    const verdict = await judgeRouteAsync(input('/big'), deps({ anthropic: model }));

    expect(verdict.level).toBe('unverified');
    expect(verdict.caption).toContain('image exceeds 5 MB');
  });
});
