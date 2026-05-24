/**
 * Cloud Hub UI API — `/api/hub/instances`.
 *
 * Read-only JSON over the cloud `InstanceRegistry`. Same shape as the local
 * manager's Hub endpoints (`src/api/routes/hub-routes.ts`) so that the
 * placeholder under `cloud/static/hub/index.html` can render a real,
 * cross-instance bot list without the operator needing to ssh into the relay.
 *
 * Auth model mirrors the transcript route: `requireFeishuAuth` cookie check,
 * `allowOpenIds` is the union of every `hubVisible: true` bot's
 * `accessAllowOpenIds` across every connected instance. Sensitive fields
 * (`feishuAppSecret`, `feishuAppId`, full `accessAllowOpenIds` list of other
 * users) are stripped from the response.
 *
 * 401 carries a `loginUrl` so the SPA can redirect to the cloud's own
 * `/api/auth/feishu/{login,callback}` flow — we pick the first hubVisible bot
 * that shipped its Feishu credentials as the login authority. Any of that
 * bot's allow-listed users can complete OAuth; the final allow-list check
 * runs again here on `/api/hub/instances` against the union set, so a user
 * who logs in via bot A but isn't in any hubVisible bot's whitelist still
 * gets a 403.
 */
import type { Express, Request, Response } from 'express';
import type { BotMeta } from '@metabot/shared';
import type { InstanceRegistry, InstanceRecord } from '../ws/instance-registry.js';
import { requireFeishuAuth } from '../auth/require-feishu-auth.js';

export interface HubRoutesOptions {
  registry: InstanceRegistry;
  sessionSecret: string;
  /** Bypass `requireFeishuAuth` (cloudflared anonymous tunnel grey-launch only). */
  disableAuth?: boolean;
  logger?: (msg: string) => void;
}

interface HubBotView {
  name: string;
  hubVisible: boolean;
  chatIdCount: number;
  chatIds: string[];
  /** Browser composes the full URL by prefixing the cloud origin. */
  transcriptUrlBase: string;
  allowOpenIdCount: number;
  hasFeishuCreds: boolean;
}

interface HubInstanceView {
  instanceId: string;
  version: string;
  registeredAt: number;
  lastSeen: number;
  hubVisibleBotCount: number;
  hiddenBotCount: number;
  bots: HubBotView[];
}

interface HubResponse {
  hostId: string;
  totalInstances: number;
  totalHubVisibleBots: number;
  totalHiddenBots: number;
  instances: HubInstanceView[];
  user: { openId: string; name: string } | null;
}

function projectBot(bot: BotMeta, instanceId: string): HubBotView {
  return {
    name:              bot.name,
    hubVisible:        bot.hubVisible,
    chatIdCount:       bot.chatIds?.length ?? 0,
    chatIds:           bot.chatIds ?? [],
    transcriptUrlBase: `/i/${instanceId}/web/transcript/`,
    allowOpenIdCount:  bot.accessAllowOpenIds?.length ?? 0,
    hasFeishuCreds:    Boolean(bot.feishuAppId && bot.feishuAppSecret),
  };
}

function projectInstance(rec: InstanceRecord): HubInstanceView {
  const visible = rec.bots.filter((b) => b.hubVisible);
  const hidden  = rec.bots.length - visible.length;
  return {
    instanceId:         rec.instanceId,
    version:            rec.version,
    registeredAt:       rec.registeredAt,
    lastSeen:           rec.lastSeen,
    hubVisibleBotCount: visible.length,
    hiddenBotCount:     hidden,
    bots:               visible.map((b) => projectBot(b, rec.instanceId)),
  };
}

/** Union of every hubVisible bot's accessAllowOpenIds across every instance. */
function computeHubAllowOpenIds(records: InstanceRecord[]): string[] {
  const set = new Set<string>();
  for (const rec of records) {
    for (const bot of rec.bots) {
      if (!bot.hubVisible) continue;
      for (const id of bot.accessAllowOpenIds ?? []) set.add(id);
    }
  }
  return Array.from(set);
}

/** First hubVisible bot anywhere with feishu credentials — login authority. */
function pickLoginBot(
  records: InstanceRecord[],
): { instanceId: string; botName: string } | null {
  for (const rec of records) {
    for (const bot of rec.bots) {
      if (bot.hubVisible && bot.feishuAppId && bot.feishuAppSecret) {
        return { instanceId: rec.instanceId, botName: bot.name };
      }
    }
  }
  return null;
}

export function mountHubRoutes(app: Express, opts: HubRoutesOptions): void {
  const log = opts.logger ?? (() => {});

  app.get('/api/hub/instances', (req: Request, res: Response) => {
    const records      = opts.registry.list();
    const allowOpenIds = computeHubAllowOpenIds(records);

    let user: { openId: string; name: string } | null = null;

    if (!opts.disableAuth) {
      const returnPath = '/web/hub/';
      const loginBot   = pickLoginBot(records);
      if (!loginBot && allowOpenIds.length === 0 && records.length === 0) {
        // No instances connected at all — render the empty hub without auth so
        // the operator can at least see "cloud is up, nobody is connected".
      } else if (!loginBot) {
        // Instances are connected but none ship Feishu creds — we cannot mint a
        // session at all. Surface clearly.
        res.status(503).type('application/json').send(JSON.stringify({
          error: 'no hubVisible bot with Feishu credentials is connected',
        }));
        return;
      }

      if (loginBot) {
        const authResult = requireFeishuAuth(req, {
          allowOpenIds,
          returnPath,
          botName:       loginBot.botName,
          sessionSecret: opts.sessionSecret,
          instanceId:    loginBot.instanceId,
        });
        if (!authResult.ok) {
          if (authResult.status === 401) {
            res.status(401).type('application/json').send(JSON.stringify({
              error:    'login required',
              loginUrl: authResult.loginUrl,
            }));
          } else {
            res.status(403).type('application/json').send(JSON.stringify({
              error: 'not in hub whitelist',
            }));
          }
          return;
        }
        user = { openId: authResult.openId, name: authResult.name };
      }
    }

    const instances = records.map(projectInstance);
    const totalHubVisibleBots = instances.reduce((s, i) => s + i.hubVisibleBotCount, 0);
    const totalHiddenBots     = instances.reduce((s, i) => s + i.hiddenBotCount, 0);

    const body: HubResponse = {
      hostId: 'cloud:teamclaude',
      totalInstances: records.length,
      totalHubVisibleBots,
      totalHiddenBots,
      instances,
      user,
    };
    res.status(200).type('application/json').send(JSON.stringify(body));
    log(`hub: served ${records.length} instances to ${user?.openId ?? '(anon)'}`);
  });
}
