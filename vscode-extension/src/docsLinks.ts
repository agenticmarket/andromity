/** Website documentation pages linked from the extension's UI. */
export const SITE_BASE = "https://andromity.agenticmarket.dev";
export const DOCS_BASE = `${SITE_BASE}/docs`;
/** Hub of app connector setup guides; each guide lives at `${INTEGRATIONS_URL}/<slug>`. */
export const INTEGRATIONS_URL = `${SITE_BASE}/integrations`;

export const DOCS = {
  apiKeys: `${DOCS_BASE}/api-keys`,
  customProviders: `${DOCS_BASE}/guides/custom-providers`,
  modelHub: `${DOCS_BASE}/model-hub`,
  security: `${DOCS_BASE}/security`,
  permissionModes: `${DOCS_BASE}/permission-modes`,
  profiles: `${DOCS_BASE}/profiles`,
  skills: `${DOCS_BASE}/skills`,
  mcp: `${DOCS_BASE}/mcp`,
  preferences: `${DOCS_BASE}/preferences`,
  personalisation: `${DOCS_BASE}/personalisation`,
  configuration: `${DOCS_BASE}/configuration`,
  waterfall: `${DOCS_BASE}/waterfall`,
  fingerprint: `${DOCS_BASE}/fingerprint`,
  cron: `${DOCS_BASE}/cron`,
} as const;
