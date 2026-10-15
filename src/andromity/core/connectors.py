"""Catalog of official remote MCP servers that connect with a single OAuth sign-in."""
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
    setup_url: str = ""
    authorization_params: Dict[str, str] = field(default_factory=dict)


CATALOG: Tuple[Connector, ...] = (
    Connector("gmail", "Gmail", "Google", "https://gmailmcp.googleapis.com/mcp/v1",
              "Read, search, and draft email.", True, GOOGLE_CLIENT_SETUP_URL, _GOOGLE_AUTH_PARAMS),
    Connector("google-calendar", "Google Calendar", "Google", "https://calendarmcp.googleapis.com/mcp/v1",
              "View and manage calendar events.", True, GOOGLE_CLIENT_SETUP_URL, _GOOGLE_AUTH_PARAMS),
    Connector("google-drive", "Google Drive", "Google", "https://drivemcp.googleapis.com/mcp/v1",
              "Search and read Drive files.", True, GOOGLE_CLIENT_SETUP_URL, _GOOGLE_AUTH_PARAMS),
    Connector("notion", "Notion", "Productivity", "https://mcp.notion.com/mcp", "Search and edit pages and databases."),
    Connector("atlassian", "Jira & Confluence", "Productivity", "https://mcp.atlassian.com/v1/mcp", "Issues, projects, and wiki pages."),
    Connector("linear", "Linear", "Productivity", "https://mcp.linear.app/mcp", "Issues, projects, and cycles."),
    Connector("clickup", "ClickUp", "Productivity", "https://mcp.clickup.com/mcp", "Tasks, lists, and docs."),
    Connector("monday", "monday.com", "Productivity", "https://mcp.monday.com/mcp", "Boards, items, and updates."),
    Connector("miro", "Miro", "Productivity", "https://mcp.miro.com/", "Boards and diagrams."),
    Connector("granola", "Granola", "Productivity", "https://mcp.granola.ai/mcp", "Meeting notes."),
    Connector("dropbox", "Dropbox", "Productivity", "https://mcp.dropbox.com/mcp", "Search and read files."),
    Connector("zapier", "Zapier", "Productivity", "https://mcp.zapier.com/api/mcp/mcp", "Run actions across your Zapier apps."),
    Connector("canva", "Canva", "Design", "https://mcp.canva.com/mcp", "Search and create designs."),
    Connector("webflow", "Webflow", "Design", "https://mcp.webflow.com/mcp", "Sites, pages, and CMS content."),
    Connector("wix", "Wix", "Design", "https://mcp.wix.com/mcp", "Sites and business data."),
    Connector("intercom", "Intercom", "Support", "https://mcp.intercom.com/mcp", "Conversations and contacts."),
    Connector("sentry", "Sentry", "Developer", "https://mcp.sentry.dev/mcp", "Errors, issues, and releases."),
    Connector("gitlab", "GitLab", "Developer", "https://gitlab.com/api/v4/mcp", "Projects, issues, and merge requests."),
    Connector("vercel", "Vercel", "Developer", "https://mcp.vercel.com", "Projects, deployments, and logs."),
    Connector("supabase", "Supabase", "Developer", "https://mcp.supabase.com/mcp", "Projects, databases, and functions."),
    Connector("neon", "Neon", "Developer", "https://mcp.neon.tech/mcp", "Serverless Postgres projects and branches."),
    Connector("prisma", "Prisma Postgres", "Developer", "https://mcp.prisma.io/mcp", "Databases and backups."),
    Connector("cloudflare", "Cloudflare", "Developer", "https://bindings.mcp.cloudflare.com/mcp", "Workers, KV, R2, and D1."),
    Connector("posthog", "PostHog", "Developer", "https://mcp.posthog.com/mcp", "Product analytics and feature flags."),
    Connector("huggingface", "Hugging Face", "Developer", "https://huggingface.co/mcp", "Models, datasets, and Spaces."),
    Connector("jam", "Jam", "Developer", "https://mcp.jam.dev/mcp", "Bug reports with logs and replays."),
    Connector("stripe", "Stripe", "Payments", "https://mcp.stripe.com", "Customers, payments, and invoices."),
    Connector("paypal", "PayPal", "Payments", "https://mcp.paypal.com/mcp", "Orders, invoices, and disputes."),
    Connector("square", "Square", "Payments", "https://mcp.squareup.com/sse", "Payments, catalog, and orders."),
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
        "setup_url": c.setup_url, "connected": c.id in servers,
    } for c in CATALOG]


def build_config(connector: Connector, client_id: str = "", client_secret: str = "") -> dict:
    conf: dict = {"serverUrl": connector.url, "connector": connector.id}
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


async def connect(connector_id: str, project_path: str, on_status: Callable[[str], None],
                  client_id: str = "", client_secret: str = "") -> Tuple[bool, str]:
    """Sign in to a catalog connector, then save it to the user-level mcp.json.

    Nothing is written when sign-in fails, so a cancelled browser login leaves
    no half-configured server behind."""
    connector = get_connector(connector_id)
    if connector is None:
        return False, "Unknown connector. Refresh the connector list and retry."
    if connector.id in configured_servers(project_path):
        return False, f"{connector.name} is already connected. Remove it from MCP servers to reconnect."
    client_id, client_secret = (client_id or "").strip(), (client_secret or "").strip()
    if connector.needs_client and not (client_id and client_secret):
        return False, f"{connector.name} needs your own OAuth client ID and secret. Create a Desktop app client at {connector.setup_url}."
    conf = build_config(connector, client_id, client_secret)
    progress: List[str] = []

    def _status(msg: str) -> None:
        progress.append(msg)
        on_status(msg)

    token = await authenticate(connector.id, conf, _status)
    if not token:
        return False, progress[-1] if progress else "Sign-in failed. Retry the connection."
    if not config.add_user_mcp_server(connector.id, conf):
        from andromity.core.oauth import clear_token
        clear_token(connector.id)
        return False, "Could not save the connector to ~/.andromity/mcp.json. Check folder permissions."
    return True, f"{connector.name} connected."
