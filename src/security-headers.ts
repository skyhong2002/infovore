// Baseline hardening sent on every response, whether it comes from the Hono
// app, the homepage snapshot or the gateway itself. Pages use inline styles
// and scripts, so there is no CSP here.
export const securityHeaders: Record<string, string> = {
  // Served only over HTTPS behind Traefik; browsers ignore HSTS on plain HTTP.
  'Strict-Transport-Security': 'max-age=15552000',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};
