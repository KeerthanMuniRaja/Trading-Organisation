import { Body, Controller, Headers, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Actor, id, parse, permit, requireThat, uuid } from './core.js';
import { Database, Sql, audit } from './database.js';
import { Allow } from './security.js';

// Bot releases (RELEASE-01) and runtime profiles (AI-02). A release binds a bot's model, prompt version and code
// fingerprint (plus bounded settings). An independent evaluator links it to a fitness report for the same bot and model:
//   canary-eligible  the report is not 'worse-than-baseline';
//   active-eligible  additionally it had enough disagreements to judge ('adds-value' or 'no-detectable-skill').
// The owner moves a release to canary or active; any revocation or a rollback is one owner action. A worker asks
// POST /v1/releases/check with its exact version and runs only if allowed. Switching to a stronger model is therefore:
// register, evaluate on the same tests, canary, activate, with the previous release one rollback away.

const fingerprint = z.string().regex(/^[a-f0-9]{16,64}$/);
/** Evaluations expire (SCHOOL-01): markets change, so a qualification earned long ago must be re-earned. */
export const EVALUATION_VALID_DAYS = 180;
const createSchema = z.object({ botId: id, model: z.string().trim().min(1).max(120), promptVersion: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/),
  codeFingerprint: fingerprint, settings: z.object({ temperature: z.number().min(0).max(2).optional(), maxTokens: z.number().int().min(16).max(32768).optional(),
    timeoutSeconds: z.number().int().min(5).max(900).optional() }).strict().default({}), notes: z.string().trim().min(1).max(600) }).strict();
const evaluateSchema = z.object({ releaseId: z.uuid(), fitnessReportId: z.uuid() }).strict();
const stageSchema = z.object({ releaseId: z.uuid(), stage: z.enum(['canary', 'active', 'revoked']), reason: z.string().trim().min(1).max(600) }).strict();
const rollbackSchema = z.object({ botId: id, reason: z.string().trim().min(1).max(600) }).strict();
const checkSchema = z.object({ botId: id, model: z.string().trim().min(1).max(120), promptVersion: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/), codeFingerprint: fingerprint }).strict();
const viewSchema = z.object({ botId: id }).strict();
const qualifySchema = z.object({ botId: id, reason: z.string().trim().min(1).max(600) }).strict();

/** Current stage per release of a bot: the latest stage row for each release wins. */
async function stages(tx: Sql, botId: string) {
  const rows = (await tx.query(`SELECT DISTINCT ON (release_id) release_id,stage,sequence FROM bot_release_stages WHERE bot_id=$1
    ORDER BY release_id,sequence DESC`, [botId])).rows;
  return new Map(rows.map(r => [String(r.release_id), { stage: r.stage as string, sequence: Number(r.sequence) }]));
}

/** Releases a bot may run right now: its current active release and any canaries (used to gate trade proposals). */
export async function liveReleases(tx: Sql, botId: string) {
  const { active, map } = await current(tx, botId);
  const ids = [...map.entries()].filter(([releaseId, s]) => releaseId === active || s.stage === 'canary').map(([releaseId]) => releaseId);
  if (!ids.length) return { registered: map.size > 0, releases: [] as Record<string, any>[] };
  return { registered: true, releases: (await tx.query('SELECT * FROM bot_releases WHERE id=ANY($1::uuid[])', [ids])).rows };
}

/** The release a bot should run: the most recently activated release still 'active'; a canary only when none is active. */
async function current(tx: Sql, botId: string) {
  const map = await stages(tx, botId);
  const by = (stage: string) => [...map.entries()].filter(([, s]) => s.stage === stage).sort((a, b) => b[1].sequence - a[1].sequence)[0]?.[0] ?? null;
  return { active: by('active'), canary: by('canary'), map };
}

