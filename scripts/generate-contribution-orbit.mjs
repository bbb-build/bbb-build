#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const WIDTH = 960;
const HEIGHT = 430;
const GRID_X = 50;
const GRID_Y = 130;
const BRICK = 12;
const GAP = 3;
const ORB_RADIUS = 7;
const PADDLE_WIDTH = 94;
const PADDLE_Y = 361;
const PLAY_LEFT = 34;
const PLAY_RIGHT = 926;
const PLAY_TOP = 116;
const SPEED = 5.2;
const SAMPLE_EVERY = 5;
const MAX_FRAMES = 60000;
const LOOP_SECONDS = 38;
const PALETTE = ["#17213b", "#173e66", "#245ca0", "#4f63db", "#9b5cf6"];

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
    } else throw new Error(`Unknown argument: ${argument}`);
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
  if (!token) throw new Error("GITHUB_TOKEN is required when --input is not provided");
  const query = `query ContributionBreakout($login: String!) {
    user(login: $login) { contributionsCollection { contributionCalendar {
      totalContributions weeks { contributionDays { contributionCount date weekday } }
    } } }
  }`;
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "bbb-build-contribution-breakout",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ query, variables: { login } }),
  });
  if (!response.ok) throw new Error(`GitHub GraphQL request failed: ${response.status} ${response.statusText}`);
  const body = await response.json();
  if (body.errors?.length) throw new Error(`GitHub GraphQL error: ${body.errors.map((error) => error.message).join("; ")}`);
  const calendar = body.data?.user?.contributionsCollection?.contributionCalendar;
  if (!calendar) throw new Error(`GitHub user not found: ${login}`);
  return calendar;
}

function normalizeCalendar(calendar) {
  return {
    totalContributions: Number(calendar.totalContributions) || 0,
    weeks: calendar.weeks.map((week) => ({
      contributionDays: week.contributionDays.map((day) => ({
        contributionCount: Number(day.contributionCount) || 0,
        date: day.date,
        weekday: Number(day.weekday),
      })),
    })),
  };
}

