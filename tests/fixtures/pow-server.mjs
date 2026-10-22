// Synthetic impossible challenge; never contacts an upstream service.
import { createServer } from 'node:http';
import { solveAnubis } from '../../src/sources/anubis.ts';
const server = createServer(async (req, res) => {
  if (req.url === '/solve') {
    process.send?.({ type: 'solving' });
    try {
      const html = '<script id="anubis_challenge">' + JSON.stringify({ rules: { difficulty: 65, algorithm: 'fast' }, challenge: { id: 'synthetic', randomData: 'synthetic-only' } }) + '</script>';
      await solveAnubis(new Response(''), html, 'http://synthetic.invalid', '/');
      res.end('done');
    } catch (error) { res.statusCode = 503; res.end(String(error)); }
  } else res.end('alive');
});
server.listen(0, '127.0.0.1', () => process.send?.({ type: 'listening', port: server.address().port }));
process.on('disconnect', () => process.exit());
