import { Body, Controller, Get, Headers, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Actor, digest, id, parse, permit, requireThat, uuid } from './core.js';
import { Database, Sql, audit } from './database.js';
import { compute } from './paper-performance.js';
import { Allow } from './security.js';

// Department registry (ORG-01). A department is a charter: mandate, lead and an owner-set budget ceiling for the sum of
// its members' budgets. Members are the bots carrying the department's id as their department label.
// Research and evaluator bots may PROPOSE opening or closing a department with verified evidence of the opportunity
// or of its failure; only the owner decides, sets the budget and appoints the lead. A department closes only when no
// member holds a paper position or a reserved order, so closing never strands risk. The registry view reports each
// department's members, budget use, combined paper P&L and latest fitness verdicts as evidence for those decisions.

const text = (max: number) => z.string().trim().min(1).max(max);
const proposalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('open'), departmentId: id, name: text(120), mandate: text(600), rationale: text(1000),
    evidenceIds: z.array(z.uuid()).min(1).max(10) }).strict(),
  z.object({ kind: z.literal('close'), departmentId: id, rationale: text(1000), evidenceIds: z.array(z.uuid()).min(1).max(10) }).strict(),
]);
const decisionSchema = z.object({ proposalId: z.uuid(), outcome: z.enum(['approved', 'rejected']),
  budgetPaise: z.string().regex(/^\d{1,15}$/).optional(), note: text(600) }).strict();
const leadSchema = z.object({ departmentId: id, leadBotId: id }).strict();

async function verified(tx: Sql, ids: string[]) {
  return (await tx.query(`SELECT e.id FROM evidence e JOIN sources s ON s.id=e.source_id WHERE e.id=ANY($1::uuid[])
    AND e.status='verified' AND s.approved=true`, [ids])).rows.length === new Set(ids).size;
}

export class Departments {
  constructor(private readonly db: Database) {}

