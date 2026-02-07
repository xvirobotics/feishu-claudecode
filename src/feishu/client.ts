import * as lark from '@larksuiteoapi/node-sdk';
import type { Config } from '../config.js';
import type { Logger } from '../utils/logger.js';

export interface FeishuClients {
  client: lark.Client;
  wsClient: lark.WSClient;
}

export function createFeishuClients(
  config: Config,
  logger: Logger,
): FeishuClients {
  const client = new lark.Client({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    disableTokenCache: false,
  });

  const wsClient = new lark.WSClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    loggerLevel: lark.LoggerLevel.info,
  });

  logger.info('Feishu clients initialized');

  return { client, wsClient };
}
