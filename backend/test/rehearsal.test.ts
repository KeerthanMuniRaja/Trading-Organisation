import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, owner, evaluator, market, key } from './helpers.js';
import { TradeSignals } from '../src/trade-signals.js';
import { Autonomy } from '../src/autonomy.js';
import { Management } from '../src/management.js';
import { BotFitness } from '../src/bot-fitness.js';
import { Actor } from '../src/core.js';

// AUTO-04 autonomy rehearsal: the organisation runs many rounds by itself under standing approvals, through injected
// failures, and every round ends with the invariants an autonomous organisation must never break:
//   money     journals balance; Wallet 1 never negative; Wallet 2 touched only by owner or profit transfers
//   limits    organisation exposure within the limit; each bot's cost within its current budget
//   trading   each proposal executes at most once, every execution has exactly one filled order
//   brakes    no buy fills for a bot after it was suspended, and none for anyone after the kill switch
//   autonomy  the agents act only within the policy: only the allowed kinds, each raise within the per-change limit,
//             the month's automatic raises within the monthly total, and nothing the policy does not cover
//   audit     the hash chain verifies
// Failures injected: duplicate proposals and executions, a stale quote before a fill, another bot's credential, a
// losing bot that the standing approvals must suspend, budget raises over the policy, and a crash (critical incident).
const ROUNDS = 8, SYMBOLS = ['AAA', 'BBB', 'CCC', 'DDD'], BOTS = ['steady', 'loser', 'eager', 'quiet'];
const BUDGET = 1_000_000n, RAISE_CAP = 300_000n;
const says = (pattern: RegExp) => (error: any) => pattern.test(JSON.stringify(error?.getResponse?.() ?? error?.message));
const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

