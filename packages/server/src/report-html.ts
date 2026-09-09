import type { CompareReport, RouteDiff, Verdict, VerdictLevel } from './types.js';

/**
 * Self-contained dark report page: no framework, no external assets, one <style> block. Shares
 * its look with the CLI's `report.html` so a locally-generated report and a hosted one read the
 * same. Images are served from this origin, so the page works behind the unguessable URL alone.
 */
const STYLES = `
  :root {
    color-scheme: dark;
    --bg: #0b0d10;
    --panel: #14181d;
    --line: #232a32;
    --text: #e7edf3;
    --muted: #8b98a6;
    --green: #3fb950;
    --yellow: #d29922;
    --red: #f85149;
    --gray: #6e7781;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.5 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 1200px; margin: 0 auto; padding: 32px 20px 80px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 24px; }
  .summary {
    display: flex; flex-wrap: wrap; gap: 8px; padding: 16px; margin-bottom: 32px;
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  }
  .stat { padding: 4px 10px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); }
  .stat b { color: var(--text); }
  .route {
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: 16px; margin-bottom: 20px;
  }
  .route header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 4px; }
  .route h2 { font-size: 15px; margin: 0; font-family: ui-monospace, SFMono-Regular, monospace; }
  .badge {
    font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
    padding: 3px 8px; border-radius: 999px; color: #0b0d10;
  }
  .badge.green { background: var(--green); }
  .badge.yellow { background: var(--yellow); }
  .badge.red { background: var(--red); }
  .badge.unverified { background: var(--gray); color: var(--text); }
  .caption { color: var(--muted); margin: 0 0 12px; }
  .meta { color: var(--muted); font-size: 12px; }
  .frames { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .frame { min-width: 0; }
  .frame span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  .frame img {
    width: 100%; max-height: 70vh; object-fit: contain; object-position: top;
    border: 1px solid var(--line); border-radius: 6px; background: #000;
  }
  .frame .missing {
    display: grid; place-items: center; aspect-ratio: 9 / 19.5; color: var(--muted);
    border: 1px dashed var(--line); border-radius: 6px;
  }
  @media (max-width: 720px) { .frames { grid-template-columns: 1fr; } }
`;

const LEVEL_RANK: Record<VerdictLevel, number> = { red: 0, yellow: 1, unverified: 2, green: 4 };

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function frame(label: string, src: string | undefined): string {
  const body = src
    ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(label)}" loading="lazy">`
    : '<div class="missing">not captured</div>';
  return `<div class="frame"><span>${label}</span>${body}</div>`;
}

function routeSection(
  diff: RouteDiff,
  verdict: Verdict | undefined,
  report: CompareReport,
  compareId: string
): string {
  const level: VerdictLevel =
    verdict?.level ?? (diff.status === 'unchanged' ? 'green' : 'unverified');
  const caption =
    verdict?.caption ??
    diff.reason ??
    (diff.status === 'unchanged' ? 'no visible change' : `${diff.status}, not judged`);
  const ratio =
    diff.diffRatio === undefined
      ? diff.status
      : `${(diff.diffRatio * 100).toFixed(2)}% of pixels changed`;
  const score = verdict?.score === undefined ? '' : ` &middot; score ${verdict.score}`;
  const defect =
    verdict && verdict.defect !== 'none' ? ` &middot; ${escapeHtml(verdict.defect)}` : '';

  return `<section class="route">
    <header>
      <span class="badge ${level}">${level}</span>
      <h2>${escapeHtml(diff.route)}</h2>
      <span class="meta">${escapeHtml(ratio)}${score}${defect}</span>
    </header>
    <p class="caption">${escapeHtml(caption)}</p>
    <div class="frames">
      ${frame('before', diff.files.before && `/runs/${report.baseline.id}/files/${diff.files.before}`)}
      ${frame('diff', diff.files.diff && `/r/${compareId}/files/${diff.files.diff}`)}
      ${frame('after', diff.files.after && `/runs/${report.candidate.id}/files/${diff.files.after}`)}
    </div>
  </section>`;
}

export function renderReportHtml(report: CompareReport, compareId: string): string {
  const verdicts = new Map((report.verdicts ?? []).map((item) => [item.route, item]));
  const ordered = [...report.routes].sort((a, b) => {
    const rank = (diff: RouteDiff): number => {
      const level = verdicts.get(diff.route)?.level;
      if (level) {
        return LEVEL_RANK[level];
      }
      return diff.status === 'unchanged' ? 4 : 3;
    };
    return rank(a) - rank(b) || a.route.localeCompare(b.route);
  });

  const { summary } = report;
  const stats = [
    `<span class="stat"><b>${summary.total}</b> routes</span>`,
    `<span class="stat"><b>${summary.unchanged}</b> unchanged</span>`,
    `<span class="stat"><b>${summary.changed}</b> changed</span>`,
    `<span class="stat"><b>${summary.added}</b> added</span>`,
    `<span class="stat"><b>${summary.removed}</b> removed</span>`,
    `<span class="stat"><b>${summary.unverified}</b> unverified</span>`,
  ].join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>routeshot &middot; ${escapeHtml(report.candidate.label)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
  <h1>${escapeHtml(report.candidate.label)} vs ${escapeHtml(report.baseline.label)}</h1>
  <p class="sub">threshold ${report.threshold} &middot; baseline <code>${escapeHtml(report.baseline.id)}</code> &middot; candidate <code>${escapeHtml(report.candidate.id)}</code></p>
  <div class="summary">${stats}</div>
  ${ordered.map((diff) => routeSection(diff, verdicts.get(diff.route), report, compareId)).join('\n')}
</main>
</body>
</html>`;
}
