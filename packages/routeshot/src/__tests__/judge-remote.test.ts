import { describe, expect, it } from 'vitest';

import { createRemoteJudgeModel } from '../judge-remote.js';
import { JUDGE_SYSTEM_PROMPT, type JudgeRequest } from '../judge.js';

const request: JudgeRequest = {
  model: 'claude-sonnet-5',
  maxTokens: 400,
  system: JUDGE_SYSTEM_PROMPT,
  content: [
    { type: 'text', text: 'Route: /' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
  ],
};

function fakeFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe('createRemoteJudgeModel', () => {
  it('posts only the content blocks with the bearer token and returns the text', async () => {
    const { calls, fetchFn } = fakeFetch(() => Response.json({ text: '{"score":2}' }));
    const model = createRemoteJudgeModel({
      url: 'https://routeshot.example.com',
      token: 'demo',
      fetch: fetchFn,
    });

    const response = await model.parseAsync(request, new AbortController().signal);

    expect(response).toEqual({ parsedOutput: undefined, text: '{"score":2}' });
    expect(calls[0]?.url).toBe('https://routeshot.example.com/judge');
    expect(calls[0]?.init.method).toBe('POST');
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe('Bearer demo');
    // The server supplies the prompt and the model; only the screenshot and code travel.
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ content: request.content });
  });

  it('throws the server message on a refusal so the screen ends up unverified', async () => {
    const { fetchFn } = fakeFetch(() =>
      Response.json({ error: 'daily judge cap reached', code: 'RATE_LIMITED' }, { status: 429 })
    );
    const model = createRemoteJudgeModel({ url: 'https://x.test/', token: 't', fetch: fetchFn });
    await expect(model.parseAsync(request, new AbortController().signal)).rejects.toThrow(
      /daily judge cap reached/
    );
  });

  it('rejects a response that is not the contract', async () => {
    const { fetchFn } = fakeFetch(() => Response.json({ nope: true }));
    const model = createRemoteJudgeModel({ url: 'https://x.test', token: 't', fetch: fetchFn });
    await expect(model.parseAsync(request, new AbortController().signal)).rejects.toThrow(
      /unexpected judge response/
    );
  });
});
