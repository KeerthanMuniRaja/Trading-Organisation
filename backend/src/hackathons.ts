import { Body, Controller, Headers, Post, Req } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Actor, digest, id, parse, permit, requireThat, timestamp, uuid } from './core.js';
import { Database, Sql, audit } from './database.js';
import { Allow } from './security.js';

// R&D hackathons (RD-01). The owner poses a question with a metric, a baseline to beat, an entry deadline and an
// evaluation window that stays concealed from bots until entries close; its commitment hash is published at creation,
// so the window provably cannot be changed afterwards. Bots enter versioned specifications under their own identity.
// Independent judges (never an entry's author) record each entry's score against the baseline with verified evidence.
// Findings, including negative results, are recorded so a contest teaches even when nothing wins. Outcomes are
// recommendations: no code, qualification, budget or role changes automatically.

const text = (max: number) => z.string().trim().min(1).max(max);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(v + 'T00:00:00Z')), 'Invalid date');
const createSchema = z.object({ id, title: text(160), question: text(1000), metric: text(120), higherIsBetter: z.boolean(),
  baseline: text(120), entryDeadline: timestamp, maxEntriesPerBot: z.number().int().min(1).max(10).default(3),
  windowFrom: day, windowTo: day }).strict()
  .refine(v => v.windowFrom <= v.windowTo, 'The evaluation window must start before it ends');
const entrySchema = z.object({ hackathonId: id, botId: id, title: text(160),
  spec: z.record(z.string(), z.unknown()).refine(v => JSON.stringify(v).length <= 8000, 'Specification too large') }).strict();
const stageSchema = z.object({ hackathonId: id }).strict();
const resultSchema = z.object({ entryId: z.uuid(), score: z.number().finite(), baselineScore: z.number().finite(), evidenceId: z.uuid(), note: text(600) }).strict();
const findingSchema = z.object({ hackathonId: id, kind: z.enum(['positive', 'negative', 'next-step']), finding: text(1000), evidenceId: z.uuid().optional() }).strict();
const viewSchema = z.object({ hackathonId: id }).strict();

async function verifiedEvidence(tx: Sql, evidenceId: string) {
  return (await tx.query(`SELECT 1 FROM evidence e JOIN sources s ON s.id=e.source_id WHERE e.id=$1 AND e.status='verified' AND s.approved=true`,
    [evidenceId])).rows.length === 1;
}

export class Hackathons {
  constructor(private readonly db: Database) {}

