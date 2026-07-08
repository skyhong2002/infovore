import { createHash } from 'node:crypto';
import { config } from '../config.js';

// Anubis (github.com/TecharoHQ/anubis) is a proof-of-work anti-bot gate.
// The challenge page embeds a JSON blob; solving it means finding a nonce
// whose sha256(randomData + nonce) hex has `difficulty` leading zero
// characters. Submitting the solution (along with the challenge page's own
// cookies) grants a ~1-week auth cookie.

interface AnubisChallenge {
  rules: { difficulty: number; algorithm: string };
  challenge: { id: string; randomData: string };
}

const AUTH_COOKIE = 'techaro.lol-anubis-auth';

// Per-origin cookie jar (cookie name -> value), holding the auth cookie plus
// any incidental cookies (bunny_shield, etc.) needed for later requests.
const jars = new Map<string, Map<string, string>>();

function jar(origin: string): Map<string, string> {
  let j = jars.get(origin);
  if (!j) {
    j = new Map();
    jars.set(origin, j);
  }
  return j;
}

export function cookieHeader(origin: string): string {
  return Array.from(jar(origin))
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

export function hasAnubisAuth(origin: string): boolean {
  return jar(origin).has(AUTH_COOKIE);
}

export function clearAnubisCookie(origin: string): void {
  jars.delete(origin);
}

// Merge a Response's Set-Cookie headers into the origin's jar, dropping
// cookies that are being cleared (empty value / Max-Age=0).
export function absorbCookies(origin: string, res: Response): void {
  const j = jar(origin);
  const setCookies: string[] = (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie?.() ?? [];
  for (const sc of setCookies) {
    const first = sc.split(';')[0];
    const eq = first.indexOf('=');
    if (eq < 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    const cleared = value === '' || /max-age=0/i.test(sc);
    if (cleared) j.delete(name);
    else j.set(name, value);
  }
}

export function isAnubisChallenge(html: string): boolean {
  return html.includes('id="anubis_challenge"') || html.includes("you're not a bot");
}

function parseChallenge(html: string): AnubisChallenge | null {
  const m = html.match(/<script id="anubis_challenge"[^>]*>(.*?)<\/script>/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// Mirror of the reference worker: count leading zero hex chars of
// sha256(randomData + nonce).
function solvePow(randomData: string, difficulty: number, maxIters = 5_000_000): { hash: string; nonce: number } | null {
  for (let nonce = 0; nonce < maxIters; nonce++) {
    const hash = createHash('sha256').update(randomData + nonce).digest('hex');
    let zeros = 0;
    while (zeros < hash.length && hash[zeros] === '0') zeros++;
    if (zeros >= difficulty) return { hash, nonce };
  }
  return null;
}

// Given a challenge page's HTML and the response it came on, solve the PoW
// and obtain the auth cookie. Returns true on success (jar now holds auth).
export async function solveAnubis(
  challengeRes: Response,
  html: string,
  origin: string,
  redir: string
): Promise<boolean> {
  absorbCookies(origin, challengeRes); // picks up the cookie-verification token
  const challenge = parseChallenge(html);
  if (!challenge) return false;
  const { difficulty } = challenge.rules;
  const { id, randomData } = challenge.challenge;

  const start = Date.now();
  const solution = solvePow(randomData, difficulty);
  if (!solution) return false;
  const elapsed = Date.now() - start;

  const params = new URLSearchParams({
    id,
    response: solution.hash,
    nonce: String(solution.nonce),
    redir,
    elapsedTime: String(Math.max(elapsed, 100)),
  });
  const res = await fetch(
    `${origin}/.within.website/x/cmd/anubis/api/pass-challenge?${params}`,
    {
      headers: { 'User-Agent': config.userAgent, Cookie: cookieHeader(origin) },
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    }
  );
  absorbCookies(origin, res);
  return hasAnubisAuth(origin);
}
