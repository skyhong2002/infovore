import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import * as z from 'zod/v4';
import type { Repository } from './data/database.js';

function result(value: unknown) {
  const structuredContent = Array.isArray(value)
    ? { data: value }
    : value && typeof value === 'object' ? value as Record<string, unknown> : { value };
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], structuredContent };
}

function unique(items: ReturnType<Repository['listActivities']>) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.source}:${item.sourceItemId ?? item.title.toLocaleLowerCase('en-US')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function createMcpServer(repository: Repository): McpServer {
  const server = new McpServer({ name: 'infovore', version: '1.0.0' });

  server.registerTool('get_recent_activities', {
    title: 'Recent activities', description: 'Get recent public media and event activities from the infovore lifelog.',
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(20),
      source: z.string().optional(), kind: z.string().optional(),
    },
  }, async ({ limit, source, kind }) => result(repository.queryActivities({ limit, source, kind })));

  server.registerTool('search_lifelog', {
    title: 'Search lifelog', description: 'Search public activity titles and metadata, optionally constrained by dates.',
    inputSchema: {
      query: z.string().min(1), since: z.string().optional(), until: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(20),
    },
  }, async ({ query, since, until, limit }) => result(repository.queryActivities({ query, since, until, limit })));

  server.registerTool('get_current_media', {
    title: 'Current media', description: 'Get items currently being played, watched, or read.', inputSchema: {},
  }, async () => result(unique(repository.listActivities(500).filter((item) => ['current', 'reading', 'watching', 'playing'].includes(item.status ?? ''))).slice(0, 50)));

  server.registerTool('get_upcoming_events', {
    title: 'Upcoming events', description: 'Get public upcoming events, without ticket, order, seat, or payment data.',
    inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
  }, async ({ limit }) => result({ data: unique(repository.queryActivities({ kind: 'event', since: new Date().toISOString(), limit: 100 }).data).slice(0, limit) }));

  server.registerTool('get_annual_summary', {
    title: 'Annual summary', description: 'Summarize cross-media activity for one year.',
    inputSchema: { year: z.number().int().min(2000).max(2200) },
  }, async ({ year }) => result(repository.wrapped(year)));

  return server;
}

export async function handleMcpRequest(repository: Repository, request: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  const server = createMcpServer(repository);
  await server.connect(transport);
  return transport.handleRequest(request);
}
