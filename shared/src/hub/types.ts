/**
 * Hub UI public types — moved to @metabot/shared so the cloud server (which
 * aggregates instances over WS) can use the exact same shape the local
 * manager already serves.
 *
 * These types are deliberately narrow: no secrets, no env, no internal
 * process metadata beyond what the Hub card already shows.
 */

export interface HubBot {
  name:               string;
  status:             'online' | 'stopped' | 'launching' | 'error' | 'unknown';
  uptimeMs?:          number;
  cpu?:               number;
  memMb?:             number;
  restarts?:          number;
  sessions?:          number;
  workdir?:           string;
  hiddenFields:       string[];
  transcriptBaseUrl?: string;
}

export interface HubHost {
  hostId:         string;
  hostName:       string;
  online:         true;     // Phase 1 single-machine — always true if we answer
  lastSeen:       string;
  agentVersion:   string;
  os:             string;
  visibleBots:    HubBot[];
  hiddenBotCount: number;
}

/**
 * Minimal pm2 procinfo subset the aggregator needs. Mirrors the public fields
 * of `src/manager/pm2-control.ts:Pm2ProcInfo` but without env / log paths so
 * shared callers don't need to drag in pm2 types.
 */
export interface HubProcInfo {
  name:         string;
  status:       string;
  uptimeMs?:    number;
  cpu?:         number;
  memoryBytes?: number;
  restarts?:    number;
}

/**
 * Minimal bot config subset the aggregator needs. Matches the subset of
 * `BotJsonEntry` that's safe to feed into the Hub.
 */
export interface HubBotInput {
  name:                     string;
  hubVisible?:              boolean;
  publicBaseUrl?:           string;
  defaultWorkingDirectory?: string;
  accessAllowOpenIds?:      string[];
  transcriptAllowOpenIds?:  string[];
}
