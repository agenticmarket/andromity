"""Catalog of official remote MCP servers that connect with an OAuth sign-in or an access token."""
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Tuple

from andromity.config import config

GOOGLE_CLIENT_SETUP_URL = "https://console.cloud.google.com/apis/credentials"
# Google issues refresh tokens only for offline access with explicit consent.
_GOOGLE_AUTH_PARAMS = {"access_type": "offline", "prompt": "consent"}


@dataclass(frozen=True)
class Connector:
    id: str
    name: str
    category: str
    url: str
    description: str
    # Servers without dynamic client registration need the user's own OAuth client.
    needs_client: bool = False
    # Where the user creates their OAuth client or access token.
    setup_url: str = ""
    authorization_params: Dict[str, str] = field(default_factory=dict)
    # "oauth" signs in through the browser; "token" sends a pasted access token.
    auth: str = "oauth"
    token_prefix: str = "Bearer "
    # Read-only endpoint that checks the token, for servers that accept any token at initialize.
    verify_url: str = ""


def _google(cid: str, name: str, url: str, description: str) -> Connector:
    return Connector(cid, name, "Google", url, description, True, GOOGLE_CLIENT_SETUP_URL, _GOOGLE_AUTH_PARAMS)


def _token(cid: str, name: str, category: str, url: str, description: str, setup_url: str,
           token_prefix: str = "Bearer ", verify_url: str = "") -> Connector:
    return Connector(cid, name, category, url, description, setup_url=setup_url, auth="token",
                     token_prefix=token_prefix, verify_url=verify_url)