  create(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'owner');
    const input = parse(createSchema, raw);
    requireThat(Date.parse(input.entryDeadline) > Date.now(), 'The entry deadline must be in the future', 400);
    return this.db.command(actor, 'hackathon-create', key, input, async tx => {
      requireThat(!(await tx.query('SELECT 1 FROM hackathons WHERE id=$1', [input.id])).rows.length, 'Hackathon id already used');
      const salt = randomBytes(16).toString('hex');
      const commit = digest({ windowFrom: input.windowFrom, windowTo: input.windowTo, salt });
      await tx.query(`INSERT INTO hackathons(id,title,question,metric,higher_is_better,baseline,entry_deadline,max_entries_per_bot,window_from,window_to,
        window_commit,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'open',$12)`,
        [input.id, input.title, input.question, input.metric, input.higherIsBetter, input.baseline, input.entryDeadline, input.maxEntriesPerBot,
          input.windowFrom, input.windowTo, commit + ':' + salt, actor.id]);
      await audit(tx, actor, 'hackathon.created', input.id, { title: input.title, entryDeadline: input.entryDeadline, windowCommit: commit });
      return { id: input.id, status: 'open', windowCommit: commit }; // the salt stays private until the window is revealed
    });
  }

  enter(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'trader', 'researcher');
    const input = parse(entrySchema, raw);
    requireThat(actor.botId === input.botId, 'A bot can only enter under its own identity', 403);
    return this.db.command(actor, 'hackathon-entry', key, input, async tx => {
      const h = (await tx.query('SELECT status,entry_deadline,max_entries_per_bot FROM hackathons WHERE id=$1', [input.hackathonId])).rows[0];
      requireThat(h, 'Hackathon not found', 404);
      requireThat(h.status === 'open' && new Date(h.entry_deadline).getTime() > Date.now(), 'Entries are closed');
      const bot = (await tx.query('SELECT state FROM bots WHERE id=$1', [input.botId])).rows[0];
      requireThat(bot && bot.state !== 'retired', 'Bot cannot enter', 403);
      const hash = digest(input.spec);
      const same = (await tx.query('SELECT id,bot_id,version FROM hackathon_entries WHERE hackathon_id=$1 AND spec_hash=$2', [input.hackathonId, hash])).rows[0];
      if (same) {
        requireThat(same.bot_id === input.botId, 'An identical specification was already entered by another bot');
        return { id: String(same.id), version: same.version, duplicate: true };
      }
      const count = (await tx.query('SELECT COUNT(*)::int AS n FROM hackathon_entries WHERE hackathon_id=$1 AND bot_id=$2', [input.hackathonId, input.botId])).rows[0]!.n;
      requireThat(count < h.max_entries_per_bot, 'Entry limit reached for this bot');
      const entryId = uuid();
      await tx.query(`INSERT INTO hackathon_entries(id,hackathon_id,bot_id,version,title,spec,spec_hash,author) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
        [entryId, input.hackathonId, input.botId, count + 1, input.title, JSON.stringify(input.spec), hash, actor.id]);
      await audit(tx, actor, 'hackathon.entered', entryId, { hackathonId: input.hackathonId, botId: input.botId, version: count + 1, specHash: hash });
      return { id: entryId, version: count + 1, duplicate: false };
    });
  }

  /** Owner closes entries (after the deadline): the window and its salt are revealed for judging. */
  closeEntries(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'owner');
    const input = parse(stageSchema, raw);
    return this.db.command(actor, 'hackathon-close-entries', key, input, async tx => {
      const h = (await tx.query(SELECT_HACKATHON, [input.hackathonId])).rows[0];
      requireThat(h, 'Hackathon not found', 404);
      requireThat(h.status === 'open', 'Entries are already closed');
      requireThat(new Date(h.entry_deadline).getTime() <= Date.now(), 'The entry deadline has not passed');
      await tx.query("UPDATE hackathons SET status='judging' WHERE id=$1", [h.id]);
      const reveal = revealOf(h);
      await audit(tx, actor, 'hackathon.judging', h.id, reveal);
      return { id: h.id, status: 'judging', ...reveal };
    });
  }

  judge(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'evaluator', 'owner');
    const input = parse(resultSchema, raw);
    return this.db.command(actor, 'hackathon-result', key, input, async tx => {
      const e = (await tx.query(`SELECT e.*,h.status,h.higher_is_better FROM hackathon_entries e JOIN hackathons h ON h.id=e.hackathon_id WHERE e.id=$1`,
        [input.entryId])).rows[0];
      requireThat(e, 'Entry not found', 404);
      requireThat(e.status === 'judging', 'Results are recorded only while judging');
      requireThat(e.author !== actor.id, 'A judge cannot score its own entry', 403);
      requireThat(await verifiedEvidence(tx, input.evidenceId), 'Results need verified evidence from an approved source');
      requireThat(!(await tx.query('SELECT 1 FROM hackathon_results WHERE entry_id=$1', [e.id])).rows.length, 'Entry already judged');
      const beat = e.higher_is_better ? input.score > input.baselineScore : input.score < input.baselineScore;
      await tx.query(`INSERT INTO hackathon_results(id,entry_id,score,baseline_score,beat_baseline,evidence_id,note,judge) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [uuid(), e.id, input.score, input.baselineScore, beat, input.evidenceId, input.note, actor.id]);
      await audit(tx, actor, 'hackathon.judged', e.id, { score: input.score, baselineScore: input.baselineScore, beatBaseline: beat });
      return { entryId: String(e.id), beatBaseline: beat };
    });
  }

  finding(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'owner', 'evaluator', 'researcher');
    const input = parse(findingSchema, raw);
    return this.db.command(actor, 'hackathon-finding', key, input, async tx => {
      const h = (await tx.query('SELECT status FROM hackathons WHERE id=$1', [input.hackathonId])).rows[0];
      requireThat(h, 'Hackathon not found', 404);
      requireThat(h.status !== 'open', 'Findings are recorded once entries are closed');
      if (input.evidenceId) requireThat(await verifiedEvidence(tx, input.evidenceId), 'Cited evidence must be verified');
      const findingId = uuid();
      await tx.query('INSERT INTO hackathon_findings(id,hackathon_id,kind,finding,evidence_id,author) VALUES($1,$2,$3,$4,$5,$6)',
        [findingId, input.hackathonId, input.kind, input.finding, input.evidenceId ?? null, actor.id]);
      await audit(tx, actor, 'hackathon.finding', findingId, { hackathonId: input.hackathonId, kind: input.kind });
      return { id: findingId };
    });
  }

  /** Owner closes the contest once every entry is judged and at least one finding is recorded. */
  finish(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'owner');
    const input = parse(stageSchema, raw);
    return this.db.command(actor, 'hackathon-finish', key, input, async tx => {
      const h = (await tx.query('SELECT status FROM hackathons WHERE id=$1', [input.hackathonId])).rows[0];
      requireThat(h?.status === 'judging', 'Only a contest being judged can be finished');
      const unjudged = (await tx.query(`SELECT COUNT(*)::int AS n FROM hackathon_entries e WHERE e.hackathon_id=$1
        AND NOT EXISTS (SELECT 1 FROM hackathon_results r WHERE r.entry_id=e.id)`, [input.hackathonId])).rows[0]!.n;
      requireThat(unjudged === 0, `${unjudged} entries are not judged yet`);
      requireThat((await tx.query('SELECT 1 FROM hackathon_findings WHERE hackathon_id=$1', [input.hackathonId])).rows.length,
        'Record at least one finding (a negative result counts) before closing');
      await tx.query("UPDATE hackathons SET status='closed' WHERE id=$1", [input.hackathonId]);
      await audit(tx, actor, 'hackathon.closed', input.hackathonId, {});
      return { id: input.hackathonId, status: 'closed' };
    });
  }

  view(actor: Actor, raw: unknown) {
    permit(actor, 'owner', 'evaluator', 'researcher', 'trader');
    const input = parse(viewSchema, raw);
    return this.db.transaction(async tx => {
      const h = (await tx.query(SELECT_HACKATHON, [input.hackathonId])).rows[0];
      requireThat(h, 'Hackathon not found', 404);
      const concealed = h.status === 'open' && actor.role !== 'owner';
      const entries = (await tx.query(`SELECT e.id,e.bot_id,e.version,e.title,e.spec_hash,e.created_at,r.score,r.baseline_score,r.beat_baseline,r.note
        FROM hackathon_entries e LEFT JOIN hackathon_results r ON r.entry_id=e.id WHERE e.hackathon_id=$1`, [h.id])).rows
        .filter(e => !concealed || actor.role !== 'trader' || e.bot_id === actor.botId); // during entry, traders see only their own entries
      const scored = entries.filter(e => e.score !== null);
      scored.sort((a, b) => (h.higher_is_better ? Number(b.score) - Number(a.score) : Number(a.score) - Number(b.score)));
      const findings = (await tx.query('SELECT kind,finding,evidence_id,author,created_at FROM hackathon_findings WHERE hackathon_id=$1 ORDER BY created_at', [h.id])).rows;
      const winner = scored.find(e => e.beat_baseline);
      return { id: h.id, title: h.title, question: h.question, metric: h.metric, higherIsBetter: h.higher_is_better, baseline: h.baseline,
        status: h.status, entryDeadline: new Date(h.entry_deadline).toISOString(), maxEntriesPerBot: h.max_entries_per_bot,
        windowCommit: String(h.window_commit).split(':')[0], window: concealed ? 'concealed until entries close' : revealOf(h),
        entries: entries.map(e => ({ id: String(e.id), botId: e.bot_id, version: e.version, title: e.title, specHash: e.spec_hash,
          score: e.score === null ? null : Number(e.score), baselineScore: e.baseline_score === null ? null : Number(e.baseline_score),
          beatBaseline: e.beat_baseline, note: e.note })),
        leaderboard: scored.map((e, rank) => ({ rank: rank + 1, entryId: String(e.id), botId: e.bot_id, score: Number(e.score), beatBaseline: e.beat_baseline })),
        outcome: h.status === 'open' ? 'entries open' : !scored.length ? 'not judged yet'
          : winner ? `best entry beating the baseline: ${winner.bot_id} v${winner.version}` : 'no entry beat the baseline (a negative result)',
        findings: findings.map(f => ({ kind: f.kind, finding: f.finding, evidenceId: f.evidence_id ? String(f.evidence_id) : null, author: f.author })),
        note: 'Results are recommendations only: nothing is promoted, funded or deployed automatically.' };
    }, false);
  }
}

