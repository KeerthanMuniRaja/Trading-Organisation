import { Body, Controller, Get, Headers, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Actor, id, parse, permit, requireThat, uuid } from './core.js';
import { Database, Sql, audit } from './database.js';
import { Allow } from './security.js';

// Opportunity-driven bot births (LIFE-01). A research or evaluator bot proposes a new specialist for an ACTIVE
// department: what it would contribute, the opportunity it addresses, how success will be measured, and verified
// evidence. Novelty uses the same capability key as manual bot creation (department:specialty:method), so a proposal
// that duplicates an existing bot, a lifecycle blueprint or another pending proposal is refused; similar bots are listed
// for the owner. Only the owner decides. An approved birth creates the bot in 'school' with ZERO budget, mentored by the
// department lead unless the owner names another mentor; trading still requires the academy's qualification.

const text = (max: number) => z.string().trim().min(1).max(max);
const proposalSchema = z.object({ botId: id, name: text(120), department: id, specialty: id, method: id, contribution: text(600),
  opportunity: text(1000), successCriterion: text(600), evidenceIds: z.array(z.uuid()).min(1).max(10) }).strict();
const decisionSchema = z.object({ proposalId: z.uuid(), outcome: z.enum(['approved', 'rejected']), mentorId: id.optional(), note: text(600) }).strict();

const noveltyKey = (department: string, specialty: string, method: string) => [department, specialty, method].map(v => v.toLowerCase()).join(':');

async function duplicate(tx: Sql, botId: string, key: string, exceptProposal?: string) {
  if ((await tx.query('SELECT 1 FROM bots WHERE id=$1 OR novelty_key=$2', [botId, key])).rows.length) return 'an existing bot has this identity or capability';
  if ((await tx.query('SELECT 1 FROM lifecycle_blueprints WHERE novelty_key=$1', [key])).rows.length) return 'a lifecycle blueprint already covers this capability';
  const pending = (await tx.query(`SELECT 1 FROM bot_birth_proposals p WHERE (p.novelty_key=$1 OR p.bot_id=$2) AND ($3::uuid IS NULL OR p.id<>$3)
    AND NOT EXISTS (SELECT 1 FROM bot_birth_decisions d WHERE d.proposal_id=p.id AND d.outcome='rejected')`, [key, botId, exceptProposal ?? null])).rows;
  return pending.length ? 'another proposal already covers this capability or identity' : null;
}

export class BotBirths {
  constructor(private readonly db: Database) {}

