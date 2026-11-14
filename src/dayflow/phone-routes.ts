import { timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import type { DayflowPhoneStore } from './phone-store.js';
import { dayflowDay } from './types.js';

export function phoneActivityRoute(app: Hono, path: string, store: DayflowPhoneStore, token: string) {
  app.get(path, (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Robots-Tag', 'noindex, nofollow');
    c.header('Vary', 'Authorization');
    const auth = c.req.header('authorization');
    const supplied = Buffer.from(auth?.startsWith('Bearer ') ? auth.slice(7) : '');
    const expected = Buffer.from(token);
    if (!expected.length || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const day = c.req.query('day') ?? dayflowDay();
    const device = c.req.query('deviceId');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day
      || (device !== undefined && !/^[a-zA-Z0-9._-]{1,64}$/.test(device))) return c.json({ error: 'Invalid day or device' }, 400);
    return c.json(store.activity(day, device));
  });
}
