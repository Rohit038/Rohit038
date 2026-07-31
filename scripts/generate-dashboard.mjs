#!/usr/bin/env node
/**
 * Generates dashboard.svg — a live "GitHub Profile Analytics Coach" style
 * card (dark/gold theme) for a GitHub profile README.
 *
 * Data sources (all live, fetched at run time):
 *   - REST  /users/:login                     -> name, bio, followers, public_repos
 *   - REST  /users/:login/repos                -> per-repo stars/forks/description/language
 *   - REST  /repos/:owner/:repo/languages      -> byte counts per language (aggregated)
 *   - REST  /search/issues                     -> PR count, issue count authored by user
 *   - GraphQL contributionsCollection          -> contribution calendar (heatmap)
 *
 * Followers-over-time and health-score-over-time have no public historical
 * API, so this script appends one data point per run to data/history.json
 * (committed back to the repo by the workflow) and charts real accumulated
 * history from the day tracking started.
 *
 * Env vars:
 *   GH_LOGIN        GitHub username to profile (default: Rohit038)
 *   GITHUB_TOKEN     token used for auth'd REST + GraphQL calls (higher rate
 *                    limits + required for the contribution calendar)
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import path from "path";

const LOGIN = process.env.GH_LOGIN || "Rohit038";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const OUT_SVG = process.env.OUT_SVG || "dashboard.svg";
const HISTORY_PATH = process.env.HISTORY_PATH || "data/history.json";

const REST_HEADERS = {
  "User-Agent": "profile-dashboard-generator",
  Accept: "application/vnd.github+json",
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

async function restGet(url) {
  const res = await fetch(url, { headers: REST_HEADERS });
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function graphql(query, variables) {
  if (!TOKEN) return null; // no token -> skip, caller must handle fallback
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "User-Agent": "profile-dashboard-generator",
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) return null;
  const json = await res.json();
  if (json.errors) return null;
  return json.data;
}

// ---------------------------------------------------------------------------
// 1. Fetch profile + repos
// ---------------------------------------------------------------------------
async function fetchProfile() {
  return restGet(`https://api.github.com/users/${LOGIN}`);
}

async function fetchAllRepos() {
  let page = 1;
  const all = [];
  for (;;) {
    const batch = await restGet(
      `https://api.github.com/users/${LOGIN}/repos?per_page=100&page=${page}&type=owner`
    );
    all.push(...batch);
    if (batch.length < 100) break;
    page += 1;
    if (page > 10) break; // safety cap
  }
  return all;
}

async function fetchLanguageTotals(repos) {
  const totals = {};
  // limit concurrent requests to be polite to the API
  const nonForks = repos.filter((r) => !r.fork);
  for (const repo of nonForks) {
    try {
      const langs = await restGet(
        `https://api.github.com/repos/${LOGIN}/${repo.name}/languages`
      );
      for (const [lang, bytes] of Object.entries(langs)) {
        totals[lang] = (totals[lang] || 0) + bytes;
      }
    } catch {
      // ignore individual repo failures (e.g. empty repo)
    }
  }
  return totals;
}

async function fetchPrAndIssueCounts() {
  const [prs, issues] = await Promise.all([
    restGet(
      `https://api.github.com/search/issues?q=author:${LOGIN}+type:pr`
    ).catch(() => ({ total_count: 0 })),
    restGet(
      `https://api.github.com/search/issues?q=author:${LOGIN}+type:issue`
    ).catch(() => ({ total_count: 0 })),
  ]);
  return { prCount: prs.total_count || 0, issueCount: issues.total_count || 0 };
}

async function fetchContributionCalendar() {
  const query = `
    query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                date
                contributionCount
              }
            }
          }
        }
      }
    }
  `;
  const data = await graphql(query, { login: LOGIN });
  if (!data || !data.user) return null;
  return data.user.contributionsCollection.contributionCalendar;
}

// ---------------------------------------------------------------------------
// 2. History (followers / health score over time) — accumulates real data
// ---------------------------------------------------------------------------
function loadHistory() {
  if (existsSync(HISTORY_PATH)) {
    try {
      return JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
    } catch {
      return { points: [] };
    }
  }
  return { points: [] };
}

function saveHistory(history) {
  mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

// ---------------------------------------------------------------------------
// 3. Health score + tips (computed from real, current profile state)
// ---------------------------------------------------------------------------
function computeHealth({ profile, repos, calendar }) {
  const nonForks = repos.filter((r) => !r.fork);
  const withDesc = nonForks.filter((r) => r.description && r.description.trim());
  const descRatio = nonForks.length ? withDesc.length / nonForks.length : 0;
  const hasProfileReadme = repos.some(
    (r) => r.name.toLowerCase() === LOGIN.toLowerCase()
  );

  let recentStreakDays = 0;
  if (calendar) {
    const days = calendar.weeks.flatMap((w) => w.contributionDays);
    for (let i = days.length - 1; i >= 0; i--) {
      if (days[i].contributionCount > 0) recentStreakDays += 1;
      else break;
    }
  }

  const scoreReadme = hasProfileReadme ? 20 : 0;
  const scoreDesc = Math.round(descRatio * 30);
  const scoreRepos = Math.min(nonForks.length, 5) * 2; // up to 10
  const scoreFollowers = Math.min(profile.followers, 10) * 1; // up to 10
  const scoreStreak = Math.min(recentStreakDays, 30) / 30 * 30; // up to 30

  const score = Math.round(
    scoreReadme + scoreDesc + scoreRepos + scoreFollowers + scoreStreak
  );

  const tips = [];
  if (!hasProfileReadme) {
    tips.push({ text: "Add a Profile README", detail: "+20 points (showcase your skills)" });
  }
  const missingDesc = nonForks.length - withDesc.length;
  if (missingDesc > 0) {
    tips.push({
      text: "Complete Repo Descriptions",
      detail: `+${Math.min(30, 30 - scoreDesc)} points (${missingDesc} repo${missingDesc > 1 ? "s" : ""} missing one)`,
    });
  }
  if (recentStreakDays < 30) {
    tips.push({ text: "Start a 30-day Commit Streak", detail: "+30 points (improve consistency)" });
  }
  if (profile.followers < 10) {
    tips.push({ text: "Grow Your Network", detail: "+10 points (follow & engage with peers)" });
  }
  if (tips.length === 0) {
    tips.push({ text: "Profile is in great shape", detail: "keep the streak going!" });
  }

  return { score: Math.min(score, 100), tips: tips.slice(0, 3), recentStreakDays, descRatio, missingDesc };
}

// ---------------------------------------------------------------------------
// 4. SVG rendering helpers
// ---------------------------------------------------------------------------
const GOLD = "#e8b64a";
const GOLD_DIM = "#c98b2e";
const BG = "#0d0d0d";
const PANEL = "#161616";
const BORDER = "#3a2f18";
const TEXT_DIM = "#a8a8a8";

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function heatColor(count, max) {
  if (!count) return "#2a2317";
  const ratio = Math.min(count / Math.max(max, 1), 1);
  // interpolate between dim gold and bright gold
  const stops = ["#4d3d1c", "#7a5c22", "#a8802a", "#d1a437", GOLD];
  const idx = Math.min(Math.floor(ratio * (stops.length - 1)), stops.length - 2);
  return stops[idx + 1];
}

function buildHeatmap(calendar, x, y, w) {
  if (!calendar) {
    return `<text x="${x}" y="${y + 20}" class="sans dim" font-size="12">Contribution calendar unavailable (no token at build time)</text>`;
  }
  const weeks = calendar.weeks;
  const gap = 2;
  const cell = Math.min(11, (w - gap * (weeks.length - 1)) / weeks.length);
  const max = Math.max(...weeks.flatMap((wk) => wk.contributionDays.map((d) => d.contributionCount)), 1);
  let out = "";
  weeks.forEach((wk, wi) => {
    wk.contributionDays.forEach((d, di) => {
      const cx = x + wi * (cell + gap);
      const cy = y + di * (cell + gap);
      out += `<rect x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" width="${cell.toFixed(1)}" height="${cell.toFixed(1)}" rx="2" fill="${heatColor(d.contributionCount, max)}"><title>${d.date}: ${d.contributionCount} contributions</title></rect>`;
    });
  });
  return out;
}

function buildDonut(langTotals, cx, cy, r) {
  const entries = Object.entries(langTotals).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
  const top = entries.slice(0, 4);
  const otherBytes = entries.slice(4).reduce((s, [, v]) => s + v, 0);
  if (otherBytes > 0) top.push(["Other", otherBytes]);

  const colors = [GOLD, GOLD_DIM, "#8a6a24", "#5c4718", "#3a2f18"];
  let startAngle = -90;
  let arcs = "";
  const legend = [];
  top.forEach(([lang, bytes], i) => {
    const pct = bytes / total;
    const angle = pct * 360;
    const endAngle = startAngle + angle;
    const large = angle > 180 ? 1 : 0;
    const x1 = cx + r * Math.cos((Math.PI * startAngle) / 180);
    const y1 = cy + r * Math.sin((Math.PI * startAngle) / 180);
    const x2 = cx + r * Math.cos((Math.PI * endAngle) / 180);
    const y2 = cy + r * Math.sin((Math.PI * endAngle) / 180);
    arcs += `<path d="M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z" fill="${colors[i % colors.length]}" opacity="0.92"/>`;
    legend.push({ lang, pct: (pct * 100).toFixed(0), color: colors[i % colors.length] });
    startAngle = endAngle;
  });
  arcs += `<circle cx="${cx}" cy="${cy}" r="${r * 0.55}" fill="${PANEL}"/>`;
  return { arcs, legend };
}

function buildBarChart(bars, x, y, w, h) {
  const max = Math.max(...bars.map((b) => b.value), 1);
  const gap = 18;
  const barW = (w - gap * (bars.length - 1)) / bars.length;
  let out = "";
  bars.forEach((b, i) => {
    const bh = (b.value / max) * (h - 24);
    const bx = x + i * (barW + gap);
    const by = y + (h - 24) - bh;
    out += `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="3" fill="${GOLD}" opacity="0.9"/>`;
    out += `<text x="${(bx + barW / 2).toFixed(1)}" y="${(by - 6).toFixed(1)}" text-anchor="middle" class="mono" font-size="12" fill="${GOLD}">${b.value}</text>`;
    out += `<text x="${(bx + barW / 2).toFixed(1)}" y="${(y + h).toFixed(1)}" text-anchor="middle" class="sans dim" font-size="10">${esc(b.label)}</text>`;
  });
  return out;
}

function buildLineChart(points, x, y, w, h) {
  if (points.length < 2) {
    return `<text x="${x}" y="${y + h / 2}" class="sans dim" font-size="12">Tracking starts today — check back after a few runs.</text>`;
  }
  const values = points.map((p) => p.followers);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 1);
  const stepX = w / (points.length - 1);
  const coords = points.map((p, i) => {
    const px = x + i * stepX;
    const py = y + h - ((p.followers - min) / range) * h;
    return [px, py];
  });
  const path = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(" ");
  const dots = coords
    .map((c) => `<circle cx="${c[0].toFixed(1)}" cy="${c[1].toFixed(1)}" r="3" fill="${GOLD}"/>`)
    .join("");
  return `<path d="${path}" fill="none" stroke="${GOLD}" stroke-width="2"/>${dots}`;
}

// ---------------------------------------------------------------------------
// 5. Main
// ---------------------------------------------------------------------------
async function main() {
  const profile = await fetchProfile();
  const repos = await fetchAllRepos();
  const [langTotals, { prCount, issueCount }, calendar] = await Promise.all([
    fetchLanguageTotals(repos),
    fetchPrAndIssueCounts(),
    fetchContributionCalendar(),
  ]);

  const totalStars = repos.reduce((s, r) => s + (r.stargazers_count || 0), 0);
  const totalForks = repos.reduce((s, r) => s + (r.forks_count || 0), 0);

  const health = computeHealth({ profile, repos, calendar });

  // update history
  const history = loadHistory();
  const today = new Date().toISOString().slice(0, 10);
  const already = history.points.find((p) => p.date === today);
  const point = { date: today, followers: profile.followers, healthScore: health.score };
  if (already) Object.assign(already, point);
  else history.points.push(point);
  // keep last 24 points for the chart
  const trimmed = { points: history.points.slice(-24) };
  saveHistory(trimmed);

  const donut = buildDonut(langTotals, 95, 490, 50);

  const W = 900;
  const H = 620;

  const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
<defs>
  <style>
    .sans { font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; fill: #f2f2f2; }
    .mono { font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; }
    .dim { fill: ${TEXT_DIM}; }
    .gold { fill: ${GOLD}; }
    .panel { fill: ${PANEL}; stroke: ${BORDER}; stroke-width: 1; rx: 10; }
    .title { font-weight: 700; }
  </style>
  <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
    <stop offset="0%" stop-color="#161207"/>
    <stop offset="100%" stop-color="#050505"/>
  </linearGradient>
</defs>

<rect width="${W}" height="${H}" fill="url(#bgGrad)" rx="14"/>
<rect x="1" y="1" width="${W - 2}" height="${H - 2}" fill="none" stroke="${BORDER}" stroke-width="2" rx="14"/>

<!-- Header -->
<text x="30" y="42" class="sans title gold" font-size="22">GITHUB PROFILE ANALYTICS COACH</text>
<line x1="30" y1="58" x2="${W - 30}" y2="58" stroke="${BORDER}" stroke-width="1"/>

<!-- Welcome + health score -->
<rect x="30" y="76" width="${W - 60}" height="70" class="panel"/>
<text x="50" y="107" class="sans dim" font-size="13">Welcome,</text>
<text x="50" y="130" class="sans title gold" font-size="18">@${esc(LOGIN)}</text>
<text x="620" y="107" class="sans dim" font-size="12">PROFILE HEALTH SCORE</text>
<text x="620" y="135" class="sans title gold" font-size="22">${health.score}/100</text>

<!-- Contribution heatmap -->
<rect x="30" y="160" width="530" height="200" class="panel"/>
<text x="50" y="188" class="sans title gold" font-size="14">CONTRIBUTION HEATMAP</text>
${buildHeatmap(calendar, 50, 205, 480)}
<text x="50" y="345" class="sans dim" font-size="10">Commit density (last 12 months, live)</text>

<!-- Tips -->
<rect x="575" y="160" width="295" height="200" class="panel"/>
<text x="595" y="188" class="sans title gold" font-size="14">ACTIONABLE TIPS</text>
${health.tips
  .map(
    (t, i) => `
<text x="595" y="${218 + i * 42}" class="sans" font-size="12">${i + 1}. ${esc(t.text)}</text>
<text x="595" y="${218 + i * 42 + 16}" class="sans dim" font-size="10">${esc(t.detail)}</text>`
  )
  .join("")}

<!-- Language distribution -->
<rect x="30" y="375" width="270" height="220" class="panel"/>
<text x="50" y="403" class="sans title gold" font-size="14">LANGUAGE DISTRIBUTION</text>
${donut.arcs}
${donut.legend
  .map(
    (l, i) => `
<circle cx="175" cy="${450 + i * 20}" r="4" fill="${l.color}"/>
<text x="186" y="${454 + i * 20}" class="sans" font-size="10">${esc(l.lang)} (${l.pct}%)</text>`
  )
  .join("")}

<!-- Repo stats bar chart -->
<rect x="315" y="375" width="270" height="220" class="panel"/>
<text x="335" y="403" class="sans title gold" font-size="14">REPOSITORY STATS</text>
${buildBarChart(
  [
    { label: "Stars", value: totalStars },
    { label: "Forks", value: totalForks },
    { label: "PRs", value: prCount },
    { label: "Issues", value: issueCount },
  ],
  335,
  418,
  230,
  150
)}

<!-- Follower growth -->
<rect x="600" y="375" width="270" height="220" class="panel"/>
<text x="620" y="403" class="sans title gold" font-size="14">FOLLOWER GROWTH</text>
${buildLineChart(trimmed.points, 620, 425, 230, 130)}
<text x="620" y="585" class="sans dim" font-size="10">Live count today: ${profile.followers}</text>

<text x="30" y="${H - 16}" class="sans dim" font-size="10">Generated ${new Date().toISOString()} · data via GitHub REST + GraphQL API</text>
</svg>`;

  writeFileSync(OUT_SVG, svg);
  console.log(`Wrote ${OUT_SVG}`);
  console.log(`Health score: ${health.score}, followers: ${profile.followers}, stars: ${totalStars}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
