import { createHash } from 'node:crypto';
import { INLINE_SCRIPTS } from './output/scripts.js';

// The CSP hash source ('sha256-…') of one inline script body.
export function scriptHash(body: string): string {
  return `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;
}

// Every inline <script> the pages serve is a fixed string (output/scripts.ts),
// so script-src lists their hashes instead of allowing any inline code; a
// script injected into a page (or any inline event handler) does not run.
export const scriptHashes: readonly string[] = INLINE_SCRIPTS.map(scriptHash);

// Baseline hardening sent on every response, whether it comes from the Hono
// app, the homepage snapshot or the gateway itself. Nothing loads from other
// origins except Cloudflare's beacon and remote cover art.
export const securityHeaders: Record<string, string> = {
  // Served only over HTTPS behind Traefik; browsers ignore HSTS on plain HTTP.
  'Strict-Transport-Security': 'max-age=15552000',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  // Pages use inline <style> (and style attributes) and remote cover art;
  // inline scripts are allowed by hash only. Cloudflare's edge injects its Web
  // Analytics beacon as an external script, which must keep working.
  // Everything else stays on this origin.
  'Content-Security-Policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; "
    + `script-src 'self' ${scriptHashes.join(' ')} https://static.cloudflareinsights.com; `
    + "font-src 'self'; connect-src 'self' https://cloudflareinsights.com; frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};
