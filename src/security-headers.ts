// Baseline hardening sent on every response, whether it comes from the Hono
// app, the homepage snapshot or the gateway itself. Pages use inline styles
// and scripts, so the CSP allows inline code but nothing from other origins.
export const securityHeaders: Record<string, string> = {
  // Served only over HTTPS behind Traefik; browsers ignore HSTS on plain HTTP.
  'Strict-Transport-Security': 'max-age=15552000',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  // Pages use inline <style>/<script> and remote cover art; everything else
  // stays on this origin.
  'Content-Security-Policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};