/** Stages a release inside the caller's transaction: the owner's decision, or a standing approval acting for the owner. */
export async function applyStage(tx: Sql, actor: Actor, input: { releaseId: string; stage: 'canary' | 'active' | 'revoked'; reason: string }) {
  const release = (await tx.query('SELECT * FROM bot_releases WHERE id=$1', [input.releaseId])).rows[0];
  requireThat(release, 'Release not found', 404);
  const { map } = await current(tx, release.bot_id);
  requireThat(map.get(String(release.id))?.stage !== 'revoked', 'A revoked release cannot be staged again; register a new one');
  if (input.stage !== 'revoked') {
    const flag = input.stage === 'canary' ? 'canary_eligible' : 'active_eligible';
    // the newest evaluation decides: a later worse result withdraws eligibility
    const latest = (await tx.query(`SELECT ${flag} AS ok,created_at >= now() - ($2::int * interval '1 day') AS fresh FROM bot_release_evaluations
      WHERE release_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`, [release.id, EVALUATION_VALID_DAYS])).rows[0];
    requireThat(latest?.ok === true, input.stage === 'canary' ? 'Canary needs an evaluation that is not worse than its baseline'
      : 'Activation needs an evaluation with enough evidence that is not worse than its baseline');
    requireThat(latest.fresh === true, `The release's evaluation is older than ${EVALUATION_VALID_DAYS} days; re-test before staging it`);
  }
  await tx.query('INSERT INTO bot_release_stages(id,bot_id,release_id,stage,reason,decided_by) VALUES($1,$2,$3,$4,$5,$6)',
    [uuid(), release.bot_id, release.id, input.stage, input.reason, actor.id]);
  await audit(tx, actor, 'bot.release.staged', release.id, { botId: release.bot_id, stage: input.stage });
  return { releaseId: String(release.id), botId: release.bot_id as string, stage: input.stage };
}

/** Qualifies a school or college bot for paper trading inside the caller's transaction (see BotReleases.qualify). */
export async function applyQualify(tx: Sql, actor: Actor, input: { botId: string; reason: string }) {
  const bot = (await tx.query('SELECT state,lifecycle_managed FROM bots WHERE id=$1', [input.botId])).rows[0];
  requireThat(bot, 'Bot not found', 404);
  requireThat(bot.state === 'school' || bot.state === 'college', bot.state === 'paper' ? 'Bot is already qualified' : 'Retired bots cannot qualify');
  requireThat(!bot.lifecycle_managed, 'Lifecycle-managed students qualify through their research route');
  const { active } = await current(tx, input.botId);
  requireThat(active, 'Qualification needs an active release');
  const evaluation = (await tx.query(`SELECT active_eligible,fitness_verdict,created_at >= now() - ($2::int * interval '1 day') AS fresh FROM bot_release_evaluations
    WHERE release_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`, [active, EVALUATION_VALID_DAYS])).rows[0];
  requireThat(evaluation?.active_eligible === true && evaluation.fresh === true, 'The active release needs a fresh evaluation with enough evidence that is not worse than its baseline');
  await tx.query("UPDATE bots SET state='paper' WHERE id=$1", [input.botId]);
  await audit(tx, actor, 'bot.qualified.paper', input.botId, { releaseId: active, fitnessVerdict: evaluation.fitness_verdict, reason: input.reason });
  return { botId: input.botId, state: 'paper', releaseId: active };
}

/** The release a bot runs now and the earlier active one it could return to (null when there is none). */
export async function rollbackTarget(tx: Sql, botId: string) {
  const { active, map } = await current(tx, botId);
  if (!active) return { active: null, previous: null };
  const history = (await tx.query(`SELECT release_id FROM bot_release_stages WHERE bot_id=$1 AND stage='active' ORDER BY sequence DESC`, [botId])).rows
    .map(r => String(r.release_id));
  return { active, previous: history.find(r => r !== active && map.get(r)?.stage !== 'revoked') ?? null };
}

/** Revokes the active release and reactivates the previous one, inside the caller's transaction. */
export async function applyRollback(tx: Sql, actor: Actor, input: { botId: string; reason: string }) {
  const { active, previous } = await rollbackTarget(tx, input.botId);
  requireThat(active, 'No active release to roll back');
  requireThat(previous, 'There is no earlier active release to return to');
  for (const [releaseId, stage] of [[active, 'revoked'], [previous, 'active']] as const)
    await tx.query('INSERT INTO bot_release_stages(id,bot_id,release_id,stage,reason,decided_by) VALUES($1,$2,$3,$4,$5,$6)',
      [uuid(), input.botId, releaseId, stage, 'Rollback: ' + input.reason, actor.id]);
  await audit(tx, actor, 'bot.release.rolled-back', input.botId, { from: active, to: previous });
  return { botId: input.botId, revoked: active as string, active: previous as string };
}

