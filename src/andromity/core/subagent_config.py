from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from andromity.config import config


@dataclass
class SubAgentRoleConfig:
    name: str
    description: str
    tools: List[str]
    model: Optional[str] = None
    provider: Optional[str] = None
    system_prompt: Optional[str] = None
    temperature: Optional[float] = None


DEFAULT_SUBAGENT_ROLES: Dict[str, SubAgentRoleConfig] = {
    "search": SubAgentRoleConfig(
        name="search",
        description="Specialized researcher that gathers live information from web search and online documentation.",
        tools=["web_search", "fetch_url"],
        system_prompt="You are a fast research sub-agent. Your goal is to gather concise, accurate technical information and return a structured summary. Do not output conversational filler."
    ),
    "coder": SubAgentRoleConfig(
        name="coder",
        description="Specialized programmer that implements code changes, inspects symbols, and executes tests.",
        tools=["read_file", "grep_search", "find_files", "write_file", "edit_file", "edit_file_multi", "shell_exec", "list_dir"],
        system_prompt="You are a focused coding sub-agent. Inspect existing code before editing. Make clean, minimal, working changes and verify with tests when appropriate."
    ),
    "reviewer": SubAgentRoleConfig(
        name="reviewer",
        description="Specialized code reviewer that audits for edge cases, bugs, regressions, and security risks without modifying files.",
        tools=["read_file", "grep_search", "find_files", "list_dir"],
        system_prompt="You are a read-only code review sub-agent. Identify flaws, edge cases, type errors, or security risks. Return clear, line-referenced findings."
    ),
    "analyst": SubAgentRoleConfig(
        name="analyst",
        description="Specialized analyst that analyzes codebase architecture, dependencies, and requirements.",
        tools=["read_file", "grep_search", "find_files", "list_dir", "web_search", "fetch_url"],
        system_prompt=(
            "You are an architectural analyst sub-agent. Use tools to gather information, then write your findings "
            "as a clear prose summary in your final text response. "
            "You MUST end with a text message — never end your turn with a tool call. "
            "Synthesize codebase structure, data flow, and trade-offs into a compact, actionable report.\n\n"
            "[DIRECTORY BROWSING RULES]\n"
            "- Call list_dir on the ROOT directory ONCE to get the top-level layout.\n"
            "- Then call list_dir on AT MOST 2-3 key subdirectories (e.g. src/, app/) if needed for clarity.\n"
            "- Do NOT recursively list every subdirectory — this wastes time and tokens.\n"
            "- Read specific files (README, package.json, main config) to get details; do not explore blindly."
        )
    ),
    "general": SubAgentRoleConfig(
        name="general",
        description="General-purpose sub-agent for delegated tasks.",
        tools=["read_file", "grep_search", "find_files", "list_dir", "web_search", "fetch_url"],
        system_prompt="You are a dedicated task sub-agent. Complete the requested task efficiently and return a structured result summary."
    ),
}


class SubAgentConfigManager:
    """Manages role-to-model routing, concurrency limits, and sub-agent defaults."""

    @staticmethod
    def get_max_concurrent() -> int:
        return int(config.get("subagents", "max_concurrent", 5))

    @staticmethod
    def get_default_timeout() -> float:
        return float(config.get("subagents", "timeout_seconds", 180.0))

    @staticmethod
    def get_result_max_tokens() -> int:
        return int(config.get("subagents", "result_max_tokens", 750))

    @staticmethod
    def get_max_depth() -> int:
        return int(config.get("subagents", "max_depth", 2))

    @classmethod
    def get_role_config(cls, role_name: str) -> SubAgentRoleConfig:
        role_name_norm = role_name.lower().strip()
        custom_roles = config.get("subagents", "roles", [])
        for r in custom_roles:
            if isinstance(r, dict) and r.get("name", "").lower() == role_name_norm:
                base = DEFAULT_SUBAGENT_ROLES.get(role_name_norm)
                return SubAgentRoleConfig(
                    name=role_name_norm,
                    description=r.get("description", base.description if base else f"Custom role '{role_name_norm}'"),
                    tools=r.get("tools", base.tools if base else ["read_file", "grep_search", "find_files"]),
                    model=r.get("model", base.model if base else None),
                    provider=r.get("provider", base.provider if base else None),
                    system_prompt=r.get("system_prompt", base.system_prompt if base else None),
                    temperature=r.get("temperature", None),
                )
        if role_name_norm in DEFAULT_SUBAGENT_ROLES:
            return DEFAULT_SUBAGENT_ROLES[role_name_norm]
        
        # Fallback for dynamic/custom role
        return SubAgentRoleConfig(
            name=role_name_norm,
            description=f"Ad-hoc subagent role for '{role_name_norm}'",
            tools=["read_file", "grep_search", "find_files", "list_dir", "web_search", "fetch_url"],
            system_prompt=f"You are a specialized sub-agent for '{role_name_norm}'. Complete the assigned task directly and return a concise summary."
        )

    @classmethod
    def list_available_roles(cls) -> List[Dict[str, Any]]:
        roles = []
        for name, role_cfg in DEFAULT_SUBAGENT_ROLES.items():
            roles.append({
                "name": name,
                "description": role_cfg.description,
                "tools": role_cfg.tools,
                "model": role_cfg.model or "default",
                "provider": role_cfg.provider or "default",
            })
        return roles
