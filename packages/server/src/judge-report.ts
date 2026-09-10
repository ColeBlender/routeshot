import type { CaptureRun, Verdict, VerdictLevel } from './types.js';

/**
 * One self-contained `report.html` for a judged run: every screen with its verdict, worst first,
 * the suspected region drawn over the screenshot. No bundler, no CDN, no fonts: it opens from
 * disk and from a CI artifact.
 */
const LEVEL_ORDER: Record<VerdictLevel, number> = { red: 0, yellow: 1, unverified: 2, green: 3 };

export interface JudgeReportOptions {
  /**
   * Where a screenshot lives relative to the page. Defaults to the bare file name, which is right
   * for a report written into the run directory; the server points it at its own file route.
   */
  fileUrl?: (name: string) => string;
}

export function renderJudgeReport(
  run: CaptureRun,
  verdicts: Verdict[],
  options: JudgeReportOptions = {}
): string {
  const fileUrl = options.fileUrl ?? ((name: string): string => name);
  const entries = new Map(run.routes.map((entry) => [entry.route, entry]));
  const ordered = [...verdicts].sort(
    (a, b) =>
      LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] ||
      (b.score ?? 0) - (a.score ?? 0) ||
      a.route.localeCompare(b.route)
  );
  const count = (level: VerdictLevel): number =>
    verdicts.filter((item) => item.level === level).length;
  const affected = run.affected
    ? `<p class="ids">${run.affected.changedFiles.length} file(s) changed since ${escapeHtml(run.affected.since)}${run.affected.all ? `, ${escapeHtml(run.affected.all)} affects every screen` : ''}</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>routeshot ${escapeHtml(run.label)}</title>
<style>${STYLES}</style>
</head>
<body>
<header>
  <h1>routeshot</h1>
  <p class="runs"><span class="run">${escapeHtml(run.label)}</span></p>
  <p class="ids">${escapeHtml(run.id)} &middot; ${escapeHtml(run.device.name)} &middot; ${escapeHtml(run.device.runtime)}</p>
  ${affected}
</header>
<section class="summary">
${(['red', 'yellow', 'unverified', 'green'] as const)
  .map(
    (level) =>
      `  <div class="stat ${level}"><span class="count">${count(level)}</span><span class="label">${level}</span></div>`
  )
  .join('\n')}
  <div class="stat"><span class="count">${verdicts.length}</span><span class="label">screens</span></div>
</section>
<main>
${ordered
  .map((verdict) => {
    const entry = entries.get(verdict.route);
    const because = run.affected?.because[verdict.route];
    const region = verdict.region
      ? `<span class="region" style="left:${pct(verdict.region.x)};top:${pct(verdict.region.y)};width:${pct(verdict.region.w)};height:${pct(verdict.region.h)}"></span>`
      : '';
    const shot = entry?.file
      ? `<figure class="shot">${region}<img loading="lazy" src="${escapeHtml(fileUrl(entry.file))}" alt="${escapeHtml(verdict.route)}"></figure>`
      : '';
    return `<article class="route ${verdict.level}">
  <div class="route-head">
    <span class="verdict ${verdict.level}">${verdict.level}</span>
    <h2>${escapeHtml(verdict.route)}</h2>
    ${verdict.score === undefined ? '' : `<span class="meta">score ${verdict.score}</span>`}
    ${verdict.defect === 'none' ? '' : `<span class="meta">${escapeHtml(verdict.defect)}</span>`}
  </div>
  <p class="caption">${escapeHtml(verdict.caption)}</p>
  ${because ? `<p class="reason">changed: ${escapeHtml(because.join(', '))}</p>` : ''}
  ${entry?.code ? `<p class="reason">judged against <code>${escapeHtml(entry.code)}</code></p>` : ''}
  ${shot}
</article>`;
  })
  .join('\n')}
</main>
</body>
</html>
`;
}

function pct(value: number): string {
  return `${(Math.min(Math.max(value, 0), 1) * 100).toFixed(2)}%`;
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
  --red: #ff5f56; --yellow: #f2c53c; --green: #3ec98a; --unverified: #8b93a5;
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 32px; background: var(--bg); color: var(--text);
  font: 14px/1.5 ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
}
header h1 { margin: 0; font-size: 18px; letter-spacing: 0.14em; text-transform: uppercase; }
.runs { margin: 8px 0 4px; font-size: 20px; font-weight: 600; }
.ids { margin: 0; color: var(--muted); font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; }
.summary { display: flex; flex-wrap: wrap; gap: 12px; margin: 24px 0 32px; }
.stat {
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  padding: 12px 18px; min-width: 104px;
}
.stat .count { display: block; font-size: 24px; font-weight: 700; }
.stat .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
.stat.red .count { color: var(--red); }
.stat.yellow .count { color: var(--yellow); }
.stat.green .count { color: var(--green); }
.stat.unverified .count { color: var(--unverified); }
.route {
  background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
  padding: 18px; margin-bottom: 18px;
}
.route.red { border-color: var(--red); }
.route.yellow { border-color: var(--yellow); }
.route-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.route-head h2 { margin: 0; font-size: 16px; font-family: ui-monospace, SFMono-Regular, monospace; }
.meta { color: var(--muted); font-size: 12px; }
.verdict { font-size: 11px; text-transform: uppercase; padding: 3px 8px; border-radius: 999px; color: #0a0b0e; }
.verdict.red { background: var(--red); }
.verdict.yellow { background: var(--yellow); }
.verdict.green { background: var(--green); }
.verdict.unverified { background: var(--muted); }
.caption { margin: 10px 0 0; }
.reason { margin: 6px 0 0; color: var(--muted); font-size: 13px; }
.reason code { font-family: ui-monospace, SFMono-Regular, monospace; }
.shot { position: relative; display: inline-block; margin: 14px 0 0; }
.shot img {
  display: block; max-height: 520px; width: auto; border-radius: 8px; border: 1px solid var(--line);
  background: #000;
}
.region {
  position: absolute; border: 2px solid var(--red); border-radius: 4px;
  box-shadow: 0 0 0 2px rgba(255, 95, 86, 0.35); pointer-events: none;
}
.route.green .shot img { max-height: 260px; }
`;