  propose(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'researcher', 'evaluator');
    const input = parse(proposalSchema, raw);
    return this.db.command(actor, 'bot-birth-proposal', key, input, async tx => {
      requireThat((await tx.query("SELECT 1 FROM departments WHERE id=$1 AND status='active'", [input.department])).rows.length,
        'New specialists are born only into an active registered department');
      const novelty = noveltyKey(input.department, input.specialty, input.method);
      const clash = await duplicate(tx, input.botId, novelty);
      requireThat(!clash, 'Not novel: ' + clash);
      const verified = (await tx.query(`SELECT e.id FROM evidence e JOIN sources s ON s.id=e.source_id WHERE e.id=ANY($1::uuid[])
        AND e.status='verified' AND s.approved=true`, [input.evidenceIds])).rows.length;
      requireThat(verified === new Set(input.evidenceIds).size, 'Every cited evidence must be verified and from an approved source');
      const proposalId = uuid();
      await tx.query(`INSERT INTO bot_birth_proposals(id,bot_id,name,department,specialty,method,novelty_key,contribution,opportunity,success_criterion,proposer)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [proposalId, input.botId, input.name, input.department, input.specialty, input.method, novelty,
        input.contribution, input.opportunity, input.successCriterion, actor.id]);
      for (const e of new Set(input.evidenceIds)) await tx.query('INSERT INTO bot_birth_proposal_evidence VALUES($1,$2)', [proposalId, e]);
      await audit(tx, actor, 'bot.birth.proposed', proposalId, { botId: input.botId, department: input.department, novelty });
      return { id: proposalId };
    });
  }

  decide(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'owner');
    const input = parse(decisionSchema, raw);
    return this.db.command(actor, 'bot-birth-decision', key, input, async tx => {
      const p = (await tx.query('SELECT * FROM bot_birth_proposals WHERE id=$1', [input.proposalId])).rows[0];
      requireThat(p, 'Proposal not found', 404);
      requireThat(!(await tx.query('SELECT 1 FROM bot_birth_decisions WHERE proposal_id=$1', [p.id])).rows.length, 'Proposal already decided');
      let mentor: string | null = null;
      if (input.outcome === 'approved') {
        const dept = (await tx.query('SELECT status,lead_bot_id FROM departments WHERE id=$1', [p.department])).rows[0];
        requireThat(dept?.status === 'active', 'The department is no longer active');
        const clash = await duplicate(tx, p.bot_id, p.novelty_key, String(p.id));
        requireThat(!clash, 'No longer novel: ' + clash);
        mentor = input.mentorId ?? dept.lead_bot_id ?? null;
        if (mentor) requireThat((await tx.query("SELECT 1 FROM bots WHERE id=$1 AND state<>'retired'", [mentor])).rows.length, 'Mentor not found or retired');
        await tx.query(`INSERT INTO bots(id,name,department,specialty,method,novelty_key,contribution,state,budget_paise,mentor_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,'school',0,$8)`, [p.bot_id, p.name, p.department, p.specialty, p.method, p.novelty_key, p.contribution, mentor]);
        await audit(tx, actor, 'bot.created', p.bot_id, { birthProposal: String(p.id), department: p.department, state: 'school', budgetPaise: '0', mentorId: mentor });
      }
      await tx.query('INSERT INTO bot_birth_decisions(proposal_id,outcome,mentor_id,note,decided_by) VALUES($1,$2,$3,$4,$5)',
        [p.id, input.outcome, mentor, input.note, actor.id]);
      await audit(tx, actor, 'bot.birth.decided', String(p.id), { outcome: input.outcome, botId: p.bot_id });
      return { proposalId: String(p.id), outcome: input.outcome, ...(input.outcome === 'approved' ? { botId: p.bot_id, state: 'school', budgetPaise: '0', mentorId: mentor } : {}) };
    });
  }

  list(actor: Actor) {
    permit(actor, 'owner', 'researcher', 'evaluator');
    return this.db.transaction(async tx => {
      const rows = (await tx.query(`SELECT p.*,d.outcome,d.note,d.mentor_id AS decided_mentor FROM bot_birth_proposals p
        LEFT JOIN bot_birth_decisions d ON d.proposal_id=p.id ORDER BY p.created_at DESC LIMIT 200`)).rows;
      const bots = (await tx.query('SELECT id,department,specialty,method FROM bots')).rows;
      return { proposals: rows.map(p => ({ id: String(p.id), botId: p.bot_id, name: p.name, department: p.department, specialty: p.specialty, method: p.method,
        contribution: p.contribution, opportunity: p.opportunity, successCriterion: p.success_criterion, proposer: p.proposer,
        status: p.outcome ?? 'pending', note: p.note ?? null,
        // novelty assessment for the owner: same specialty in the department, or same specialty and method elsewhere
        similarBots: bots.filter(b => b.id !== p.bot_id && ((b.department === p.department && b.specialty.toLowerCase() === p.specialty.toLowerCase())
          || (b.specialty.toLowerCase() === p.specialty.toLowerCase() && b.method.toLowerCase() === p.method.toLowerCase()))).map(b => b.id) })),
        note: 'Approved births start in school with zero budget; trading requires qualification.' };
    }, false);
  }
}

type Request = { actor: Actor };
@Controller('v1')
export class BotBirthsController {
  constructor(private readonly births: BotBirths) {}
  @Get('bots/births') @Allow('owner', 'researcher', 'evaluator') list(@Req() r: Request) { return this.births.list(r.actor); }
  @Post('bots/births/proposals') @Allow('researcher', 'evaluator') propose(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.births.propose(r.actor, k ?? '', b); }
  @Post('bots/births/decisions') @Allow('owner') decide(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.births.decide(r.actor, k ?? '', b); }
}
