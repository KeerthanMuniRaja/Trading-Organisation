import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPage, privacyProblems } from './results-page.mjs';

const DATA = {
  live: { money: { totalPaise: '-12635', realisedPaise: '4424', unrealisedPaise: '-17059', byBot: [{ botId: 'momentum-rules', totalPaise: '-17474', returnOnBudgetPct: -3.49 }] },
    benchmark: [{ botId: 'momentum-rules', from: '2026-10-16', to: '2026-10-28', returnPct: -3.49, basketReturnPct: -3.27, excessPct: -0.22 }], liveFitness: [] },
  scout: { from: '2017-12', through: '2026-09', ideasTried: 25, bonferroniThreshold: 0.002, basketStats: { cagrPct: 13.69, maxDrawdownPct: -34.51, afterTaxCagrPct: 12.55 },
    candidates: [{ name: 'momentum-6m-top3-quarterly', ahead: 60, behind: 46, averageExcessPct: 0.056, pValue: 0.103, beatsRandomPct: 81, stats: { cagrPct: 13.76, maxDrawdownPct: -40.58 }, proof: { afterTaxCagrPct: 10.86 } },
      { name: '<script>x</script>', ahead: 1, behind: 2, averageExcessPct: -0.1, pValue: 1, stats: {}, proof: {} }],
    walkForward: { ahead: 29, behind: 41, averageExcessPct: -0.421 } },
  lab: { sharesWithData: 475, from: '2016-12', through: '2026-09', factorsTried: 8, bonferroniThreshold: 0.006,
    factors: [{ description: '6-month return', months: 112, ic: { mean: 0.0329, tStat: 2.35, pValue: 0.0093, positiveMonthsPct: 64.3 } },
      { description: '12-month return, skipping the latest month', months: 106, ic: { mean: 0.0412, tStat: 2.69, pValue: 0.004, positiveMonthsPct: 66 } }] },
  regime: { risk: 'SEVERE', date: '2026-10-28', distributionDays: 11, breadth200d: 1 },
  regimeStudy: { levels: { SEVERE: { fallOver5PctShare: 0.214 }, NORMAL: { fallOver5PctShare: 0.138 } } },
  mentor: { lessons: [{ title: 'Turn of the month', status: 'checked', evidence: 'The last session and the first three carried half the gain.' }, { title: 'x', status: 'unverified' }] },
  world: { items: 361, windowHours: 48, reachingShares: 120, worldEchoes: 3, top: [{ title: 'A PUBLISHER HEADLINE MUST NOT APPEAR' }] },
  rndForward: { running: 1 }, tuning: { generatedTokensPerSecond: 6.3, secondsPerCall: 45.6 }, exams: null };

test('the page shows results and analysis, escapes untrusted text and never carries a headline', () => {
  const page = buildPage(DATA, new Date('2026-10-29T08:00:00Z'));
  assert.match(page, /momentum-rules<\/td><td class="n">−₹174\.74/);
  assert.match(page, /−3\.49% vs −3\.27%/);
  assert.match(page, /None passes/);
  assert.match(page, /13\.69%/);
  assert.match(page, /<strong>SEVERE<\/strong> on 2026-10-28/);
  assert.match(page, /<strong>One signal passes:<\/strong> 12-month return, skipping the latest month\./);  // 0.004 < 0.006; 0.0093 is not
  assert.match(page, /followed 21% of SEVERE days and 14% of NORMAL ones/);
  assert.match(page, /1 of 2\s+hold/);
  assert.match(page, /3 world event\(s\) followed by Indian coverage/);
  assert.ok(!page.includes('<script>x</script>') && page.includes('&lt;script&gt;x&lt;/script&gt;'));  // untrusted names stay text
  assert.ok(!page.includes('A PUBLISHER HEADLINE MUST NOT APPEAR'));   // publishers' headlines never go public
  assert.deepEqual(privacyProblems(page), []);
  assert.match(buildPage({ ...DATA, live: null }), /were not available when this page was built/);
});

test('anything private stops the publication', () => {
  for (const [text, what] of [['C:\\Keerthan\\x', 'a local Windows path'], ['Authorization: Bearer abc', 'a credential or setting'],
    ['owner@example.com', 'an e-mail address'], ['Trading-Organisation docs', "the project's name"], ['/home/me/x', 'a local path']])
    assert.deepEqual(privacyProblems(`<p>${text}</p>`), [what], text);
});