const SELECT_HACKATHON = `SELECT *,to_char(window_from,'YYYY-MM-DD') AS wf,to_char(window_to,'YYYY-MM-DD') AS wt FROM hackathons WHERE id=$1`;

/** The window, its salt and a check that they reproduce the commitment published at creation. Dates come from to_char,
 *  so no time zone can shift them. */
function revealOf(h: Record<string, any>) {
  const [commit, salt] = String(h.window_commit).split(':');
  return { windowFrom: h.wf as string, windowTo: h.wt as string, salt, windowCommit: commit,
    commitVerified: digest({ windowFrom: h.wf, windowTo: h.wt, salt }) === commit };
}

type Request = { actor: Actor };
@Controller('v1')
export class HackathonsController {
  constructor(private readonly hackathons: Hackathons) {}
  @Post('hackathons') @Allow('owner') create(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.hackathons.create(r.actor, k ?? '', b); }
  @Post('hackathons/entries') @Allow('trader', 'researcher') enter(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.hackathons.enter(r.actor, k ?? '', b); }
  @Post('hackathons/judging') @Allow('owner') closeEntries(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.hackathons.closeEntries(r.actor, k ?? '', b); }
  @Post('hackathons/results') @Allow('owner', 'evaluator') judge(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.hackathons.judge(r.actor, k ?? '', b); }
  @Post('hackathons/findings') @Allow('owner', 'evaluator', 'researcher') finding(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.hackathons.finding(r.actor, k ?? '', b); }
  @Post('hackathons/closures') @Allow('owner') finish(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.hackathons.finish(r.actor, k ?? '', b); }
  @Post('hackathons/view') @Allow('owner', 'evaluator', 'researcher', 'trader') view(@Req() r: Request, @Body() b: unknown) { return this.hackathons.view(r.actor, b); }
}
