import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, config, owner, evaluator, trader, market, key } from './helpers.js';
import { BotScorecards } from '../src/bot-scorecards.js';
import { TradeSignals } from '../src/trade-signals.js';
import { BotFitness } from '../src/bot-fitness.js';
import { Database } from '../src/database.js';
import { createApp } from '../src/app.js';

test('a scorecard assembles fitness, calls, calibration, challenges, realised money, compute and overlap', async () => {
  const f = await fixture(); try {
    const e = await f.evidence();
    await f.deposit('500000');
    for (const id of ['bot-one', 'echo', 'skeptic'])
      await f.org.bot(owner, key(), { id, name: id, department: 'desk', specialty: id, method: 'reasoning', contribution: 'Scorecard fixture', budgetPaise: '1000000' });
    await f.db.transaction(tx => tx.query("UPDATE bots SET state='paper' WHERE id='bot-one'"));
    await f.paper.quote(market, key(), { symbol: 'DEMO', bidPaise: '10000', askPaise: '10000', observedAt: new Date().toISOString(), sourceId: e.sourceId });

    // real money path: buy then exit through executions (fixture fees are zero)
    const signals = new TradeSignals(f.db, f.cfg);
    const base = { botId: 'bot-one', symbol: 'DEMO', horizonDays: 10, conviction: 'medium', thesis: 'Uptrend', invalidation: 'Breaks support',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(), evidenceIds: [e.evidenceId] };
    const buy = await signals.propose(trader, key(), { ...base, action: 'enter-long' });
    await signals.review(evaluator, key(), { signalId: buy.id });
    await signals.execute(trader, key(), { signalId: buy.id });
    await f.paper.quote(market, key(), { symbol: 'DEMO', bidPaise: '11000', askPaise: '11000', observedAt: new Date(Date.now() + 1000).toISOString(), sourceId: e.sourceId });
    const exit = await signals.propose(trader, key(), { ...base, action: 'exit', thesis: 'Target reached' });
    await signals.review(evaluator, key(), { signalId: exit.id });
    await signals.execute(trader, key(), { signalId: exit.id });

    // history: 10 scored calls by bot-one (3 right, poorly calibrated) and 'echo' mirroring each of them
    await f.db.transaction(async tx => {
      for (let i = 0; i < 10; i++) {
        for (const bot of ['bot-one', 'echo']) {
          const id = crypto.randomUUID();
          await tx.query(`INSERT INTO trade_signals(id,bot_id,symbol,action,horizon_days,conviction,probability_pct,thesis,invalidation,expires_at,author,content_hash,created_at)
            VALUES($1,$2,$3,'enter-long',5,'high',90,'Call','Stop',now()+interval '1 day','w',$4,now()-($5::int * interval '1 day'))`, [id, bot, 'SYM' + i, key(), 10 + i]);
          await tx.query(`INSERT INTO trade_signal_reviews(id,signal_id,outcome,reasons,reference_price_paise,rules_version,reviewer)
            VALUES($1,$2,'rejected',ARRAY['t']::text[],100,'signal-risk-v2','evaluator')`, [crypto.randomUUID(), id]);
          await tx.query(`INSERT INTO trade_signal_outcomes(id,signal_id,exit_price_paise,observed_at,move_bps,correct,brier,evidence_id,evaluator)
            VALUES($1,$2,100,now(),0,$3,$4,$5,'evaluator')`, [crypto.randomUUID(), id, i < 3, i < 3 ? 0.01 : 0.81, e.evidenceId]);
          if (bot === 'bot-one' && i < 4)
            await tx.query(`INSERT INTO trade_signal_challenges(id,signal_id,challenger_bot_id,stance,argument,author) VALUES($1,$2,'skeptic','oppose','Too early','s')`,
              [crypto.randomUUID(), id]);
        }
      }
    });
    await new BotFitness(f.db).report(evaluator, key(), { botId: 'echo', role: 'trend-analyst', baseline: 'always-neutral', testName: 't',
      periodFrom: '2026-01-01', periodTo: '2026-02-01', judged: 40, wins: 4, losses: 30 });

    const { cards } = await new BotScorecards(f.db).cards(owner, {});
    const one = cards.find(c => c.botId === 'bot-one')!;
    assert.equal(one.money.realisedNetPaise, '25000'); // 25 shares x 1000 paise from the linked executions
    assert.deepEqual([one.proposals.scored, one.proposals.accuracy], [10, 0.3]);
    assert.ok(one.flags.includes('fewer than 40% of scored calls right'));
    assert.ok(one.flags.includes('stated probabilities worse than always saying 50%'));
    assert.deepEqual(one.overlaps.map(o => o.botId), ['echo']);
    const echo = cards.find(c => c.botId === 'echo')!;
    assert.ok(echo.flags.some(fl => fl.startsWith('mostly mirrors bot-one')));
    assert.ok(echo.flags.includes('worse than its baseline in a fitness report'));
    const skeptic = cards.find(c => c.botId === 'skeptic')!;
    assert.deepEqual(skeptic.challenges, { scored: 4, accuracy: 0.25 }); // opposed 3 right calls and 1 wrong one
    // a trader sees only its own card
    assert.deepEqual((await new BotScorecards(f.db).cards(trader, {})).cards.map(c => c.botId), ['bot-one']);
    await assert.rejects(async () => new BotScorecards(f.db).cards(trader, { botId: 'echo' }));
  } finally { await f.db.close(); }
});

test('the scorecard route is guarded by role', async () => {
  const { cfg } = config(), db = await Database.open(), app = await createApp(cfg, db, true);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const post = (role: string) => fetch(base + '/v1/bots/scorecards', { method: 'POST', body: '{}',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.principals.find(p => p.role === role)!.token } });
    assert.equal((await post('evaluator')).status, 201);
    assert.equal((await post('researcher')).status, 403);
  } finally { await app.close(); await db.close(); }
});