function rng(seed: number) { // mulberry32: the same rehearsal every run
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

test('the starter policy for standing approvals is valid and protective only: no money moves by itself', async () => {
  const { readFile } = await import('node:fs/promises');
  const rules = JSON.parse(await readFile('docs/policies/autonomy-starter.json', 'utf8'));
  const f = await fixture(); try {
    const autonomy = new Autonomy(f.db, f.cfg);
    await autonomy.setPolicy(owner, key(), { rules, reason: 'Starter policy: protect, repair, roll back; money stays with the owner' });
    const p = (await autonomy.view(owner)).policy as { rules: Record<string, unknown> };
    assert.deepEqual([p.rules.raiseBudget, p.rules.startingBudgetPaise, p.rules.approveBirths, p.rules.qualifyBots, p.rules.activateReleases],
      [null, null, false, false, false]);
    assert.deepEqual([p.rules.suspendOnRecommendation, p.rules.rollbackFailingReleases, p.rules.trialNewReleases], [true, true, true]);
  } finally { await f.db.close(); }
});

test('the organisation runs by itself through failures and never breaks an invariant', async t => {
  const f = await fixture(); try {
    const random = rng(20261021);
    const e = await f.evidence();
    await f.deposit('10000000');
    for (const id of BOTS) await f.org.bot(owner, key(), { id, name: id, department: 'desk', specialty: 'rehearsal-' + id, method: 'test',
      contribution: 'Rehearsal member ' + id, budgetPaise: BUDGET.toString() });
    await f.db.transaction(tx => tx.query("UPDATE bots SET state='paper' WHERE id = ANY($1::text[])", [BOTS]));
    const traders: Record<string, Actor> = Object.fromEntries(BOTS.map(id => [id, { id: 'trader-' + id, role: 'trader', botId: id }]));
    const signals = new TradeSignals(f.db, f.cfg), autonomy = new Autonomy(f.db, f.cfg), management = new Management(f.db, f.cfg), fitness = new BotFitness(f.db);
    await autonomy.setPolicy(owner, key(), { reason: 'Rehearsal: suspend flagged bots, small raises', rules: { suspendOnRecommendation: true,
      acknowledgeWatch: false, raiseBudget: { maxPctPerChange: 25, maxTotalPaisePerMonth: RAISE_CAP.toString() }, approveBirths: false,
      activateReleases: false, qualifyBots: false, startingBudgetPaise: null, maxActionsPerRun: 10 } });

    const price: Record<string, number> = Object.fromEntries(SYMBOLS.map(s => [s, 10_000]));
    let clock = Date.now();
    const quote = async (symbol: string) => {
      clock = Math.max(clock + 1, Date.now());
      await f.paper.quote(market, key(), { symbol, bidPaise: String(price[symbol]), askPaise: String(price[symbol]), observedAt: new Date(clock).toISOString(), sourceId: e.sourceId });
    };
    const expires = () => new Date(Date.now() + 86_400_000).toISOString();
    const call = (botId: string, symbol: string, action: string, thesis: string) => ({ botId, symbol, action, horizonDays: 5, conviction: random() < 0.5 ? 'medium' : 'low',
      thesis, invalidation: 'Stop on a close below the entry', expiresAt: expires(), evidenceIds: [e.evidenceId], targetWeightPct: 10 });
    const marks: { suspendedAt?: number; haltedAt?: number } = {};
    const injected: string[] = [];

    const invariants = async (round: number) => {
      const r = await f.db.transaction(async tx => ({
        unbalanced: Number((await tx.query('SELECT COUNT(*)::int AS n FROM (SELECT journal_id FROM entries GROUP BY journal_id HAVING SUM(amount)<>0) x')).rows[0]!.n),
        w1: BigInt((await tx.query("SELECT COALESCE(SUM(amount),0)::text AS v FROM entries WHERE account='W1'")).rows[0]!.v),
        w2Kinds: (await tx.query("SELECT DISTINCT j.kind FROM entries e JOIN journals j ON j.id=e.journal_id WHERE e.account='W2'")).rows.map(x => String(x.kind)),
        exposure: BigInt((await tx.query("SELECT COALESCE(SUM(amount),0)::text AS v FROM entries WHERE account='POSITION'")).rows[0]!.v),
        perBot: (await tx.query('SELECT p.bot_id, SUM(p.cost_paise)::text AS cost, b.budget_paise::text AS budget FROM positions p JOIN bots b ON b.id=p.bot_id GROUP BY p.bot_id, b.budget_paise')).rows,
        executions: Number((await tx.query('SELECT COUNT(*)::int AS n FROM trade_signal_executions')).rows[0]!.n),
        filledLinked: Number((await tx.query("SELECT COUNT(*)::int AS n FROM orders WHERE status='filled' AND signal_id IS NOT NULL")).rows[0]!.n),
        buys: (await tx.query("SELECT o.bot_id, f.created_at FROM fills f JOIN orders o ON o.id=f.order_id WHERE o.side='buy'")).rows,
        actions: (await tx.query('SELECT kind, target, amount_paise::text AS amount FROM autonomy_actions')).rows,
        raises: (await tx.query("SELECT budget_before::text AS before, budget_after::text AS after FROM bot_budget_changes WHERE decided_by='autonomy-policy'")).rows,
      }), false);
      const where = `round ${round}`;
      assert.equal(r.unbalanced, 0, where);
      assert.ok(r.w1 >= 0n, where);
      assert.ok(r.w2Kinds.every(k => ['owner-transfer', 'profit-transfer'].includes(k)), `${where}: Wallet 2 touched by ${r.w2Kinds}`);
      assert.ok(r.exposure <= f.cfg.maxExposure, where);
      for (const b of r.perBot) assert.ok(BigInt(b.cost) <= BigInt(b.budget), `${where}: ${b.bot_id} cost ${b.cost} over budget ${b.budget}`);
      assert.equal(r.executions, r.filledLinked, `${where}: executions and filled orders differ`);
      for (const b of r.buys) {
        const at = new Date(b.created_at as string).getTime();
        if (marks.suspendedAt) assert.ok(!(b.bot_id === 'loser' && at > marks.suspendedAt), `${where}: a suspended bot bought`);
        if (marks.haltedAt) assert.ok(at <= marks.haltedAt, `${where}: a buy filled after the kill switch`);
      }
      assert.ok(r.actions.every(a => ['suspend', 'raise-budget'].includes(String(a.kind))), `${where}: an action the policy does not cover`);
      for (const x of r.raises) assert.ok(BigInt(x.after) * 100n <= BigInt(x.before) * 125n, `${where}: a raise over 25%`);
      assert.ok(r.raises.reduce((s, x) => s + BigInt(x.after) - BigInt(x.before), 0n) <= RAISE_CAP, `${where}: raises over the monthly total`);
      assert.equal((await f.ops.verifyAudit(owner)).valid, true, where);
    };

    for (let round = 1; round <= ROUNDS; round++) {
      // the market moves, every share gets a fresh approved quote
      for (const s of SYMBOLS) { price[s] = Math.max(1000, Math.round(price[s]! * (1 + (random() - 0.5) * 0.06))); await quote(s); }
      const held = (await f.paper.positions(owner)) as { bot_id: string; symbol: string; quantity: string }[];
      const proposed: { botId: string; id: string; action: string }[] = [];
      for (const botId of BOTS) {
        if (botId === 'quiet' && round % 2) continue; // a member that proposes only every other round
        const mine = held.filter(p => p.bot_id === botId && Number(p.quantity) > 0);
        const action = mine.length && random() < 0.35 ? 'exit' : 'enter-long';
        const symbol = action === 'exit' ? mine[0]!.symbol : SYMBOLS[Math.floor(random() * SYMBOLS.length)]!;
        const k = key(), body = call(botId, symbol, action, `Round ${round} ${action} ${symbol}`);
        if (marks.suspendedAt && botId === 'loser' && action === 'enter-long') {
          await assert.rejects(() => signals.propose(traders[botId]!, k, body), says(/suspended/)); // a suspended bot takes no new risk
          continue;
        }
        const first = await signals.propose(traders[botId]!, k, body);
        if (random() < 0.3) { // a retried request with the same key is the same proposal
          assert.equal((await signals.propose(traders[botId]!, k, body)).id, first.id);
          injected.push('duplicate-proposal');
        }
        proposed.push({ botId, id: first.id, action });
      }
      for (const p of proposed) await signals.review(evaluator, key(), { signalId: p.id });

      if (round === 2) { // the losing bot is flagged by the management review and suspended by the standing approvals
        await fitness.report(evaluator, key(), { botId: 'loser', role: 'trader', baseline: 'cash', testName: 'live-paper all releases',
          periodFrom: '2026-01-01', periodTo: today, judged: 30, wins: 4, losses: 26 });
        await management.review(evaluator, key());
        const run = await autonomy.apply(evaluator, key());
        assert.ok(run.actions.some(a => a.kind === 'suspend' && a.target === 'loser'), JSON.stringify(run));
        marks.suspendedAt = Date.now();
        injected.push('suspension-by-policy');
      }
      if (round === 3) { // raises: one within the policy, one too large, one over what is left of the month
        const recommend = (botId: string, to: bigint) => f.db.transaction(tx => tx.query(`INSERT INTO bot_recommendations(id,bot_id,kind,rule,reason,proposed_budget_paise,facts,proposer,content_hash)
          VALUES($1,$2,'raise-budget','test','Rehearsal raise',$3,'{}'::jsonb,'evaluator',$4)`, [randomUUID(), botId, to.toString(), randomUUID()]));
        await recommend('steady', BUDGET * 120n / 100n);
        await recommend('eager', BUDGET * 150n / 100n);
        const run = await autonomy.apply(evaluator, key());
        assert.deepEqual(run.actions.map(a => [a.kind, a.target]), [['raise-budget', 'steady']]);
        assert.ok(run.leftForOwner!.some(x => /per change/.test(String(x.reason))));
        await recommend('quiet', BUDGET * 125n / 100n); // +25% allowed per change, but only 100,000 of the month's 300,000 remain
        assert.ok((await autonomy.apply(evaluator, key())).leftForOwner!.some(x => /monthly total/.test(String(x.reason))));
        injected.push('raises-over-policy');
      }
      if (round === 5) { // a crash: the kill switch halts new risk, and the owner cannot resume while it is open
        await f.ops.incident(evaluator, key(), { description: 'Rehearsal: crash brake', severity: 'critical' });
        marks.haltedAt = Date.now();
        await assert.rejects(() => f.ops.control(owner, key(), { halted: false, reason: 'Too early' }), says(/Resolve critical incidents/));
        injected.push('kill-switch');
      }

      // execution: every accepted proposal, attempted twice at once; sometimes on a stale quote first; never by another bot
      const reviews = await signals.query(owner, {});
      for (const p of proposed) {
        const s = reviews.signals.find(x => x.id === p.id)!;
        if (s.review?.outcome !== 'accepted') continue;
        const other = traders[BOTS.find(b => b !== p.botId)!]!;
        await assert.rejects(() => signals.execute(other, key(), { signalId: p.id }), says(/proposing bot/));
        if (random() < 0.25) {
          await f.db.transaction(tx => tx.query("UPDATE quotes SET observed_at=now()-interval '5 minutes' WHERE symbol=$1", [s.symbol]));
          await assert.rejects(() => signals.execute(traders[p.botId]!, key(), { signalId: p.id }), says(/Fresh approved quote/));
          await quote(s.symbol);
          injected.push('stale-quote');
        }
        const both = await Promise.allSettled([signals.execute(traders[p.botId]!, key(), { signalId: p.id }), signals.execute(traders[p.botId]!, key(), { signalId: p.id })]);
        const buyBlocked = s.review?.side === 'buy' && ((marks.suspendedAt && p.botId === 'loser') || marks.haltedAt);
        if (buyBlocked) assert.ok(both.every(x => x.status === 'rejected'), `round ${round}: a blocked buy executed`);
        else assert.ok(both.some(x => x.status === 'fulfilled'), `round ${round}: ${JSON.stringify(both.filter(x => x.status === 'rejected').map(x => String((x as PromiseRejectedResult).reason?.message)))}`);
      }
      await invariants(round);
    }

    // after the kill switch, reviews refuse new buys but exits still close risk
    const reviews = await signals.query(owner, {});
    const lateBuys = reviews.signals.filter(s => s.action === 'enter-long' && s.review && new Date(s.createdAt).getTime() > marks.haltedAt!);
    assert.ok(lateBuys.every(s => s.review!.outcome !== 'accepted'), 'a buy was accepted while halted');
    const kinds = new Set(injected);
    for (const k of ['duplicate-proposal', 'suspension-by-policy', 'raises-over-policy', 'kill-switch', 'stale-quote']) assert.ok(kinds.has(k), `failure ${k} was not exercised`);
    t.diagnostic(`${ROUNDS} rounds, ${reviews.signals.length} proposals, failures injected: ${[...kinds].join(', ')}`);
  } finally { await f.db.close(); }
});