CATALOG: Tuple[Connector, ...] = (
    _google("gmail", "Gmail", "https://gmailmcp.googleapis.com/mcp/v1", "Read, search, and draft email."),
    _google("google-calendar", "Google Calendar", "https://calendarmcp.googleapis.com/mcp/v1", "View and manage calendar events."),
    _google("google-drive", "Google Drive", "https://drivemcp.googleapis.com/mcp/v1", "Search and read Drive files."),
    Connector("notion", "Notion", "Productivity", "https://mcp.notion.com/mcp", "Search and edit pages and databases."),
    Connector("atlassian", "Jira & Confluence", "Productivity", "https://mcp.atlassian.com/v1/mcp", "Issues, projects, and wiki pages."),
    Connector("linear", "Linear", "Productivity", "https://mcp.linear.app/mcp", "Issues, projects, and cycles."),
    Connector("clickup", "ClickUp", "Productivity", "https://mcp.clickup.com/mcp", "Tasks, lists, and docs."),
    Connector("monday", "monday.com", "Productivity", "https://mcp.monday.com/mcp", "Boards, items, and updates."),
    Connector("todoist", "Todoist", "Productivity", "https://ai.todoist.net/mcp", "Tasks and projects."),
    Connector("basecamp", "Basecamp", "Productivity", "https://mcp.basecamp.com/mcp", "Projects, to-dos, and messages."),
    Connector("calcom", "Cal.com", "Productivity", "https://mcp.cal.com/mcp", "Bookings and availability."),
    _token("airtable", "Airtable", "Productivity", "https://mcp.airtable.com/mcp", "Bases, tables, and records.",
           "https://airtable.com/create/tokens"),
    Connector("miro", "Miro", "Productivity", "https://mcp.miro.com/", "Boards and diagrams."),
    Connector("granola", "Granola", "Productivity", "https://mcp.granola.ai/mcp", "Meeting notes."),
    Connector("dropbox", "Dropbox", "Productivity", "https://mcp.dropbox.com/mcp", "Search and read files."),
    Connector("zapier", "Zapier", "Productivity", "https://mcp.zapier.com/api/mcp/mcp", "Run actions across your Zapier apps."),
    Connector("canva", "Canva", "Design & content", "https://mcp.canva.com/mcp", "Search and create designs."),
    Connector("webflow", "Webflow", "Design & content", "https://mcp.webflow.com/mcp", "Sites, pages, and CMS content."),
    Connector("wix", "Wix", "Design & content", "https://mcp.wix.com/mcp", "Sites and business data."),
    Connector("contentful", "Contentful", "Design & content", "https://mcp.contentful.com/mcp", "Content types and entries."),
    Connector("sanity", "Sanity", "Design & content", "https://mcp.sanity.io", "Documents, schemas, and datasets."),
    Connector("intercom", "Intercom", "Sales & support", "https://mcp.intercom.com/mcp", "Conversations and contacts."),
    Connector("attio", "Attio", "Sales & support", "https://mcp.attio.com/mcp", "CRM records, lists, and notes."),
    Connector("close", "Close", "Sales & support", "https://mcp.close.com/mcp", "Leads, contacts, and activities."),
    _token("github", "GitHub", "Developer", "https://api.githubcopilot.com/mcp/", "Repositories, issues, and pull requests.",
           "https://github.com/settings/personal-access-tokens/new"),
    Connector("gitlab", "GitLab", "Developer", "https://gitlab.com/api/v4/mcp", "Projects, issues, and merge requests."),
    Connector("sentry", "Sentry", "Developer", "https://mcp.sentry.dev/mcp", "Errors, issues, and releases."),
    Connector("vercel", "Vercel", "Developer", "https://mcp.vercel.com", "Projects, deployments, and logs."),
    Connector("netlify", "Netlify", "Developer", "https://mcp.netlify.com/mcp", "Sites, deploys, and functions."),
    Connector("railway", "Railway", "Developer", "https://mcp.railway.com/mcp", "Projects, services, and deployments."),
    _token("render", "Render", "Developer", "https://mcp.render.com/mcp", "Services, deploys, and logs.",
           "https://render.com/docs/mcp-server", verify_url="https://api.render.com/v1/owners?limit=1"),
    Connector("cloudflare", "Cloudflare Workers", "Developer", "https://bindings.mcp.cloudflare.com/mcp", "Workers, KV, R2, and D1."),
    Connector("cloudflare-builds", "Cloudflare Builds", "Developer", "https://builds.mcp.cloudflare.com/mcp", "Workers build history and logs."),
    Connector("supabase", "Supabase", "Developer", "https://mcp.supabase.com/mcp", "Projects, databases, and functions."),
    Connector("neon", "Neon", "Developer", "https://mcp.neon.tech/mcp", "Serverless Postgres projects and branches."),
    Connector("prisma", "Prisma Postgres", "Developer", "https://mcp.prisma.io/mcp", "Databases and backups."),
    Connector("upstash", "Upstash", "Developer", "https://mcp.upstash.com/mcp", "Redis and QStash databases."),
    Connector("postman", "Postman", "Developer", "https://mcp.postman.com/mcp", "Collections, APIs, and workspaces."),
    Connector("buildkite", "Buildkite", "Developer", "https://mcp.buildkite.com/mcp", "Pipelines and builds."),
    Connector("socket", "Socket", "Developer", "https://mcp.socket.dev/", "Dependency security scores."),
    Connector("huggingface", "Hugging Face", "Developer", "https://huggingface.co/mcp", "Models, datasets, and Spaces."),
    Connector("jam", "Jam", "Developer", "https://mcp.jam.dev/mcp", "Bug reports with logs and replays."),
    Connector("exa", "Exa", "Developer", "https://mcp.exa.ai/mcp", "Web and code search."),
    Connector("apify", "Apify", "Developer", "https://mcp.apify.com", "Web scrapers and data extraction."),
    Connector("globalping", "Globalping", "Developer", "https://mcp.globalping.dev/mcp", "Ping, traceroute, and DNS from probes worldwide."),
    _token("pagerduty", "PagerDuty", "Monitoring", "https://mcp.pagerduty.com/mcp", "Incidents, services, and on-call.",
           "https://docs.pagerduty.com/developer/mcp-tooling-remote-server", token_prefix="Token token="),
    Connector("grafana", "Grafana", "Monitoring", "https://mcp.grafana.com/mcp", "Dashboards, metrics, and alerts."),
    Connector("honeycomb", "Honeycomb", "Monitoring", "https://mcp.honeycomb.io/mcp", "Traces and queries."),
    Connector("axiom", "Axiom", "Monitoring", "https://mcp.axiom.co/mcp", "Logs and queries."),
    Connector("cloudflare-observability", "Cloudflare Observability", "Monitoring", "https://observability.mcp.cloudflare.com/mcp",
              "Workers logs and analytics."),
    Connector("posthog", "PostHog", "Analytics", "https://mcp.posthog.com/mcp", "Product analytics and feature flags."),
    Connector("amplitude", "Amplitude", "Analytics", "https://mcp.amplitude.com/mcp", "Charts, events, and experiments."),
    Connector("mixpanel", "Mixpanel", "Analytics", "https://mcp.mixpanel.com/mcp", "Events, reports, and funnels."),
    Connector("stripe", "Stripe", "Payments", "https://mcp.stripe.com", "Customers, payments, and invoices."),
    Connector("paypal", "PayPal", "Payments", "https://mcp.paypal.com/mcp", "Orders, invoices, and disputes."),
    Connector("square", "Square", "Payments", "https://mcp.squareup.com/sse", "Payments, catalog, and orders."),
    Connector("plaid", "Plaid", "Payments", "https://mcp.plaid.com/mcp", "Integration diagnostics and usage."),
)

_BY_ID: Dict[str, Connector] = {c.id: c for c in CATALOG}