  propose(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'researcher', 'evaluator');
    const input = parse(proposalSchema, raw);
    return this.db.command(actor, 'department-proposal', key, input, async tx => {
      const dept = (await tx.query('SELECT status FROM departments WHERE id=$1', [input.departmentId])).rows[0];
      if (input.kind === 'open') requireThat(!dept || dept.status === 'closed', 'Department is already active');
      else requireThat(dept?.status === 'active', 'Only an active department can be proposed for closure');
      requireThat(await verified(tx, input.evidenceIds), 'Every cited evidence must be verified and from an approved source');
      const hash = digest(input);
      const old = (await tx.query('SELECT id FROM department_proposals WHERE content_hash=$1', [hash])).rows[0];
      if (old) return { id: String(old.id), duplicate: true };
      const proposalId = uuid();
      await tx.query(`INSERT INTO department_proposals(id,kind,department_id,name,mandate,rationale,proposer,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [proposalId, input.kind, input.departmentId, input.kind === 'open' ? input.name : null, input.kind === 'open' ? input.mandate : null,
          input.rationale, actor.id, hash]);
      for (const e of new Set(input.evidenceIds)) await tx.query('INSERT INTO department_proposal_evidence VALUES($1,$2)', [proposalId, e]);
      await audit(tx, actor, 'department.proposed', proposalId, { kind: input.kind, departmentId: input.departmentId });
      return { id: proposalId, duplicate: false };
    });
  }

  decide(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'owner');
    const input = parse(decisionSchema, raw);
    return this.db.command(actor, 'department-decision', key, input, async tx => {
      const p = (await tx.query('SELECT * FROM department_proposals WHERE id=$1', [input.proposalId])).rows[0];
      requireThat(p, 'Proposal not found', 404);
      requireThat(!(await tx.query('SELECT id FROM department_decisions WHERE proposal_id=$1', [p.id])).rows.length, 'Proposal already decided');
      if (input.outcome === 'approved') {
        const dept = (await tx.query('SELECT status FROM departments WHERE id=$1', [p.department_id])).rows[0];
        if (p.kind === 'open') {
          requireThat(input.budgetPaise !== undefined, 'Approving a department requires its budget ceiling', 400);
          requireThat(!dept || dept.status === 'closed', 'Department is already active');
          if (dept) await tx.query(`UPDATE departments SET name=$2,mandate=$3,budget_paise=$4,status='active',lead_bot_id=NULL,opened_at=now(),closed_at=NULL WHERE id=$1`,
            [p.department_id, p.name, p.mandate, input.budgetPaise]);
          else await tx.query(`INSERT INTO departments(id,name,mandate,budget_paise,status) VALUES($1,$2,$3,$4,'active')`,
            [p.department_id, p.name, p.mandate, input.budgetPaise]);
        } else {
          requireThat(dept?.status === 'active', 'Department is not active');
          const risk = (await tx.query(`SELECT b.id FROM bots b WHERE b.department=$1 AND (
            EXISTS (SELECT 1 FROM positions p WHERE p.bot_id=b.id AND p.quantity>0) OR
            EXISTS (SELECT 1 FROM orders o WHERE o.bot_id=b.id AND o.status='reserved'))`, [p.department_id])).rows;
          requireThat(!risk.length, `Close members' positions and orders first: ${risk.map(r => r.id).join(', ')}`);
          await tx.query(`UPDATE departments SET status='closed',closed_at=now(),lead_bot_id=NULL WHERE id=$1`, [p.department_id]);
        }
      }
      const decisionId = uuid();
      await tx.query(`INSERT INTO department_decisions(id,proposal_id,outcome,budget_paise,note,decided_by) VALUES($1,$2,$3,$4,$5,$6)`,
        [decisionId, p.id, input.outcome, input.budgetPaise ?? null, input.note, actor.id]);
      await audit(tx, actor, 'department.decided', p.id, { kind: p.kind, departmentId: p.department_id, outcome: input.outcome, budgetPaise: input.budgetPaise ?? null });
      return { proposalId: String(p.id), departmentId: p.department_id, kind: p.kind, outcome: input.outcome };
    });
  }

  appointLead(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'owner');
    const input = parse(leadSchema, raw);
    return this.db.command(actor, 'department-lead', key, input, async tx => {
      requireThat((await tx.query("SELECT 1 FROM departments WHERE id=$1 AND status='active'", [input.departmentId])).rows.length, 'Department is not active');
      const bot = (await tx.query('SELECT department,state FROM bots WHERE id=$1', [input.leadBotId])).rows[0];
      requireThat(bot, 'Bot not found', 404);
      requireThat(bot.department === input.departmentId, 'A lead must be a member of the department');
      requireThat(bot.state !== 'retired', 'A retired bot cannot lead');
      await tx.query('UPDATE departments SET lead_bot_id=$2 WHERE id=$1', [input.departmentId, input.leadBotId]);
      await audit(tx, actor, 'department.lead.appointed', input.departmentId, input);
      return { departmentId: input.departmentId, leadBotId: input.leadBotId };
    });
  }

  registry(actor: Actor) {
    permit(actor, 'owner', 'researcher', 'evaluator');
    return this.db.transaction(async tx => {
      const depts = (await tx.query(`SELECT id,name,mandate,lead_bot_id,budget_paise::text AS budget,status,opened_at,closed_at FROM departments ORDER BY id`)).rows;
      const bots = (await tx.query('SELECT id,department,state,budget_paise::text AS budget FROM bots ORDER BY id')).rows;
      const fitness = new Map<string, string>((await tx.query(`SELECT DISTINCT ON (bot_id) bot_id,verdict FROM bot_fitness_reports
        ORDER BY bot_id,created_at DESC,id DESC`)).rows.map(r => [r.bot_id, r.verdict]));
      const pnl = new Map((await compute(tx, null, Date.now())).map(b => [b.botId, BigInt(b.totalPaise)]));
      const pending = (await tx.query(`SELECT p.id,p.kind,p.department_id,p.name,p.rationale,p.proposer,p.created_at FROM department_proposals p
        WHERE NOT EXISTS (SELECT 1 FROM department_decisions d WHERE d.proposal_id=p.id) ORDER BY p.created_at`)).rows;
      const registered = new Set(depts.map(d => d.id));
      return {
        departments: depts.map(d => {
          const members = bots.filter(b => b.department === d.id);
          const active = members.filter(b => b.state !== 'retired');
          const allocated = active.reduce((s, b) => s + BigInt(b.budget), 0n);
          return { id: d.id, name: d.name, mandate: d.mandate, status: d.status, leadBotId: d.lead_bot_id, budgetPaise: d.budget,
            allocatedToMembersPaise: allocated.toString(), overBudget: d.status === 'active' && allocated > BigInt(d.budget),
            members: members.map(b => ({ botId: b.id, state: b.state, budgetPaise: b.budget, latestFitness: fitness.get(b.id) ?? null })),
            paperPnlPaise: members.reduce((s, b) => s + (pnl.get(b.id) ?? 0n), 0n).toString(),
            openedAt: new Date(d.opened_at).toISOString(), closedAt: d.closed_at ? new Date(d.closed_at).toISOString() : null };
        }),
        unregisteredLabels: [...new Set(bots.filter(b => !registered.has(b.department)).map(b => b.department))].sort(),
        pendingProposals: pending.map(p => ({ id: String(p.id), kind: p.kind, departmentId: p.department_id, name: p.name,
          rationale: p.rationale, proposer: p.proposer, createdAt: new Date(p.created_at).toISOString() })),
        note: 'Budgets here are ceilings the owner set; they do not move money. Bots propose, the owner decides.' };
    }, false);
  }
}

type Request = { actor: Actor };
@Controller('v1')
export class DepartmentsController {
  constructor(private readonly departments: Departments) {}
  @Get('departments') @Allow('owner', 'researcher', 'evaluator') registry(@Req() r: Request) { return this.departments.registry(r.actor); }
  @Post('departments/proposals') @Allow('researcher', 'evaluator') propose(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.departments.propose(r.actor, k ?? '', b); }
  @Post('departments/decisions') @Allow('owner') decide(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.departments.decide(r.actor, k ?? '', b); }
  @Post('departments/leads') @Allow('owner') lead(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.departments.appointLead(r.actor, k ?? '', b); }
}