function hashSeed(text) {
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let state = seed || 1;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function thresholds(days) {
  const values = days.map((day) => day.contributionCount).filter(Boolean).sort((a, b) => a - b);
  if (!values.length) return [1, 2, 3, 4];
  return [0.2, 0.45, 0.7, 0.9].map((q) => values[Math.floor((values.length - 1) * q)]);
}

function levelFor(count, cuts) {
  if (!count) return 0;
  if (count <= cuts[0]) return 1;
  if (count <= cuts[1]) return 2;
  if (count <= cuts[2]) return 3;
  return 4;
}

function buildBricks(calendar) {
  const days = calendar.weeks.flatMap((week) => week.contributionDays);
  const cuts = thresholds(days);
  const bricks = [];
  calendar.weeks.forEach((week, column) => {
    week.contributionDays.forEach((day) => {
      bricks.push({
        x: GRID_X + column * (BRICK + GAP),
        y: GRID_Y + day.weekday * (BRICK + GAP),
        count: day.contributionCount,
        date: day.date,
        level: levelFor(day.contributionCount, cuts),
        alive: day.contributionCount > 0,
        hitFrame: null,
      });
    });
  });
  return bricks;
}

function circleHitsBrick(x, y, brick) {
  const closestX = Math.max(brick.x, Math.min(x, brick.x + BRICK));
  const closestY = Math.max(brick.y, Math.min(y, brick.y + BRICK));
  const dx = x - closestX;
  const dy = y - closestY;
  return dx * dx + dy * dy <= ORB_RADIUS * ORB_RADIUS;
}

function aimAtBrick(x, y, target, random) {
  const targetX = target.x + BRICK / 2 + (random() - 0.5) * 7;
  const targetY = target.y + BRICK / 2;
  const dx = targetX - x;
  const dy = targetY - y;
  const length = Math.hypot(dx, dy) || 1;
  return { vx: (dx / length) * SPEED, vy: (dy / length) * SPEED };
}

export function simulateBreakout(bricks, seedText = "bbb-build") {
  const random = seededRandom(hashSeed(seedText));
  const active = bricks.filter((brick) => brick.alive);
  if (!active.length) return { frames: [{ x: WIDTH / 2, y: PADDLE_Y - 30, paddleX: WIDTH / 2 - PADDLE_WIDTH / 2 }], hits: [], completed: true };

  let x = WIDTH / 2;
  let y = PADDLE_Y - 24;
  let target = active[Math.floor(random() * active.length)];
  let { vx, vy } = aimAtBrick(x, y, target, random);
  let paddleX = x - PADDLE_WIDTH / 2;
  let lastHitFrame = 0;
  let frame = 0;
  const frames = [];
  const hits = [];

  while (active.some((brick) => brick.alive) && frame < MAX_FRAMES) {
    x += vx;
    y += vy;

    if (x <= PLAY_LEFT + ORB_RADIUS || x >= PLAY_RIGHT - ORB_RADIUS) {
      x = Math.max(PLAY_LEFT + ORB_RADIUS, Math.min(PLAY_RIGHT - ORB_RADIUS, x));
      vx = -vx;
    }
    if (y <= PLAY_TOP + ORB_RADIUS) {
      y = PLAY_TOP + ORB_RADIUS;
      vy = Math.abs(vy);
    }

    const desiredPaddleX = Math.max(PLAY_LEFT, Math.min(PLAY_RIGHT - PADDLE_WIDTH, x - PADDLE_WIDTH / 2));
    paddleX += (desiredPaddleX - paddleX) * 0.19;
    if (vy > 0 && y + ORB_RADIUS >= PADDLE_Y && y - ORB_RADIUS < PADDLE_Y + 10) {
      y = PADDLE_Y - ORB_RADIUS;
      const remaining = active.filter((brick) => brick.alive);
      target = remaining[Math.floor(random() * remaining.length)];
      ({ vx, vy } = aimAtBrick(x, y, target, random));
      vy = -Math.abs(vy);
    }

    const hit = active.find((brick) => brick.alive && circleHitsBrick(x, y, brick));
    if (hit) {
      hit.alive = false;
      hit.hitFrame = frame;
      hits.push({ brick: hit, frame, x: hit.x + BRICK / 2, y: hit.y + BRICK / 2 });
      lastHitFrame = frame;
      vy = vy > 0 ? Math.abs(vy) : -Math.abs(vy);
      if (y > hit.y + BRICK / 2) vy = Math.abs(vy);
      else vy = -Math.abs(vy);
      const angleJitter = (random() - 0.5) * 0.34;
      const angle = Math.atan2(vy, vx) + angleJitter;
      vx = Math.cos(angle) * SPEED;
      vy = Math.sin(angle) * SPEED;
    }

    // If a shallow angle misses the field for too long, the next paddle return
    // re-aims at a live contribution. This keeps every generated loop finite.
    if (frame - lastHitFrame > 1500 && vy < 0) {
      const remaining = active.filter((brick) => brick.alive);
      target = remaining[Math.floor(random() * remaining.length)];
      ({ vx, vy } = aimAtBrick(x, y, target, random));
      vy = -Math.abs(vy);
      lastHitFrame = frame - 900;
    }

    if (frame % SAMPLE_EVERY === 0) frames.push({ x, y, paddleX });
    frame += 1;
  }

  return { frames, hits, completed: !active.some((brick) => brick.alive), totalFrames: frame };
}

function compactValues(values) {
  return values.map((value) => Number(value).toFixed(1)).join(";");
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

export function renderContributionSvg(rawCalendar, login = "bbb-build") {
  const calendar = normalizeCalendar(rawCalendar);
  const bricks = buildBricks(calendar);
  const simulation = simulateBreakout(bricks, `${login}:${bricks.at(-1)?.date || "empty"}:${calendar.totalContributions}`);
  if (!simulation.completed) throw new Error("Breakout simulation did not clear every active contribution brick");

  const activeBricks = bricks.filter((brick) => brick.count > 0);
  const sampledDuration = LOOP_SECONDS;
  const pauseFraction = 0.055;
  const movementEnd = 1 - pauseFraction;
  const ballX = compactValues(simulation.frames.map((state) => state.x));
  const ballY = compactValues(simulation.frames.map((state) => state.y));
  const paddleX = compactValues(simulation.frames.map((state) => state.paddleX));
  const firstFrame = simulation.frames[0];

  const brickSvg = bricks.map((brick) => {
    const fill = PALETTE[brick.level];
    const base = `<rect x="${brick.x}" y="${brick.y}" width="${BRICK}" height="${BRICK}" rx="3" fill="${fill}"`;
    if (!brick.count) return `${base} opacity="0.32"/>`;
    const hit = simulation.hits.find((entry) => entry.brick === brick);
    const time = Math.min(movementEnd, (hit.frame / Math.max(simulation.totalFrames, 1)) * movementEnd).toFixed(5);
    return `${base} aria-label="${escapeXml(brick.date)}: ${brick.count} contributions">
      <animate attributeName="opacity" values="1;1;0;0;1" keyTimes="0;${time};${time};${movementEnd};1" dur="${sampledDuration.toFixed(2)}s" repeatCount="indefinite"/>
    </rect>`;
  }).join("");

  const impactSvg = simulation.hits.map((hit, index) => {
    const time = Math.min(movementEnd, (hit.frame / Math.max(simulation.totalFrames, 1)) * movementEnd);
    const end = Math.min(movementEnd, time + 0.012);
    return `<g transform="translate(${hit.x} ${hit.y})" opacity="0">
      <circle r="4" fill="none" stroke="${index % 2 ? "#a96bff" : "#66d8ff"}" stroke-width="1.5"/>
      <path d="M-3 0l2 2 4-5" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
      <animate attributeName="opacity" values="0;0;1;0;0" keyTimes="0;${time.toFixed(5)};${Math.min(end, time + 0.002).toFixed(5)};${end.toFixed(5)};1" dur="${sampledDuration.toFixed(2)}s" repeatCount="indefinite"/>
      <animateTransform attributeName="transform" additive="sum" type="scale" values=".4;.4;1.35;1.8;1.8" keyTimes="0;${time.toFixed(5)};${Math.min(end, time + 0.002).toFixed(5)};${end.toFixed(5)};1" dur="${sampledDuration.toFixed(2)}s" repeatCount="indefinite"/>
    </g>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="title description">
  <title id="title">Contribution Breakout for ${escapeXml(login)}</title>
  <desc id="description">A glowing blue and violet Orb plays Breakout against ${activeBricks.length} active days from ${formatNumber(calendar.totalContributions)} GitHub contributions, with a moving paddle and verification flashes on impact.</desc>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#060914"/><stop offset=".58" stop-color="#0a1023"/><stop offset="1" stop-color="#130a25"/></linearGradient>
    <linearGradient id="edge"><stop stop-color="#5bd6ff"/><stop offset=".55" stop-color="#6964ff"/><stop offset="1" stop-color="#bc5cff"/></linearGradient>
    <radialGradient id="orb" cx="30%" cy="25%"><stop stop-color="#fff"/><stop offset=".23" stop-color="#bceeff"/><stop offset=".58" stop-color="#5c8cff"/><stop offset="1" stop-color="#b95cff"/></radialGradient>
    <filter id="glow" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="#8ea4d7" stroke-opacity=".04"/></pattern>
    <style>
      text{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}.label{fill:#72dfff;font-size:10px;font-weight:700;letter-spacing:2px}.title{fill:#f5f7ff;font-size:24px;font-weight:800;letter-spacing:-.5px}.meta{fill:#7f8cae;font-size:10px;letter-spacing:.5px}.score{fill:#dce6ff;font-size:12px;font-weight:700}.brick{shape-rendering:geometricPrecision}
      @media(prefers-reduced-motion:reduce){animate,animateTransform{display:none}}
    </style>
  </defs>
  <rect x="1" y="1" width="958" height="428" rx="20" fill="url(#bg)" stroke="url(#edge)" stroke-opacity=".7"/>
  <rect x="14" y="14" width="932" height="402" rx="14" fill="url(#grid)" stroke="#7082b7" stroke-opacity=".12"/>
  <text class="label" x="42" y="43">BBB ARCADE / LIVE CONTRIBUTIONS</text>
  <text class="title" x="42" y="77">CONTRIBUTION BREAKOUT</text>
  <text class="meta" x="42" y="98">Every active day is a brick. Every hit verifies a public signal.</text>
  <text class="score" x="918" y="55" text-anchor="end">${formatNumber(calendar.totalContributions)} PTS</text>
  <text class="meta" x="918" y="77" text-anchor="end">${activeBricks.length} ACTIVE DAYS</text>
  <g class="brick">${brickSvg}</g>
  ${impactSvg}
  <g filter="url(#glow)">
    <rect x="${firstFrame.paddleX.toFixed(1)}" y="${PADDLE_Y}" width="${PADDLE_WIDTH}" height="9" rx="4.5" fill="url(#edge)">
      <animate attributeName="x" values="${paddleX}" dur="${sampledDuration.toFixed(2)}s" repeatCount="indefinite"/>
    </rect>
    <circle cx="${firstFrame.x.toFixed(1)}" cy="${firstFrame.y.toFixed(1)}" r="${ORB_RADIUS}" fill="url(#orb)" stroke="#eafdff" stroke-width=".8">
      <animate attributeName="cx" values="${ballX}" dur="${sampledDuration.toFixed(2)}s" repeatCount="indefinite"/>
      <animate attributeName="cy" values="${ballY}" dur="${sampledDuration.toFixed(2)}s" repeatCount="indefinite"/>
    </circle>
  </g>
  <line x1="34" y1="383" x2="926" y2="383" stroke="url(#edge)" stroke-opacity=".18"/>
  <text class="meta" x="42" y="405">BREAK · VERIFY · REBUILD · REPEAT</text>
  <text class="meta" x="918" y="405" text-anchor="end">@${escapeXml(login)}</text>
</svg>
`.replace(/[ \t]+$/gm, "");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const calendar = options.input
    ? JSON.parse(await readFile(resolve(options.input), "utf8"))
    : await fetchCalendar(options.login, process.env.GITHUB_TOKEN);
  const outputPath = resolve(options.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderContributionSvg(calendar, options.login), "utf8");
  console.log(`Generated ${outputPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
