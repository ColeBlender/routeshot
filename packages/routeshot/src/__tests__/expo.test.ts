import { describe, expect, it, vi } from 'vitest';

const setUpdateURLAndRequestHeadersOverride = vi.fn();
vi.mock('expo-updates', () => ({ setUpdateURLAndRequestHeadersOverride }));

const { applyRouteshotUpdateOverrideAsync, parseRouteshotUpdateUrl, useRouteshotUpdateOverride } =
  await import('../expo.js');

const MANIFEST = 'https://u.expo.dev/proj/group/g1';
const LINK = `demo://routeshot/update?url=${encodeURIComponent(MANIFEST)}`;

describe('parseRouteshotUpdateUrl', () => {
  it('extracts the manifest url from the routeshot deep link', () => {
    expect(parseRouteshotUpdateUrl(LINK)).toBe(MANIFEST);
  });

  it('ignores every other link, including no link at all', () => {
    expect(parseRouteshotUpdateUrl('demo://settings/billing')).toBeUndefined();
    expect(parseRouteshotUpdateUrl(null)).toBeUndefined();
    expect(parseRouteshotUpdateUrl(undefined)).toBeUndefined();
  });
});

describe('applyRouteshotUpdateOverrideAsync', () => {
  it('points expo-updates at the manifest and reports that it did', async () => {
    setUpdateURLAndRequestHeadersOverride.mockClear();

    expect(await applyRouteshotUpdateOverrideAsync(LINK)).toBe(true);
    expect(setUpdateURLAndRequestHeadersOverride).toHaveBeenCalledWith({
      updateUrl: MANIFEST,
      requestHeaders: {},
    });
  });

  it('does nothing for an ordinary navigation link', async () => {
    setUpdateURLAndRequestHeadersOverride.mockClear();

    expect(await applyRouteshotUpdateOverrideAsync('demo://about')).toBe(false);
    expect(setUpdateURLAndRequestHeadersOverride).not.toHaveBeenCalled();
  });
});

describe('useRouteshotUpdateOverride', () => {
  it('applies the initial url and every later url event, and unsubscribes on cleanup', async () => {
    setUpdateURLAndRequestHeadersOverride.mockClear();
    let handler: ((event: { url: string }) => void) | undefined;
    const remove = vi.fn();
    const Linking = {
      getInitialURL: () => Promise.resolve(LINK),
      addEventListener: (_type: 'url', next: (event: { url: string }) => void) => {
        handler = next;
        return { remove };
      },
    };
    let cleanup: (() => void) | undefined;
    const useEffect = (effect: () => undefined | (() => void)) => {
      cleanup = effect();
    };

    useRouteshotUpdateOverride({ useEffect, Linking });
    await Promise.resolve();
    handler?.({ url: LINK });
    await Promise.resolve();
    cleanup?.();

    expect(setUpdateURLAndRequestHeadersOverride).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledOnce();
  });
});
