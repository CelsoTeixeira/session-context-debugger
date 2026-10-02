import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DataError, Sources, within } from '../core/source.js';
import { Sessions } from '../core/session.js';
import { T3Catalog } from '../core/t3.js';
import { T3Links } from '../core/t3-links.js';
import { object, string } from '../core/json.js';

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../ui');
const STATIC_TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const uuid = /^[0-9a-f-]{36}$/;
function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new DataError('invalid-request', 'Expected JSON content.', 415);
  const parts: Buffer[] = [];
  let bytes = 0;
  for await (const part of req) {
    bytes += Buffer.byteLength(part);
    if (bytes > 16 * 1024) throw new DataError('processing-limit', 'Request body exceeds 16 KiB.', 413);
    parts.push(Buffer.from(part));
  }
  try { return object(JSON.parse(Buffer.concat(parts).toString('utf8'))); }
  catch { throw new DataError('invalid-request', 'Invalid JSON body.'); }
}
export function authorized(req: IncomingMessage, expectedOrigin: string, token: string): boolean {
  if (req.headers.host !== new URL(expectedOrigin).host) return false;
  if (req.headers.origin && req.headers.origin !== expectedOrigin) return false;
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return false;
  const auth = req.headers.authorization;
  const expected = Buffer.from('Bearer ' + token);
  const provided = Buffer.from(typeof auth === 'string' ? auth : '');
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
export async function createApp(roots?: string[]) {
  const sources = new Sources(roots);
  await sources.initialize();
  const sessions = new Sessions(sources);
  const t3 = new T3Catalog();
  const links = new T3Links(t3, sources);
  const token = randomBytes(32).toString('base64url');
  let origin = '';
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const controller = new AbortController();
    req.on('aborted', () => controller.abort());
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      if (!origin || req.headers.host !== new URL(origin).host || req.headers.origin && req.headers.origin !== origin) {
        throw new DataError('forbidden', 'Unexpected host or origin.', 403);
      }
      const url = new URL(req.url ?? '/', origin);
      if (url.pathname.startsWith('/api/')) {
        if (!authorized(req, origin, token)) throw new DataError('unauthorized', 'Use the access link printed by this app launch.', 401);
        if (url.pathname === '/api/sources' && req.method === 'GET') {
          const family = url.searchParams.get('family');
          if (family !== null && family !== 'claude' && family !== 'codex') throw new DataError('invalid-request', 'Invalid source family.');
          return send(res, 200, { ok: true, data: await sources.list(url.searchParams.get('cursor') ?? undefined, controller.signal, family ?? undefined) });
        }
        if (url.pathname === '/api/t3/threads' && req.method === 'GET') {
          return send(res, 200, { ok: true, data: await t3.list(url.searchParams.get('cursor') ?? undefined) });
        }
        const evidence = /^\/api\/t3\/evidence\/([0-9a-f-]{36})$/.exec(url.pathname);
        if (evidence && req.method === 'GET') return send(res, 200, { ok: true, data: await t3.evidence(evidence[1]!) });
        const t3Thread = /^\/api\/t3\/threads\/([0-9a-f-]{36})\/(resolve|open)$/.exec(url.pathname);
        if (t3Thread && req.method === 'POST') {
          if (t3Thread[2] === 'resolve') return send(res, 200, { ok: true, data: await links.resolve(t3Thread[1]!, controller.signal) });
          const body = await readBody(req);
          const match = await links.validate(t3Thread[1]!, string(body.resolutionId) ?? '', string(body.matchId) ?? '', controller.signal);
          const session = await sessions.open(match.path, controller.signal, match.identity);
          return send(res, 202, { ok: true, data: { id: session.id, identity: session.linkedIdentity } });
        }
        if (url.pathname === '/api/sessions/open' && req.method === 'POST') {
          const body = await readBody(req);
          const sourceId = string(body.sourceId);
          const path = sourceId ? sources.candidates.get(sourceId)?.path : string(body.path);
          if (!path) throw new DataError('unsupported-path', 'Choose a listed source or enter its absolute JSONL path.');
          const session = await sessions.open(path, controller.signal);
          return send(res, 202, { ok: true, data: { id: session.id } });
        }
        const match = /^\/api\/sessions\/([0-9a-f-]+)\/(overview|ledger|cancel|records(?:\/r\d+)?)$/.exec(url.pathname);
        if (!match || !uuid.test(match[1] ?? '')) throw new DataError('not-found', 'API route unavailable.', 404);
        const session = sessions.get(match[1]!);
        const route = match[2]!;
        if (route === 'overview' && req.method === 'GET') return send(res, 200, { ok: true, data: session.overview() });
        if (route === 'cancel' && req.method === 'POST') {
          session.controller.abort();
          return send(res, 200, { ok: true, data: { cancelled: true } });
        }
        if (route === 'ledger' && req.method === 'GET') {
          const start = Number(url.searchParams.get('after') ?? 0);
          if (!Number.isSafeInteger(start) || start < 0) throw new DataError('invalid-cursor', 'Invalid ledger cursor.');
          const records = [...session.records.values()].filter(record => record.ref.line > start).slice(0, 50);
          const last = records.at(-1)?.ref.line;
          return send(res, 200, { ok: true, data: { records, after: last && last < session.records.size ? last : undefined } });
        }
        if (route.startsWith('records/') && req.method === 'GET') {
          const refId = route.slice('records/'.length);
          const pointer = url.searchParams.get('pointer') ?? undefined;
          const offset = Number(url.searchParams.get('offset') ?? 0);
          const view = await session.record(refId, pointer, offset, controller.signal);
          return send(res, 200, { ok: true, data: view });
        }
        throw new DataError('not-found', 'Method or route unavailable.', 404);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new DataError('not-found', 'Method unavailable.', 404);
      const pathname = decodeURIComponent(url.pathname);
      if (pathname !== '/' && !/^\/assets\/[a-zA-Z0-9._-]+$/.test(pathname)) throw new DataError('not-found', 'Asset unavailable.', 404);
      const file = resolve(uiRoot, pathname === '/' ? 'index.html' : '.' + pathname);
      if (!within(uiRoot, file)) throw new DataError('forbidden', 'Invalid asset path.', 403);
      const ext = file.slice(file.lastIndexOf('.'));
      if (!STATIC_TYPES[ext]) throw new DataError('not-found', 'Asset unavailable.', 404);
      let bytes: Buffer;
      try { bytes = await readFile(file); }
      catch { throw new DataError('not-found', 'Build the application before starting it.', 404); }
      res.writeHead(200, { 'Content-Type': STATIC_TYPES[ext], 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const known = error instanceof DataError;
      send(res, known ? error.status : 500, { ok: false, error: {
        code: known ? error.code : 'read-failed',
        message: known ? error.message : 'Unable to read the source. It may have changed or become unavailable.',
      } });
    }
  });
  server.requestTimeout = 30_000;
  return { server, sources, sessions, token, setOrigin: (value: string) => { origin = value; } };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const extraRoots: string[] = [];
  let port = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') {
      port = Number(args[++i]);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid --port.');
    } else if (args[i] === '--root' && args[i + 1]) extraRoots.push(resolve(args[++i]!));
    else throw new Error('Usage: npm start -- [--port 0] [--root absolute-path]');
  }
  const app = await createApp(extraRoots.length ? extraRoots : undefined);
  app.server.listen(port, '127.0.0.1', () => {
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener address.');
    const origin = 'http://127.0.0.1:' + address.port;
    app.setOrigin(origin);
    // Deliberate terminal bootstrap; the token never enters access logs.
    process.stdout.write('Session Context Debugger\nOpen this local access link:\n' + origin + '/#access=' + app.token + '\n');
  });
  app.server.on('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
  const stop = (): void => {
    for (const session of app.sessions.entries.values()) session.controller.abort();
    app.server.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
}
