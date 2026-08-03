import assert from "node:assert/strict";
import test from "node:test";

import { renderContributionSvg } from "./generate-contribution-orbit.mjs";

function fixtureCalendar() {
  const weeks = [];
  let totalContributions = 0;

  for (let week = 0; week < 53; week += 1) {
    const contributionDays = [];
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const contributionCount = (week * 3 + weekday * 5) % 17;
      totalContributions += contributionCount;
      contributionDays.push({
        contributionCount,
        date: new Date(Date.UTC(2025, 7, 3 + week * 7 + weekday)).toISOString().slice(0, 10),
        weekday,
      });
    }
    weeks.push({ contributionDays });
  }

  return { totalContributions, weeks };
}

test("renders an accessible animated SVG from a contribution calendar", () => {
  const svg = renderContributionSvg(fixtureCalendar(), "bbb-build");

  assert.match(svg, /^<\?xml version="1\.0"/);
  assert.match(svg, /<title id="title">Proof of Contribution for bbb-build<\/title>/);
  assert.match(svg, /PROOF OF CONTRIBUTION/);
  assert.match(svg, /B VERIFIED/);
  assert.match(svg, /<animateMotion[^>]+repeatCount="indefinite"/);
  assert.equal((svg.match(/class="day level-/g) || []).length, 53 * 7);
  assert.equal((svg.match(/class="verification"/g) || []).length, 7);
  assert.doesNotMatch(svg, /World ID Orb 認証ロケーション/);
});

test("escapes a login before placing it in SVG text", () => {
  const svg = renderContributionSvg(fixtureCalendar(), 'build<&"');
  assert.match(svg, /build&lt;&amp;&quot;/);
  assert.doesNotMatch(svg, /build<&"/);
});
