import type { JudgeModel } from './judge.js';
import { RemoteJudgeResponseSchema } from './server-contract.js';

export interface RemoteJudgeOptions {
  url: string;
  token: string;
  fetch?: typeof fetch;
}

/**
 * A `JudgeModel` that asks the report server instead of Anthropic. The server holds the key,
 * the prompt and the model; the CLI sends the content blocks it would have sent itself and gets
 * the model's text back, so parsing, the one retry and the thresholds all stay on this side and a
 * remote verdict is scored exactly like a local one. The example app ships a judge-only token for
 * this, which is how the quickstart runs with no key of your own.
 */
export function createRemoteJudgeModel(options: RemoteJudgeOptions): JudgeModel {
  const fetchFn = options.fetch ?? fetch;
  const endpoint = new URL('/judge', options.url.endsWith('/') ? options.url : `${options.url}/`);
  return {
    async parseAsync(request, signal) {
      const response = await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ content: request.content }),
        signal,
      });
      if (!response.ok) {
        let detail = `${response.status}`;
        try {
          const body = (await response.json()) as { error?: unknown };
          if (typeof body.error === 'string') {
            detail = body.error;
          }
        } catch {
          // A non-JSON error page: the status is all there is.
        }
        throw new Error(`report server refused the judge request: ${detail}`);
      }
      const parsed = RemoteJudgeResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new Error('report server returned an unexpected judge response');
      }
      return { parsedOutput: undefined, text: parsed.data.text };
    },
  };
}
