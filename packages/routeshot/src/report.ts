import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CompareReport, DiffStatus, RouteDiff, Verdict } from './types.js';

/**
 * `report.json` plus a single self-contained `report.html`. No bundler, no CDN, no fonts: the
 * report gets zipped into CI artifacts and opened from disk, where anything external is a
 * broken box.
 */
export async function writeReportAsync(
  report: CompareReport,
  outDir: string
): Promise<{ html: string; json: string }> {
  await mkdir(outDir, { recursive: true });

  const jsonPath = join(outDir, 'report.json');
  const htmlPath = join(outDir, 'report.html');
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(htmlPath, renderReport(report));

  return { html: htmlPath, json: jsonPath };
}

/** Worst first: whoever opens this wants the broken screen, not the 24 that are fine. */
const STATUS_ORDER: Record<DiffStatus, number> = {
  changed: 0,
  unverified: 1,
  added: 2,
  removed: 3,
  unchanged: 4,
};

export function renderReport(report: CompareReport): string {
  const verdicts = new Map((report.verdicts ?? []).map((verdict) => [verdict.route, verdict]));
  const routes = [...report.routes].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (b.diffRatio ?? 0) - (a.diffRatio ?? 0) ||
      a.route.localeCompare(b.route)
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>routeshot ${escapeHtml(report.baseline.label)} to ${escapeHtml(report.candidate.label)}</title>
<style>${STYLES}</style>
</head>
<body>
${renderHeader(report)}
${renderSummary(report)}
<main>
${routes.map((route) => renderRoute(route, verdicts.get(route.route))).join('\n')}
</main>
</body>
</html>
`;
}

function renderHeader(report: CompareReport): string {
  return `<header>
  <h1>routeshot</h1>
  <p class="runs">
    <span class="run">${escapeHtml(report.baseline.label)}</span>
    <span class="arrow">to</span>
    <span class="run">${escapeHtml(report.candidate.label)}</span>
  </p>
  <p class="ids">${escapeHtml(report.baseline.id)} &rarr; ${escapeHtml(report.candidate.id)} &middot; threshold ${formatRatio(report.threshold)}</p>
</header>`;
}

function renderSummary(report: CompareReport): string {
  const cells: [string, number, DiffStatus | 'total'][] = [
    ['changed', report.summary.changed, 'changed'],
    ['unverified', report.summary.unverified, 'unverified'],
    ['added', report.summary.added, 'added'],
    ['removed', report.summary.removed, 'removed'],
    ['unchanged', report.summary.unchanged, 'unchanged'],
    ['total', report.summary.total, 'total'],
  ];
  return `<section class="summary">
${cells
  .map(
    ([label, count, kind]) =>
      `  <div class="stat ${kind}"><span class="count">${count}</span><span class="label">${label}</span></div>`
  )
  .join('\n')}
</section>`;
}

function renderRoute(route: RouteDiff, verdict: Verdict | undefined): string {
  const ratio =
    route.diffRatio === undefined
      ? ''
      : `<span class="ratio">${formatRatio(route.diffRatio)} of pixels</span>`;
  const reason = route.reason ? `<p class="reason">${escapeHtml(route.reason)}</p>` : '';
  const badge = verdict ? `<span class="verdict ${verdict.level}">${verdict.level}</span>` : '';
  const caption = verdict?.caption ? `<p class="caption">${escapeHtml(verdict.caption)}</p>` : '';

  const shots = [
    ['before', route.files.before],
    ['diff', route.files.diff],
    ['after', route.files.after],
  ] as const;
  const images = shots
    .filter(([, file]) => file !== undefined)
    .map(
      ([label, file]) =>
        `    <figure><img loading="lazy" src="${escapeHtml(file ?? '')}" alt="${label} ${escapeHtml(route.route)}"><figcaption>${label}</figcaption></figure>`
    )
    .join('\n');

  return `<article class="route ${route.status}">
  <div class="route-head">
    <span class="status ${route.status}">${route.status}</span>
    <h2>${escapeHtml(route.route)}</h2>
    ${ratio}
    ${badge}
  </div>
  ${caption}
  ${reason}
  <div class="shots">
${images}
  </div>
</article>`;
}

function formatRatio(ratio: number): string {
  return ratio === 0 ? '0%' : `${(ratio * 100).toFixed(ratio < 0.01 ? 3 : 2)}%`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLES = `
:root {
  --bg: #0a0b0e; --panel: #14161b; --line: #262a33; --text: #e6e8ee; --muted: #8b93a5;
  --changed: #f2a33c; --unverified: #8b93a5; --added: #4ea1ff; --removed: #b06bd6;
  --unchanged: #3ec98a; --red: #ff5f56; --yellow: #f2c53c; --green: #3ec98a;
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 32px; background: var(--bg); color: var(--text);
  font: 14px/1.5 ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
}
header h1 { margin: 0; font-size: 18px; letter-spacing: 0.14em; text-transform: uppercase; }
.runs { margin: 8px 0 4px; font-size: 20px; font-weight: 600; }
.arrow { color: var(--muted); font-weight: 400; padding: 0 8px; }
.ids { margin: 0; color: var(--muted); font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; }
.summary { display: flex; flex-wrap: wrap; gap: 12px; margin: 24px 0 32px; }
.stat {
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  padding: 12px 18px; min-width: 104px;
}
.stat .count { display: block; font-size: 24px; font-weight: 700; }
.stat .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
.stat.changed .count { color: var(--changed); }
.stat.unverified .count { color: var(--unverified); }
.stat.added .count { color: var(--added); }
.stat.removed .count { color: var(--removed); }
.stat.unchanged .count { color: var(--unchanged); }
.route {
  background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
  padding: 18px; margin-bottom: 18px;
}
.route.changed { border-color: var(--changed); }
.route-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.route-head h2 { margin: 0; font-size: 16px; font-family: ui-monospace, SFMono-Regular, monospace; }
.status {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; padding: 3px 8px;
  border-radius: 999px; border: 1px solid currentColor;
}
.status.changed { color: var(--changed); }
.status.unverified { color: var(--unverified); }
.status.added { color: var(--added); }
.status.removed { color: var(--removed); }
.status.unchanged { color: var(--unchanged); }
.ratio { color: var(--muted); font-size: 12px; }
.verdict { font-size: 11px; text-transform: uppercase; padding: 3px 8px; border-radius: 999px; color: #0a0b0e; }
.verdict.red { background: var(--red); }
.verdict.yellow { background: var(--yellow); }
.verdict.green { background: var(--green); }
.verdict.unverified { background: var(--muted); }
.caption { margin: 10px 0 0; }
.reason { margin: 10px 0 0; color: var(--muted); font-size: 13px; }
.shots { display: flex; gap: 14px; margin-top: 14px; overflow-x: auto; }
.shots figure { margin: 0; flex: 0 0 auto; }
.shots img {
  display: block; max-height: 420px; width: auto; border-radius: 8px; border: 1px solid var(--line);
  background: #000;
}
.shots figcaption { color: var(--muted); font-size: 11px; text-transform: uppercase; padding-top: 6px; }
.route.unchanged .shots { display: none; }
`;
