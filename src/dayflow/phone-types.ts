import { z } from 'zod';

// One screen observation from the Android companion's accessibility service.
// Text and the optional JPEG thumbnail are private, short-lived inputs to the
// summarizer; only the resulting activity cards are kept.
const timestamp = z.string().datetime({ offset: true });
export const phoneObservationSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9-]{8,64}$/),
  capturedAt: timestamp,
  package: z.string().min(1).max(200),
  appLabel: z.string().max(200),
  text: z.string().max(4000),
  blocked: z.boolean(),
  image: z.string().max(400_000).regex(/^[A-Za-z0-9+/]+={0,2}$/).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.blocked && (v.text || v.image)) ctx.addIssue({ code: 'custom', message: 'Blocked observations carry no content' });
});
export const phoneObservationBatchSchema = z.object({
  schemaVersion: z.literal(1),
  deviceId: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/),
  observations: z.array(phoneObservationSchema).min(1).max(40),
}).strict().superRefine((v, ctx) => {
  const now = Date.now();
  if (new Set(v.observations.map((o) => o.id)).size !== v.observations.length) ctx.addIssue({ code: 'custom', message: 'Duplicate observation IDs' });
  if (v.observations.some((o) => Date.parse(o.capturedAt) > now + 300_000)) ctx.addIssue({ code: 'custom', message: 'Observation is in the future' });
});
export type PhoneObservationBatch = z.infer<typeof phoneObservationBatchSchema>;
export type PhoneObservation = z.infer<typeof phoneObservationSchema>;

// Fixed phone taxonomy. Names are public (category totals), colors match the
// Dayflow page's swatches.
export const PHONE_CATEGORIES = [
  { name: 'Work', color_hex: '#4F7CAC', is_idle: false, is_system: false },
  { name: 'Learning', color_hex: '#6A9C78', is_idle: false, is_system: false },
  { name: 'Communication', color_hex: '#D08C3A', is_idle: false, is_system: false },
  { name: 'Social media', color_hex: '#C2577A', is_idle: false, is_system: false },
  { name: 'Entertainment', color_hex: '#8A63B8', is_idle: false, is_system: false },
  { name: 'News & reading', color_hex: '#3F9AA0', is_idle: false, is_system: false },
  { name: 'Life admin', color_hex: '#9C8A5B', is_idle: false, is_system: false },
  { name: 'Idle', color_hex: '#B8B0A8', is_idle: true, is_system: true },
] as const;
export type PhoneCategory = typeof PHONE_CATEGORIES[number]['name'];
export const PHONE_CATEGORY_NAMES = PHONE_CATEGORIES.map((c) => c.name) as [PhoneCategory, ...PhoneCategory[]];