def get_connector(connector_id: str) -> Optional[Connector]:
    return _BY_ID.get(connector_id)


def configured_servers(project_path: str) -> Dict[str, dict]:
    from andromity.core.mcp import MCPClientManager
    return MCPClientManager(project_path).load_config().get("mcpServers", {})


def list_connectors(project_path: str) -> List[dict]:
    """Catalog entries with a `connected` flag for servers already in mcp.json."""
    servers = configured_servers(project_path)
    return [{
        "id": c.id, "name": c.name, "category": c.category, "url": c.url,
        "description": c.description, "needs_client": c.needs_client,
        "setup_url": c.setup_url, "auth": c.auth, "connected": c.id in servers,
    } for c in CATALOG]


def build_config(connector: Connector, client_id: str = "", client_secret: str = "") -> dict:
    conf: dict = {"serverUrl": connector.url, "connector": connector.id}
    if connector.auth == "token":
        if connector.token_prefix != "Bearer ":
            conf["token_prefix"] = connector.token_prefix
        return conf
    oauth: dict = {}
    if client_id:
        oauth["client_id"] = client_id
    if client_secret:
        oauth["client_secret"] = client_secret
    if connector.authorization_params:
        oauth["authorization_params"] = dict(connector.authorization_params)
    if oauth:
        conf["oauth"] = oauth
    return conf


async def authenticate(name: str, conf: dict, on_status: Callable[[str], None]) -> Optional[str]:
    """Run the OAuth flow for a configured remote server using its saved client settings."""
    from andromity.core.oauth import full_oauth_flow
    oauth = conf.get("oauth") if isinstance(conf.get("oauth"), dict) else {}
    params = oauth.get("authorization_params")
    return await full_oauth_flow(
        name, conf.get("serverUrl") or conf.get("url") or "", on_status,
        client_id=oauth.get("client_id"), client_secret=oauth.get("client_secret"),
        authorization_params=params if isinstance(params, dict) else None)


async def verify_token(connector: Connector, token: str) -> Optional[str]:
    """Return None when the server accepts the token, else a message for the user."""
    import httpx
    body = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "andromity", "version": "1"}}}
    headers = {"Authorization": f"{connector.token_prefix}{token}", "Accept": "application/json, text/event-stream"}
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            if connector.verify_url:
                response = await client.get(connector.verify_url, headers={"Authorization": headers["Authorization"]})
            else:
                async with client.stream("POST", connector.url, json=body, headers=headers) as response:
                    pass
            status = response.status_code
            challenge = response.headers.get("www-authenticate", "")
    except httpx.HTTPError:
        return f"Could not reach {connector.name}. Check your network and retry."
    if status in (401, 403) or "invalid_token" in challenge:
        return f"{connector.name} rejected the token. Check that it is current and has the access you need."
    if status >= 400:
        return f"{connector.name} returned HTTP {status}. Retry in a moment."
    return None


async def connect(connector_id: str, project_path: str, on_status: Callable[[str], None],
                  client_id: str = "", client_secret: str = "", access_token: str = "") -> Tuple[bool, str]:
    """Sign in to a catalog connector, then save it to the user-level mcp.json.

    Nothing is written when sign-in fails or the token is rejected, so a
    cancelled login leaves no half-configured server behind."""
    from andromity.core.oauth import clear_token, store_token
    connector = get_connector(connector_id)
    if connector is None:
        return False, "Unknown connector. Refresh the connector list and retry."
    if connector.id in configured_servers(project_path):
        return False, f"{connector.name} is already connected. Remove it from MCP servers to reconnect."
    client_id, client_secret = (client_id or "").strip(), (client_secret or "").strip()
    access_token = (access_token or "").strip()
    conf = build_config(connector, client_id, client_secret)

    if connector.auth == "token":
        if not access_token:
            return False, f"{connector.name} needs an access token. Create one at {connector.setup_url}."
        on_status(f"Checking the token with {connector.name}…")
        problem = await verify_token(connector, access_token)
        if problem:
            return False, problem
        store_token(connector.id, {"access_token": access_token}, "", "", connector.url)
    else:
        if connector.needs_client and not (client_id and client_secret):
            return False, f"{connector.name} needs your own OAuth client ID and secret. Create a Desktop app client at {connector.setup_url}."
        progress: List[str] = []

        def _status(msg: str) -> None:
            progress.append(msg)
            on_status(msg)

        if not await authenticate(connector.id, conf, _status):
            return False, progress[-1] if progress else "Sign-in failed. Retry the connection."

    if not config.add_user_mcp_server(connector.id, conf):
        clear_token(connector.id)
        return False, "Could not save the connector to ~/.andromity/mcp.json. Check folder permissions."
    return True, f"{connector.name} connected."
