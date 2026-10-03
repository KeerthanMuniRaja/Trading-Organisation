import { createHash, randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { z } from 'zod';

export const roles = ['owner', 'researcher', 'evaluator', 'trader', 'treasury', 'market', 'coordinator'] as const;
export type Role = typeof roles[number];
export type Actor = { id: string; role: Role; botId?: string };
export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const money = z.string().regex(/^(0|[1-9][0-9]{0,13})$/);
export const positiveMoney = money.refine(v => BigInt(v) > 0n);
export const text = z.string().trim().min(1).max(4000);
export const symbol = z.string().regex(/^[A-Z][A-Z0-9._-]{0,19}$/);
export const timestamp = z.iso.datetime({ offset: true });
export const uuid = () => randomUUID();
export const now = () => new Date().toISOString();
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return '{' + Object.keys(object).sort().map(k => JSON.stringify(k) + ':' + canonical(object[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function requireThat(condition: unknown, message: string, status = 409): asserts condition {
  if (!condition) throw new HttpException(message, status);
}
export function permit(actor: Actor, ...allowed: Role[]) {
  requireThat(allowed.includes(actor.role), 'Operation not permitted', 403);
}
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpException({ message: 'Invalid request', issues: result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })) }, 400);
  return result.data;
}
export function ceilBps(value: bigint, bps: number) { return (value * BigInt(bps) + 9999n) / 10000n; }
export function bounded(value: bigint) {
  requireThat(value >= 0n && value <= 99999999999999n, 'Amount outside supported range', 400);
  return value;
}
