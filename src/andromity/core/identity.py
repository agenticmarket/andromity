"""Who is at this machine, as git and the operating system report it. Local and unverified."""
from __future__ import annotations

import getpass
import hashlib
import re
import subprocess
from typing import Any, Dict, Optional

MAX_FIELD_CHARS = 200
_ID = re.compile(r"[0-9a-f]{16}")


def local_identity(project_path: Optional[str] = None) -> Dict[str, str]:
    """git user.name and user.email as git resolves them for the project, plus the OS account name."""
    identity: Dict[str, str] = {}
    for key, field in (("user.name", "name"), ("user.email", "email")):
        try:
            result = subprocess.run(["git", "config", "--get", key], cwd=project_path or None, capture_output=True,
                                    text=True, encoding="utf-8", errors="replace", timeout=5,
                                    stdin=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError, ValueError):
            continue
        value = result.stdout.strip()
        if result.returncode == 0 and value:
            identity[field] = value[:MAX_FIELD_CHARS]
    try:
        user = getpass.getuser()
    except Exception:
        user = ""
    if user:
        identity["os_user"] = user[:MAX_FIELD_CHARS]
    return identity


def identity_id(identity: Optional[Dict[str, Any]]) -> Optional[str]:
    """A short pseudonymous id, so a receipt can say "(you)" without storing an email address."""
    if not isinstance(identity, dict):
        return None
    email = identity.get("email")
    if isinstance(email, str) and email.strip():
        basis = "email:" + email.strip().lower()
    else:
        name = identity.get("name") if isinstance(identity.get("name"), str) else ""
        user = identity.get("os_user") if isinstance(identity.get("os_user"), str) else ""
        if not name.strip() and not user.strip():
            return None
        basis = f"name:{name.strip()}|os:{user.strip()}"
    return hashlib.sha256(basis.encode("utf-8", errors="surrogatepass")).hexdigest()[:16]


def approver_record(identity: Optional[Dict[str, Any]]) -> Dict[str, str]:
    """What a decision keeps about the person: name, OS account and pseudonymous id. Never the email."""
    if not isinstance(identity, dict):
        return {}
    record = {field: str(identity[field])[:MAX_FIELD_CHARS] for field in ("name", "os_user")
              if isinstance(identity.get(field), str) and identity[field].strip()}
    person = identity_id(identity)
    if person:
        record["id"] = person
    return record


def valid_approver(decision: Dict[str, Any]) -> Dict[str, str]:
    """The approver fields of a stored decision that are well formed; anything else is dropped."""
    fields = {field: decision[field][:MAX_FIELD_CHARS] for field in ("name", "os_user")
              if isinstance(decision.get(field), str) and decision[field].strip()}
    if isinstance(decision.get("id"), str) and _ID.fullmatch(decision["id"]):
        fields["id"] = decision["id"]
    return fields
