import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, owner, researcher, evaluator, key } from './helpers.js';
import { TradeSignals } from '../src/trade-signals.js';
import { BotFitness } from '../src/bot-fitness.js';
import { BotReleases } from '../src/bot-releases.js';

const says = (pattern: RegExp) => (error: any) => pattern.test(JSON.stringify(error?.getResponse?.() ?? error?.message));

test('a new member earns its first release on its own shadow calls: unqualified calls are priced, scored and judged', async () => {
  const f = await fixture(); try {
    const e = await f.evidence();
    await f.org.bot(owner, key(), { id: 'ta', name: 'TradingAgents', department: 'desk', specialty: 'multi-agent', method: 'tradingagents', contribution: 'Shadow fixture', budgetPaise: '0' });
    const signals = new TradeSignals(f.db, f.cfg), fitness = new BotFitness(f.db), releases = new BotReleases(f.db);
    const MODEL = 'tradingagents:0.9.0:qwen';
    // a shadow call made 40 days ago: the bot is in school with no budget, so the review rejected the trade but priced it
    const shadow = async (symbol: string, model: string) => {
      const id = crypto.randomUUID();
      await f.db.transaction(async tx => {
        await tx.query(`INSERT INTO trade_signals(id,bot_id,symbol,action,horizon_days,conviction,thesis,invalidation,expires_at,author,content_hash,created_at,model,prompt_version)
          VALUES($1,'ta',$2,'enter-long',30,'high','Shadow call','Fixture',now()-interval '35 days','trader',$3,now()-interval '40 days',$4,'cfg')`, [id, symbol, 'hash-' + id, model]);
        await tx.query(`INSERT INTO trade_signal_reviews(id,signal_id,outcome,reasons,reference_price_paise,rules_version,reviewer,created_at)
          VALUES($1,$2,'rejected',ARRAY['bot-not-qualified-for-paper-trading']::text[],10000,'signal-risk-v2','evaluator',now()-interval '39 days')`, [crypto.randomUUID(), id]);
      });
      return id;
    };
    const close = async (symbol: string, price: string) => {
      const at = new Date(Date.now() - 1000).toISOString(), day = new Date(Date.parse(at) + 330 * 60_000).toISOString().slice(0, 10);
      const id = (await f.org.evidence(researcher, key(), { sourceId: e.sourceId, kind: 'dataset', content: `Daily close of NSE:${symbol} on ${day}: ${price} paise.`, publishedAt: at })).id as string;
      await f.org.reviewEvidence(evaluator, key(), { evidenceId: id, status: 'verified' });
      return { evidenceId: id, exitPricePaise: price, observedAt: at };
    };
    const right = await shadow('AAA', MODEL), wrong = await shadow('BBB', MODEL), other = await shadow('CCC', 'some-other-engine');
    await signals.outcome(evaluator, key(), { signalId: right, ...await close('AAA', '11000') });
    await signals.outcome(evaluator, key(), { signalId: wrong, ...await close('BBB', '9000') });
    await signals.outcome(evaluator, key(), { signalId: other, ...await close('CCC', '12000') });
    const report = await fitness.live(evaluator, key(), { botId: 'ta', model: MODEL });
    const row = (await f.db.transaction(tx => tx.query('SELECT judged,wins,losses,model,test_name FROM bot_fitness_reports WHERE id=$1', [report.id]))).rows[0]!;
    assert.deepEqual([row.judged, row.wins, row.losses, row.model], [2, 1, 1, MODEL]); // only this model's shadow calls
    assert.match(row.test_name, /^live-paper model tradingagents:0\.9\.0:qwen \(shadow, before release\)/);
    // its first release can be evaluated on that record, because the report carries the release's model
    const release = await releases.create(researcher, key(), { botId: 'ta', model: MODEL, promptVersion: 'cfg', codeFingerprint: 'a'.repeat(16), notes: 'First release' });
    assert.equal((await releases.evaluate(evaluator, key(), { releaseId: release.id, fitnessReportId: report.id })).canaryEligible, true);
    assert.throws(() => fitness.live(evaluator, key(), { botId: 'ta', model: MODEL, releaseId: release.id }), says(/release or a model, not both/));
  } finally { await f.db.close(); }
});
