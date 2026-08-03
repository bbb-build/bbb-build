import assert from "node:assert/strict";
import test from "node:test";

import { renderContributionSvg } from "./generate-contribution-orbit.mjs";

function fixtureCalendar() {
  const weeks = [];
  let totalContributions = 0;
  for (let week = 0; week < 53; week += 1) {
    const contributionDays = [];
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const contributionCount = (week + weekday * 3) % 5 === 0 ? 0 : (week * 3 + weekday * 5) % 17;
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

test("renders a complete contribution breakout loop", () => {
  const calendar = fixtureCalendar();
  const activeDays = calendar.weeks.flatMap((week) => week.contributionDays).filter((day) => day.contributionCount > 0).length;
  const svg = renderContributionSvg(calendar, "bbb-build");
  assert.match(svg, /^<\?xml version="1\.0"/);
  assert.match(svg, /<title id="title">Contribution Breakout for bbb-build<\/title>/);
  assert.match(svg, /CONTRIBUTION BREAKOUT/);
  assert.match(svg, /BREAK · VERIFY · REBUILD · REPEAT/);
  assert.match(svg, /attributeName="x" values=/);
  assert.match(svg, /attributeName="cx" values=/);
  assert.match(svg, /attributeName="cy" values=/);
  assert.equal((svg.match(/aria-label="\d{4}-\d{2}-\d{2}: \d+ contributions"/g) || []).length, activeDays);
  assert.doesNotMatch(svg, /B VERIFIED|B-shaped orbit|150\+ locations/i);
});

test("is deterministic and escapes the login", () => {
  const calendar = fixtureCalendar();
  const first = renderContributionSvg(calendar, 'build<&"');
  const second = renderContributionSvg(calendar, 'build<&"');
  assert.equal(first, second);
  assert.match(first, /build&lt;&amp;&quot;/);
  assert.doesNotMatch(first, /build<&"/);
});