export class BotReleases {
  constructor(private readonly db: Database) {}

  create(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'owner', 'researcher');
    const input = parse(createSchema, raw);
    return this.db.command(actor, 'bot-release', key, input, async tx => {
      const bot = (await tx.query('SELECT state FROM bots WHERE id=$1', [input.botId])).rows[0];
      requireThat(bot && bot.state !== 'retired', 'Active bot required', 404);
      const same = (await tx.query('SELECT id,version FROM bot_releases WHERE bot_id=$1 AND model=$2 AND prompt_version=$3 AND code_fingerprint=$4',
        [input.botId, input.model, input.promptVersion, input.codeFingerprint])).rows[0];
      if (same) return { id: String(same.id), version: same.version, duplicate: true };
      const version = Number((await tx.query('SELECT COALESCE(MAX(version),0)+1 AS v FROM bot_releases WHERE bot_id=$1', [input.botId])).rows[0]!.v);
      const releaseId = uuid();
      await tx.query(`INSERT INTO bot_releases(id,bot_id,version,model,prompt_version,code_fingerprint,settings,notes,author) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
        [releaseId, input.botId, version, input.model, input.promptVersion, input.codeFingerprint, JSON.stringify(input.settings), input.notes, actor.id]);
      await audit(tx, actor, 'bot.release.registered', releaseId, { botId: input.botId, version, model: input.model, promptVersion: input.promptVersion });
      return { id: releaseId, version, duplicate: false };
    });
  }

  evaluate(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'owner', 'evaluator');
    const input = parse(evaluateSchema, raw);
    return this.db.command(actor, 'bot-release-evaluation', key, input, async tx => {
      const release = (await tx.query('SELECT * FROM bot_releases WHERE id=$1', [input.releaseId])).rows[0];
      requireThat(release, 'Release not found', 404);
      requireThat(release.author !== actor.id, 'A release must be evaluated by someone other than its author', 403);
      const report = (await tx.query('SELECT * FROM bot_fitness_reports WHERE id=$1', [input.fitnessReportId])).rows[0];
      requireThat(report, 'Fitness report not found', 404);
      requireThat(report.bot_id === release.bot_id, 'The fitness report is for another bot');
      requireThat(report.model === release.model, 'The fitness report must be for the release\'s model');
      const canary = report.verdict !== 'worse-than-baseline';
      const active = report.verdict === 'adds-value' || report.verdict === 'no-detectable-skill';
      const old = (await tx.query('SELECT id FROM bot_release_evaluations WHERE release_id=$1 AND fitness_report_id=$2', [release.id, report.id])).rows[0];
      if (old) return { id: String(old.id), canaryEligible: canary, activeEligible: active, duplicate: true };
      const evaluationId = uuid();
      await tx.query(`INSERT INTO bot_release_evaluations(id,release_id,fitness_report_id,fitness_verdict,canary_eligible,active_eligible,evaluator)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [evaluationId, release.id, report.id, report.verdict, canary, active, actor.id]);
      await audit(tx, actor, 'bot.release.evaluated', release.id, { fitnessVerdict: report.verdict, canaryEligible: canary, activeEligible: active });
      return { id: evaluationId, canaryEligible: canary, activeEligible: active, duplicate: false };
    });
  }

  stage(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'owner');
    const input = parse(stageSchema, raw);
    return this.db.command(actor, 'bot-release-stage', key, input, tx => applyStage(tx, actor, input));
  }

  /** SCHOOL-01: the owner qualifies a school or college bot for paper trading on the strength of its own versioned
   *  capability: an active release whose newest evaluation is active-eligible and not expired. Lifecycle-managed research
   *  students keep their own route; retired bots never qualify. */
  qualify(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'owner');
    const input = parse(qualifySchema, raw);
    return this.db.command(actor, 'bot-qualification', key, input, tx => applyQualify(tx, actor, input));
  }

  /** Revokes the current active release and reactivates the previous one that was active and not revoked. */
  rollback(actor: Actor, key: string, raw: unknown) {
    permit(actor, 'owner');
    const input = parse(rollbackSchema, raw);
    return this.db.command(actor, 'bot-release-rollback', key, input, tx => applyRollback(tx, actor, input));
  }

  /** A worker's gate: may this exact model/prompt/code run for this bot right now? */
  check(actor: Actor, raw: unknown) {
    permit(actor, 'researcher', 'evaluator', 'trader', 'owner');
    const input = parse(checkSchema, raw);
    if (actor.role === 'trader') requireThat(actor.botId === input.botId, 'Credential is bound to another bot', 403);
    return this.db.transaction(async tx => {
      const { active, map } = await current(tx, input.botId);
      const live = [...map.entries()].filter(([, s]) => s.stage === 'active' || s.stage === 'canary').map(([releaseId]) => releaseId);
      if (!live.length) return { allowed: false, reason: 'no-authorised-release' };
      const releases = (await tx.query('SELECT * FROM bot_releases WHERE id=ANY($1::uuid[])', [live])).rows;
      // the exact active release, or any exact canary running alongside it on trial
      const match = releases.find(r => r.model === input.model && r.prompt_version === input.promptVersion && r.code_fingerprint === input.codeFingerprint
        && (String(r.id) === active || map.get(String(r.id))?.stage === 'canary'));
      if (match) return { allowed: true, releaseId: String(match.id), version: match.version, stage: String(match.id) === active ? 'active' : 'canary', settings: match.settings };
      const reference = releases.find(r => String(r.id) === active) ?? releases[0]!;
      return { allowed: false, reason: 'version-not-authorised', authorised: { version: reference.version, model: reference.model, promptVersion: reference.prompt_version } };
    }, false);
  }

  view(actor: Actor, raw: unknown) {
    permit(actor, 'owner', 'evaluator', 'researcher');
    const input = parse(viewSchema, raw);
    return this.db.transaction(async tx => {
      const { active, canary, map } = await current(tx, input.botId);
      const releases = (await tx.query('SELECT * FROM bot_releases WHERE bot_id=$1 ORDER BY version', [input.botId])).rows;
      const evals = (await tx.query(`SELECT e.* FROM bot_release_evaluations e JOIN bot_releases r ON r.id=e.release_id WHERE r.bot_id=$1 ORDER BY e.created_at`, [input.botId])).rows;
      return { botId: input.botId, active, canary,
        releases: releases.map(r => ({ id: String(r.id), version: r.version, model: r.model, promptVersion: r.prompt_version, codeFingerprint: r.code_fingerprint,
          settings: r.settings, notes: r.notes, stage: map.get(String(r.id))?.stage ?? 'registered',
          evaluations: evals.filter(e => String(e.release_id) === String(r.id)).map(e => ({ fitnessVerdict: e.fitness_verdict, canaryEligible: e.canary_eligible,
            activeEligible: e.active_eligible, evaluator: e.evaluator })) })) };
    }, false);
  }
}

type Request = { actor: Actor };
@Controller('v1')
export class BotReleasesController {
  constructor(private readonly releases: BotReleases) {}
  @Post('releases') @Allow('owner', 'researcher') create(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.releases.create(r.actor, k ?? '', b); }
  @Post('releases/evaluations') @Allow('owner', 'evaluator') evaluate(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.releases.evaluate(r.actor, k ?? '', b); }
  @Post('releases/stages') @Allow('owner') stage(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.releases.stage(r.actor, k ?? '', b); }
  @Post('releases/qualifications') @Allow('owner') qualify(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.releases.qualify(r.actor, k ?? '', b); }
  @Post('releases/rollbacks') @Allow('owner') rollback(@Req() r: Request, @Headers('idempotency-key') k: string, @Body() b: unknown) { return this.releases.rollback(r.actor, k ?? '', b); }
  @Post('releases/check') @Allow('researcher', 'evaluator', 'trader', 'owner') check(@Req() r: Request, @Body() b: unknown) { return this.releases.check(r.actor, b); }
  @Post('releases/view') @Allow('owner', 'evaluator', 'researcher') view(@Req() r: Request, @Body() b: unknown) { return this.releases.view(r.actor, b); }
}
