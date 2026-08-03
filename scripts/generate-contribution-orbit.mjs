#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SVG_WIDTH = 960;
const SVG_HEIGHT = 420;
const CELL_SIZE = 9;
const CELL_GAP = 3;
const GRID_X = 46;
const GRID_Y = 169;
const LOOP_SECONDS = 18;

const ORBIT_PATH = [
  "M 56 247",
  "L 56 160",
  "C 430 140, 724 148, 682 193",
  "C 654 221, 352 203, 56 203",
  "C 358 201, 650 204, 696 235",
  "C 748 270, 438 261, 56 247",
].join(" ");

const INTENSITY = ["#111a31", "#17254d", "#233a78", "#3656aa", "#6d5dfc"];
const ACCENTS = ["#54c7ff", "#7c5cff", "#b85cff"];

function parseArgs(argv) {
  const values = {
    login: process.env.GITHUB_REPOSITORY_OWNER || "bbb-build",
    output: "assets/proof-of-contribution.svg",
    input: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--login") values.login = argv[++index];
    else if (argument === "--output") values.output = argv[++index];
    else if (argument === "--input") values.input = argv[++index];
    else if (argument === "--help") {
      console.log("Usage: node scripts/generate-contribution-orbit.mjs [--login USER] [--output FILE] [--input JSON]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return values;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function fetchCalendar(login, token) {
  if (!token) {
    throw new Error("GITHUB_TOKEN is required when --input is not provided");
  }

  const query = `
    query ContributionOrbit($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                contributionCount
                date
                weekday
              }
            }
          }
        }
      }
    }
  `;

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "bbb-build-contribution-orbit",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ query, variables: { login } }),
  });

  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed: ${response.status} ${response.statusText}`);
  }

  const body = await response.json();
  if (body.errors?.length) {
    throw new Error(`GitHub GraphQL error: ${body.errors.map((error) => error.message).join("; ")}`);
  }

  const calendar = body.data?.user?.contributionsCollection?.contributionCalendar;
  if (!calendar) throw new Error(`GitHub user not found: ${login}`);
  return calendar;
}

function normalizeCalendar(calendar) {
  const weeks = calendar.weeks.map((week) => ({
    contributionDays: week.contributionDays.map((day) => ({
      contributionCount: Number(day.contributionCount) || 0,
      date: day.date,
      weekday: Number(day.weekday),
    })),
  }));

  return {
    totalContributions: Number(calendar.totalContributions) || 0,
    weeks,
  };
}

function streaks(days) {
  let longest = 0;
  let running = 0;
  for (const day of days) {
    if (day.contributionCount > 0) {
      running += 1;
      longest = Math.max(longest, running);
    } else {
      running = 0;
    }
  }
  return longest;
}

function monthLabels(weeks) {
  const labels = [];
  let previousMonth = -1;
  for (let column = 0; column < weeks.length; column += 1) {
    const firstDay = weeks[column].contributionDays[0];
    if (!firstDay) continue;
    const date = new Date(`${firstDay.date}T00:00:00Z`);
    const month = date.getUTCMonth();
    if (month !== previousMonth && column > 1) {
      labels.push({
        column,
        text: date.toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase(),
      });
    }
    previousMonth = month;
  }
  return labels;
}

function quantileThresholds(days) {
  const positive = days
    .map((day) => day.contributionCount)
    .filter((count) => count > 0)
    .sort((a, b) => a - b);

  if (!positive.length) return [1, 2, 3, 4];
  return [0.2, 0.45, 0.7, 0.9].map((quantile) => positive[Math.floor((positive.length - 1) * quantile)]);
}

function intensityIndex(count, thresholds) {
  if (count <= 0) return 0;
  if (count <= thresholds[0]) return 1;
  if (count <= thresholds[1]) return 2;
  if (count <= thresholds[2]) return 3;
  return 4;
}

function formatNumber(number) {
  return new Intl.NumberFormat("en-US").format(number);
}

function buildCells(weeks, thresholds) {
  const cells = [];
  const candidates = [];

  weeks.forEach((week, column) => {
    week.contributionDays.forEach((day) => {
      const row = day.weekday;
      const x = GRID_X + column * (CELL_SIZE + CELL_GAP);
      const y = GRID_Y + row * (CELL_SIZE + CELL_GAP);
      const level = intensityIndex(day.contributionCount, thresholds);
      const scanDelay = 1.1 + (column / Math.max(weeks.length - 1, 1)) * 12.8 + row * 0.035;
      const accent = ACCENTS[(column + row) % ACCENTS.length];

      cells.push(`
        <rect class="day level-${level}" x="${x}" y="${y}" width="${CELL_SIZE}" height="${CELL_SIZE}" rx="2" fill="${INTENSITY[level]}" opacity="0.82" aria-label="${escapeXml(day.date)}: ${day.contributionCount} contributions">
          <animate attributeName="fill" values="${INTENSITY[level]};${accent};${INTENSITY[level]};${INTENSITY[level]}" keyTimes="0;0.035;0.08;1" begin="${scanDelay.toFixed(2)}s" dur="${LOOP_SECONDS}s" repeatCount="indefinite"/>
          <animate attributeName="opacity" values="0.82;1;0.82;0.82" keyTimes="0;0.035;0.08;1" begin="${scanDelay.toFixed(2)}s" dur="${LOOP_SECONDS}s" repeatCount="indefinite"/>
        </rect>`);

      if (day.contributionCount > 0) {
        candidates.push({ ...day, x: x + CELL_SIZE / 2, y: y + CELL_SIZE / 2, scanDelay });
      }
    });
  });

  const checks = candidates
    .sort((a, b) => b.contributionCount - a.contributionCount)
    .slice(0, 7)
    .sort((a, b) => a.x - b.x)
    .map((day, index) => {
      const delay = (day.scanDelay + 0.4 + index * 0.08) % LOOP_SECONDS;
      return `
        <g class="verification" transform="translate(${day.x.toFixed(1)} ${day.y.toFixed(1)})">
          <circle r="9" fill="#0c1835" stroke="${ACCENTS[index % ACCENTS.length]}" stroke-width="1.3"/>
          <path d="M -4 0 L -1 3 L 5 -4" fill="none" stroke="#eef7ff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          <animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.08;0.15;0.72;1" begin="${delay.toFixed(2)}s" dur="${LOOP_SECONDS}s" repeatCount="indefinite"/>
          <animateTransform attributeName="transform" additive="sum" type="scale" values="0.25;0.25;1.15;1;1" keyTimes="0;0.08;0.14;0.2;1" begin="${delay.toFixed(2)}s" dur="${LOOP_SECONDS}s" repeatCount="indefinite"/>
        </g>`;
    });

  return { cells: cells.join(""), checks: checks.join("") };
}

export function renderContributionSvg(rawCalendar, login = "bbb-build") {
  const calendar = normalizeCalendar(rawCalendar);
  const days = calendar.weeks.flatMap((week) => week.contributionDays);
  const activeDays = days.filter((day) => day.contributionCount > 0).length;
  const longestStreak = streaks(days);
  const peak = days.reduce(
    (best, day) => (day.contributionCount > best.contributionCount ? day : best),
    { contributionCount: 0, date: "—" },
  );
  const thresholds = quantileThresholds(days);
  const { cells, checks } = buildCells(calendar.weeks, thresholds);
  const labels = monthLabels(calendar.weeks)
    .map(({ column, text }) => `<text class="month" x="${GRID_X + column * (CELL_SIZE + CELL_GAP)}" y="151">${text}</text>`)
    .join("");
  const lastDay = days.at(-1)?.date || "—";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" role="img" aria-labelledby="title description">
  <title id="title">Proof of Contribution for ${escapeXml(login)}</title>
  <desc id="description">An animated blue and violet Orb traces the letter B across ${formatNumber(calendar.totalContributions)} GitHub contributions from the last twelve months, scanning contribution cells and revealing verification checks.</desc>

  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#070b18"/>
      <stop offset="0.52" stop-color="#0a1024"/>
      <stop offset="1" stop-color="#100b25"/>
    </linearGradient>
    <linearGradient id="border" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#54c7ff" stop-opacity="0.68"/>
      <stop offset="0.52" stop-color="#6d5dfc" stop-opacity="0.24"/>
      <stop offset="1" stop-color="#b85cff" stop-opacity="0.64"/>
    </linearGradient>
    <linearGradient id="orbit" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#54c7ff"/>
      <stop offset="0.52" stop-color="#7c5cff"/>
      <stop offset="1" stop-color="#d15cff"/>
    </linearGradient>
    <radialGradient id="orb" cx="34%" cy="28%" r="72%">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.18" stop-color="#c9f1ff"/>
      <stop offset="0.5" stop-color="#62c7ff"/>
      <stop offset="0.78" stop-color="#795cff"/>
      <stop offset="1" stop-color="#d15cff"/>
    </radialGradient>
    <filter id="softGlow" x="-100%" y="-100%" width="300%" height="300%">
      <feGaussianBlur stdDeviation="5" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="orbGlow" x="-200%" y="-200%" width="500%" height="500%">
      <feGaussianBlur stdDeviation="9" result="blur"/>
      <feFlood flood-color="#6d7cff" flood-opacity="0.92"/>
      <feComposite in2="blur" operator="in"/>
      <feMerge><feMergeNode/><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <pattern id="microGrid" width="24" height="24" patternUnits="userSpaceOnUse">
      <path d="M 24 0 L 0 0 0 24" fill="none" stroke="#92a4d8" stroke-opacity="0.045" stroke-width="1"/>
    </pattern>
    <style>
      text { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
      .eyebrow { fill: #7dd7ff; font-size: 11px; font-weight: 700; letter-spacing: 2.4px; }
      .heading { fill: #f4f7ff; font-size: 27px; font-weight: 760; letter-spacing: -0.6px; }
      .subheading { fill: #8f9cc2; font-size: 11px; letter-spacing: 0.35px; }
      .month { fill: #687699; font-size: 9px; letter-spacing: 0.6px; }
      .panel-label { fill: #64739a; font-size: 9px; letter-spacing: 1.15px; }
      .panel-value { fill: #eef4ff; font-size: 18px; font-weight: 740; }
      .panel-detail { fill: #8391b4; font-size: 8.5px; }
      .footer { fill: #64739a; font-size: 9px; letter-spacing: 0.8px; }
      .day { shape-rendering: geometricPrecision; }
      .verification { opacity: 0; filter: url(#softGlow); }
      @media (prefers-reduced-motion: reduce) {
        animate, animateMotion, animateTransform { display: none; }
        .verification { opacity: 1; }
      }
    </style>
  </defs>

  <rect x="1" y="1" width="958" height="418" rx="22" fill="url(#background)" stroke="url(#border)" stroke-width="1.5"/>
  <rect x="14" y="14" width="932" height="392" rx="16" fill="url(#microGrid)" stroke="#6374aa" stroke-opacity="0.14"/>

  <g transform="translate(44 39)">
    <circle cx="5" cy="5" r="4" fill="#54c7ff" filter="url(#softGlow)">
      <animate attributeName="opacity" values="0.45;1;0.45" dur="2.4s" repeatCount="indefinite"/>
    </circle>
    <text class="eyebrow" x="20" y="9">HUMAN × CODE / LIVE SIGNAL</text>
    <text class="heading" x="0" y="48">PROOF OF CONTRIBUTION</text>
    <text class="subheading" x="1" y="71">A public trail of building, reviewing, and shipping.</text>
  </g>

  <g transform="translate(738 39)">
    <rect width="176" height="79" rx="13" fill="#101831" fill-opacity="0.74" stroke="#526da9" stroke-opacity="0.32"/>
    <text class="panel-label" x="17" y="23">12 MONTH SIGNAL</text>
    <text class="panel-value" x="17" y="49">${formatNumber(calendar.totalContributions)}</text>
    <text class="panel-detail" x="17" y="66">CONTRIBUTIONS · THROUGH ${escapeXml(lastDay)}</text>
    <circle cx="151" cy="39" r="10" fill="none" stroke="#54c7ff" stroke-opacity="0.28"/>
    <circle cx="151" cy="39" r="4.5" fill="url(#orb)" filter="url(#softGlow)"/>
  </g>

  <g aria-label="Contribution calendar">
    ${labels}
    ${cells}
  </g>

  <path d="${ORBIT_PATH}" fill="none" stroke="#7d8ac0" stroke-opacity="0.16" stroke-width="1.2" stroke-dasharray="2 7"/>
  <path d="${ORBIT_PATH}" pathLength="1" fill="none" stroke="url(#orbit)" stroke-width="1.25" stroke-linecap="round" stroke-dasharray="1" stroke-dashoffset="1" filter="url(#softGlow)">
    <animate attributeName="stroke-dashoffset" values="1;0;0;1" keyTimes="0;0.76;0.92;1" dur="${LOOP_SECONDS}s" repeatCount="indefinite"/>
    <animate attributeName="stroke-opacity" values="0.08;0.48;0.2;0.08" keyTimes="0;0.76;0.92;1" dur="${LOOP_SECONDS}s" repeatCount="indefinite"/>
  </path>
  <path d="${ORBIT_PATH}" pathLength="1" fill="none" stroke="url(#orbit)" stroke-width="2" stroke-linecap="round" stroke-dasharray="0.025 0.975" filter="url(#softGlow)">
    <animate attributeName="stroke-dashoffset" from="0" to="-1" dur="${LOOP_SECONDS}s" repeatCount="indefinite"/>
  </path>

  ${checks}

  <g filter="url(#orbGlow)">
    <circle r="16" fill="#5f74ff" opacity="0.14"/>
    <circle r="10" fill="url(#orb)" stroke="#e6f8ff" stroke-opacity="0.76" stroke-width="1"/>
    <ellipse cx="-2.5" cy="-3.5" rx="3.4" ry="2.4" fill="#ffffff" opacity="0.8"/>
    <path d="M -21 0 L -10 -5 L -10 5 Z" fill="#65d2ff" opacity="0.18"/>
    <animateMotion path="${ORBIT_PATH}" dur="${LOOP_SECONDS}s" repeatCount="indefinite" rotate="auto"/>
  </g>

  <g transform="translate(45 290)">
    <line x1="0" y1="0" x2="870" y2="0" stroke="#6073a9" stroke-opacity="0.19"/>

    <g transform="translate(0 24)">
      <text class="panel-label" x="0" y="0">ACTIVE DAYS</text>
      <text class="panel-value" x="0" y="25">${formatNumber(activeDays)}</text>
      <text class="panel-detail" x="0" y="42">DAYS WITH A PUBLIC SIGNAL</text>
    </g>

    <g transform="translate(238 24)">
      <text class="panel-label" x="0" y="0">LONGEST STREAK</text>
      <text class="panel-value" x="0" y="25">${formatNumber(longestStreak)} DAYS</text>
      <text class="panel-detail" x="0" y="42">CONSISTENT BUILDING WINDOW</text>
    </g>

    <g transform="translate(500 24)">
      <text class="panel-label" x="0" y="0">PEAK DAY</text>
      <text class="panel-value" x="0" y="25">${formatNumber(peak.contributionCount)}</text>
      <text class="panel-detail" x="0" y="42">CONTRIBUTIONS · ${escapeXml(peak.date)}</text>
    </g>

    <g transform="translate(752 20)">
      <rect width="118" height="47" rx="11" fill="#111b38" stroke="#6a64d8" stroke-opacity="0.48"/>
      <circle cx="18" cy="23.5" r="7" fill="none" stroke="#65d2ff"/>
      <path d="M 14 23 L 17 26 L 22 20" fill="none" stroke="#f1f8ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <text class="eyebrow" x="34" y="27">B VERIFIED</text>
    </g>
  </g>

  <g transform="translate(45 390)">
    <text class="footer">ORB TRACE / B · BUILD · VERIFY · SHIP</text>
    <text class="footer" x="870" text-anchor="end">@${escapeXml(login)}</text>
  </g>
</svg>
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let calendar;
  if (options.input) {
    calendar = JSON.parse(await readFile(resolve(options.input), "utf8"));
  } else {
    calendar = await fetchCalendar(options.login, process.env.GITHUB_TOKEN);
  }

  const outputPath = resolve(options.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderContributionSvg(calendar, options.login), "utf8");
  console.log(`Generated ${outputPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
