import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { renderReport, writeReportAsync } from '../report.js';
import type { CompareReport } from '../types.js';

const outDirs: string[] = [];

afterEach(async () => {
  await Promise.all(outDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const REPORT: CompareReport = {
  baseline: { id: '2026-09-08T10-00-00Z-main-abc1234', label: 'main' },
  candidate: { id: '2026-09-09T10-00-00Z-pr-42-def5678', label: 'pr-42' },
  threshold: 0.01,
  routes: [
    {
      route: '/',
      status: 'unchanged',
      diffRatio: 0,
      diffPixels: 0,
      files: {
        before: '../../runs/base/index.png',
        after: '../../runs/cand/index.png',
        diff: undefined,
      },
      reason: undefined,
    },
    {
      route: '/settings/billing',
      status: 'changed',
      diffRatio: 0.0412,
      diffPixels: 4120,
      files: {
        before: '../../runs/base/settings__billing.png',
        after: '../../runs/cand/settings__billing.png',
        diff: 'settings__billing.diff.png',
      },
      reason: undefined,
    },
    {
      route: '/users/[id]',
      status: 'unverified',
      diffRatio: undefined,
      diffPixels: undefined,
      files: { before: undefined, after: undefined, diff: undefined },
      reason: 'candidate skipped: dynamic route has no params fixture',
    },
  ],
  summary: { total: 3, unchanged: 1, changed: 1, added: 0, removed: 0, unverified: 1 },
  outDir: undefined,
  verdicts: [
    {
      route: '/settings/billing',
      level: 'red',
      score: 88,
      defect: 'clipped',
      region: { x: 0.1, y: 0.8, w: 0.8, h: 0.1 },
      caption: 'Primary button is clipped at the bottom of the card.',
    },
  ],
};

describe('writeReportAsync', () => {
  it('writes report.html and report.json into the output directory', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routeshot-report-'));
    outDirs.push(outDir);

    const written = await writeReportAsync(REPORT, outDir);

    expect(written).toEqual({
      html: path.join(outDir, 'report.html'),
      json: path.join(outDir, 'report.json'),
    });
    expect(JSON.parse(await fs.readFile(written.json, 'utf8'))).toEqual(REPORT);
    expect(await fs.readFile(written.html, 'utf8')).toContain('<!doctype html>');
  });

  it('creates the output directory when it does not exist yet', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'routeshot-report-'));
    outDirs.push(parent);
    const outDir = path.join(parent, 'nested', 'compare');

    const written = await writeReportAsync(REPORT, outDir);

    await expect(fs.stat(written.html)).resolves.toBeTruthy();
  });
});

describe('renderReport', () => {
  const html = renderReport(REPORT);

  it('renders the summary counts', () => {
    const summary = /<section class="summary">[\s\S]*?<\/section>/.exec(html)?.[0];
    expect(summary).toMatchInlineSnapshot(`
      "<section class="summary">
        <div class="stat changed"><span class="count">1</span><span class="label">changed</span></div>
        <div class="stat unverified"><span class="count">1</span><span class="label">unverified</span></div>
        <div class="stat added"><span class="count">0</span><span class="label">added</span></div>
        <div class="stat removed"><span class="count">0</span><span class="label">removed</span></div>
        <div class="stat unchanged"><span class="count">1</span><span class="label">unchanged</span></div>
        <div class="stat total"><span class="count">3</span><span class="label">total</span></div>
      </section>"
    `);
  });

  it('puts changed routes before unchanged ones', () => {
    expect(html.indexOf('/settings/billing')).toBeLessThan(html.indexOf('>/<'));
    expect(html.indexOf('/settings/billing')).toBeLessThan(html.indexOf('/users/[id]'));
  });

  it('shows the verdict level and caption when the judge has run', () => {
    expect(html).toContain('<span class="verdict red">red</span>');
    expect(html).toContain('Primary button is clipped at the bottom of the card.');
  });

  it('links thumbnails by the relative paths the diff recorded', () => {
    expect(html).toContain('src="../../runs/base/settings__billing.png"');
    expect(html).toContain('src="settings__billing.diff.png"');
  });

  it('escapes route names and reasons instead of injecting markup', () => {
    const injected = renderReport({
      ...REPORT,
      routes: [
        {
          route: '/<script>x</script>',
          status: 'unverified',
          diffRatio: undefined,
          diffPixels: undefined,
          files: { before: undefined, after: undefined, diff: undefined },
          reason: '<img onerror="alert(1)">',
        },
      ],
    });
    expect(injected).not.toContain('<script>x</script>');
    expect(injected).toContain('&lt;script&gt;x&lt;/script&gt;');
  });

  it('is self contained: no external stylesheets, scripts or images', () => {
    expect(html).not.toMatch(/<script/);
    expect(html).not.toMatch(/<link/);
    expect(html).not.toMatch(/https?:\/\//);
  });
});
