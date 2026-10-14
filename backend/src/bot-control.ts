import { Body, Controller, Headers, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Actor, id, money, parse, permit, requireThat, uuid } from './core.js';
import { Database, Sql, audit } from './database.js';
import { Allow } from './security.js';

// Bot control (LIFE-02): before this, the only way to stop a misbehaving bot was retirement. The owner can now
// SUSPEND a bot: it takes no new risk (no entry proposals, no buy orders), while exits stay allowed so its risk can only
// fall. RESUME lifts it. The owner can also change a bot's budget. Every decision is append-only and audited; none is
// automatic (alerts and fitness reports recommend, the owner decides).

const suspendSchema = z.object({ botId: id, suspended: z.boolean(), reason: z.string().trim().min(1).max(600) }).strict();
const budgetSchema = z.object({ botId: id, budgetPaise: money, reason: z.string().trim().min(1).max(600) }).strict();

/** Whether the bot is suspended now (its latest suspension decision). */
export async function isSuspended(tx: Sql, botId: string) {
  return (await tx.query('SELECT suspended FROM bot_suspensions WHERE bot_id=$1 ORDER BY sequence DESC LIMIT 1', [botId])).rows[0]?.suspended === true;
}

export class BotControl {
  constructor(private readonly db: Database) {}

  suspend(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'owner');
    const input = parse(suspendSchema, raw);
    return this.db.command(actor, 'bot-suspension', key, input, async tx => {
      const bot = (await tx.query('SELECT state FROM bots WHERE id=$1', [input.botId])).rows[0];
      requireThat(bot, 'Bot not found', 404);
      requireThat(bot.state !== 'retired', 'A retired bot cannot be suspended or resumed');
      requireThat(await isSuspended(tx, input.botId) !== input.suspended, input.suspended ? 'The bot is already suspended' : 'The bot is not suspended');
      await tx.query('INSERT INTO bot_suspensions(id,bot_id,suspended,reason,decided_by) VALUES($1,$2,$3,$4,$5)',
        [uuid(), input.botId, input.suspended, input.reason, actor.id]);
      await audit(tx, actor, input.suspended ? 'bot.suspended' : 'bot.resumed', input.botId, { reason: input.reason });
      return { botId: input.botId, suspended: input.suspended };
    });
  }

  budget(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'owner');
    const input = parse(budgetSchema, raw);
    return this.db.command(actor, 'bot-budget-change', key, input, async tx => {
      const bot = (await tx.query('SELECT state,budget_paise::text AS budget FROM bots WHERE id=$1', [input.botId])).rows[0];
      requireThat(bot, 'Bot not found', 404);
      requireThat(bot.state !== 'retired', 'A retired bot has no budget to change');
      requireThat(bot.budget !== input.budgetPaise, 'The budget is already that amount');
      // a lower budget than what is already invested is allowed: it blocks new buys until positions are reduced
      await tx.query('UPDATE bots SET budget_paise=$2 WHERE id=$1', [input.botId, input.budgetPaise]);
      await tx.query('INSERT INTO bot_budget_changes(id,bot_id,budget_before,budget_after,reason,decided_by) VALUES($1,$2,$3,$4,$5,$6)',
        [uuid(), input.botId, bot.budget, input.budgetPaise, input.reason, actor.id]);
      await audit(tx, actor, 'bot.budget.changed', input.botId, { budgetBeforePaise: bot.budget, budgetAfterPaise: input.budgetPaise, reason: input.reason });
      return { botId: input.botId, budgetBeforePaise: bot.budget, budgetPaise: input.budgetPaise };
    });
  }
}

type Request = { actor: Actor };
@Controller('v1')
export class BotControlController {
  constructor(private readonly control: BotControl) {}
  @Post('bots/suspensions') @Allow('owner') suspend(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.control.suspend(r.actor, k ?? '', b); }
  @Post('bots/budgets') @Allow('owner') budget(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.control.budget(r.actor, k ?? '', b); }
}
