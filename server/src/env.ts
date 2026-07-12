export interface Env {
  CAPTAIN: DurableObjectNamespace;
  SYSTEM: DurableObjectNamespace;
  ENCOUNTER: DurableObjectNamespace;
  WORLD: DurableObjectNamespace;
  DB: D1Database;
  ASSETS: Fetcher;
  ENVIRONMENT?: string;
  ALLOW_ADMIN?: string;
  SESSION_SECRET?: string;
}
