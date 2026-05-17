/**
 * central-admin CLI — issue/revoke/list credentials and read audit log.
 *
 * Auth flow:
 *   - CENTRAL_URL (default http://localhost:8200) + CENTRAL_ADMIN_TOKEN (env or --token)
 *   - All requests go through the admin HTTP endpoints, so the CLI works
 *     equally well against a remote central server.
 */
import * as http from 'node:http';
import * as https from 'node:https';
import * as url from 'node:url';

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

interface RequestResult {
  status: number;
  body: unknown;
}

function request(method: string, target: string, token: string, body?: unknown): Promise<RequestResult> {
  const parsed = url.parse(target);
  const isHttps = parsed.protocol === 'https:';
  const lib = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = lib.request({
      method,
      hostname: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port, 10) : (isHttps ? 443 : 80),
      path: parsed.path,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        Authorization: `Bearer ${token}`,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let parsedBody: unknown = text;
        try { parsedBody = JSON.parse(text); } catch { /* keep text */ }
        resolve({ status: res.statusCode || 0, body: parsedBody });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function usage(): never {
  console.error(`Usage:
  central-admin issue   --bot <name> --owner <name> [--role admin|member]
                        [--writable <ns,ns>] [--readable <ns,ns>]
                        [--publish-skill] [--notes <text>]
  central-admin revoke  --id <credentialId>
  central-admin list
  central-admin audit   --date YYYY-MM-DD [--principal <id>] [--op <op>]

Env:
  CENTRAL_URL          base URL (default http://localhost:8200)
  CENTRAL_ADMIN_TOKEN  admin bearer token
Flags override env: --url <url>, --token <token>
`);
  process.exit(2);
}

function csvList(value: string | boolean | undefined): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

async function run() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) usage();
  const args = parseArgs(argv);
  const cmd = args.positional[0];

  const base = (args.flags.url as string) || process.env.CENTRAL_URL || 'http://localhost:8200';
  const token = (args.flags.token as string) || process.env.CENTRAL_ADMIN_TOKEN || '';
  if (!token) {
    console.error('error: CENTRAL_ADMIN_TOKEN env or --token <token> required');
    process.exit(2);
  }

  if (cmd === 'issue') {
    const botName = args.flags.bot as string;
    const ownerName = args.flags.owner as string;
    const role = ((args.flags.role as string) || 'member') as 'admin' | 'member';
    if (!botName || !ownerName) usage();
    const body = {
      botName,
      ownerName,
      role,
      writableNamespaces: csvList(args.flags.writable),
      readableNamespaces: csvList(args.flags.readable),
      publishSkill: args.flags['publish-skill'] === true ? true : undefined,
      notes: typeof args.flags.notes === 'string' ? (args.flags.notes as string) : undefined,
    };
    const result = await request('POST', `${base}/admin/credentials/issue`, token, body);
    process.stdout.write(JSON.stringify(result.body, null, 2) + '\n');
    process.exit(result.status >= 200 && result.status < 300 ? 0 : 1);
  }

  if (cmd === 'revoke') {
    const credentialId = args.flags.id as string;
    if (!credentialId) usage();
    const result = await request('POST', `${base}/admin/credentials/revoke`, token, { credentialId });
    process.stdout.write(JSON.stringify(result.body, null, 2) + '\n');
    process.exit(result.status >= 200 && result.status < 300 ? 0 : 1);
  }

  if (cmd === 'list') {
    const result = await request('GET', `${base}/admin/credentials`, token);
    process.stdout.write(JSON.stringify(result.body, null, 2) + '\n');
    process.exit(result.status >= 200 && result.status < 300 ? 0 : 1);
  }

  if (cmd === 'audit') {
    const date = args.flags.date as string;
    if (!date) usage();
    const qs = new URLSearchParams({ date });
    if (typeof args.flags.principal === 'string') qs.set('principal', args.flags.principal as string);
    if (typeof args.flags.op === 'string') qs.set('op', args.flags.op as string);
    const result = await request('GET', `${base}/admin/audit?${qs.toString()}`, token);
    process.stdout.write(JSON.stringify(result.body, null, 2) + '\n');
    process.exit(result.status >= 200 && result.status < 300 ? 0 : 1);
  }

  usage();
}

run().catch((err) => {
  console.error('central-admin error:', err.message || err);
  process.exit(1);
});
