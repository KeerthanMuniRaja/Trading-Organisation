import { createPublicKey } from 'node:crypto';
import { z } from 'zod';
import { Actor, roles } from './core.js';

export interface Config {
  mode: 'paper'; host: string; port: number; databasePath: string; databaseUrl?: string;
  principals: Array<Actor & { token: string }>;
  ownerPublicKey: string;
  maxOrder: bigint; maxExposure: bigint; maxLoss: bigint;
  feeBps: number; slippageBps: number;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env.APP_MODE !== 'paper') throw new Error('APP_MODE must explicitly be paper. Live execution is not implemented.');
  const principals = z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), role: z.enum(roles),
    token: z.string().min(43).max(200), botId: z.string().optional(),
  }).strict()).min(1).parse(JSON.parse(env.PRINCIPALS_JSON ?? '[]'));
  if (new Set(principals.map(p => p.token)).size !== principals.length || new Set(principals.map(p => p.id)).size !== principals.length) throw new Error('Principal IDs and tokens must be unique');
  if (principals.filter(p => p.role === 'owner').length !== 1) throw new Error('Exactly one owner is required');
  if (principals.some(p => p.role === 'trader' && !p.botId)) throw new Error('Trader credentials must be bound to a bot');
  const ownerPublicKey = Buffer.from(env.OWNER_PUBLIC_KEY_BASE64 ?? '', 'base64').toString();
  if (createPublicKey(ownerPublicKey).asymmetricKeyType !== 'ed25519') throw new Error('Owner public key must be Ed25519');
  const limit = (key: string) => BigInt(z.string().regex(/^[1-9][0-9]{0,13}$/).parse(env[key]));
  const bps = (key: string) => z.coerce.number().int().min(0).max(1000).parse(env[key]);
  return {
    mode: 'paper', host: env.HOST ?? '127.0.0.1', port: z.coerce.number().int().min(1).max(65535).parse(env.PORT ?? 3000),
    databasePath: env.DATABASE_PATH ?? '.data/paper', databaseUrl: env.DATABASE_URL,
    principals, ownerPublicKey, maxOrder: limit('MAX_ORDER_PAISE'), maxExposure: limit('MAX_EXPOSURE_PAISE'),
    maxLoss: limit('MAX_REALISED_LOSS_PAISE'), feeBps: bps('PAPER_FEE_BPS'), slippageBps: bps('PAPER_SLIPPAGE_BPS'),
  };
}
