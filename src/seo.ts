// Crawler-facing text. No imports: the gateway serves robots.txt from memory
// so a busy backend can never turn it into a 5xx, which Google treats as the
// whole host being unavailable.

export function publicBaseUrl(env: Record<string, string | undefined>): string {
  return (env.PUBLIC_BASE_URL ?? (env.DOMAIN ? `https://${env.DOMAIN}` : 'http://localhost:3000')).replace(/\/$/, '');
}

// /api/ holds machine-readable JSON and the authenticated ingest endpoints;
// /mcp is the MCP transport. The /api documentation page itself stays crawlable.
export function robotsTxt(baseUrl: string): string {
  return `User-agent: *\nDisallow: /api/\nDisallow: /mcp\n\nSitemap: ${baseUrl}/sitemap.xml\n`;
}

function xml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[char]!));
}

export function sitemapXml(baseUrl: string, paths: string[]): string {
  const urls = paths.map((path) => `<url><loc>${xml(baseUrl + path)}</loc></url>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>\n`;
}
