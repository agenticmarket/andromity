"""Web search and URL content fetching tools with safety guardrails."""
import gzip
import html
import json
import logging
import os
import random
import re
import socket
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from concurrent.futures import TimeoutError as FuturesTimeoutError
from typing import Any, Dict, List, Optional, Tuple

try:
    from bs4 import BeautifulSoup
except ImportError:
    BeautifulSoup = None

try:
    from markdownify import markdownify
except ImportError:
    markdownify = None

try:
    from ddgs import DDGS
except ImportError:
    DDGS = None

log = logging.getLogger("andromity.web")

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024

FETCH_TIMEOUT_S = 15
FETCH_ATTEMPTS = 2
BACKOFF_BASE_S = 0.5
_TRANSIENT_HTTP_CODES = {429, 500, 502, 503, 504}

SEARCH_BUDGET_S = 30.0
DDGS_BUDGET_S = 22.0
DDGS_HEDGE_AFTER_S = 7.0
FALLBACK_TIMEOUT_S = 6.0
MAX_SEARCH_RESULTS = 20
MAX_FETCH_TOP = 5
MAX_SNIPPET_CHARS = 400

# Each ddgs attempt is (backend, region, per-engine timeout). The first attempt keeps the library
# defaults; the retry skips the encyclopedia engines, which rarely match technical queries but take a
# worker slot, and searches worldwide so non-English queries are not pinned to the US index. The retry
# starts as soon as the first attempt fails, or in parallel once it has run for DDGS_HEDGE_AFTER_S.
_DDGS_ATTEMPTS: Tuple[Tuple[str, str, int], ...] = (
    ("auto", "us-en", 5),
    ("web", "wt-wt", 8),
)
_ENCYCLOPEDIA_BACKENDS = {"wikipedia", "grokipedia"}
_AD_URL_MARKERS = ("duckduckgo.com/y.js", "bing.com/aclick", "duckduckgo.com/l/?")
_BLOCK_PAGE_MARKERS = ("anomaly-modal", "challenge-form", "captcha", "unusual traffic")

_search_executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix="andromity-web")


class _TTLCache:
    def __init__(self, max_size: int = 100, ttl_seconds: int = 900):
        self._cache: Dict[str, Tuple[float, Any]] = {}
        self._max_size = max_size
        self._ttl = ttl_seconds

    def get(self, key: str) -> Optional[Any]:
        if key in self._cache:
            ts, val = self._cache[key]
            if time.time() - ts < self._ttl:
                return val
            del self._cache[key]
        return None

    def set(self, key: str, val: Any) -> None:
        if len(self._cache) >= self._max_size:
            oldest_key = min(self._cache.keys(), key=lambda k: self._cache[k][0], default=None)
            if oldest_key:
                del self._cache[oldest_key]
        self._cache[key] = (time.time(), val)


_SEARCH_CACHE = _TTLCache(max_size=100, ttl_seconds=900)
_URL_CACHE = _TTLCache(max_size=50, ttl_seconds=600)


def _clean_html(html_text: str) -> str:
    """Convert HTML string to readable plain text / markdown snippet."""
    if not html_text:
        return ""

    if BeautifulSoup:
        try:
            soup = BeautifulSoup(html_text, "html.parser")
            for tag in soup(["script", "style", "nav", "footer", "header", "aside", "noscript", "svg", "form", "dialog"]):
                tag.decompose()

            target = (
                soup.find("article")
                or soup.find("main")
                or soup.find("div", attrs={"role": "main"})
                or soup.find(id=re.compile(r"(content|main|article)", re.I))
                or soup.body
                or soup
            )

            if markdownify:
                md = markdownify(str(target), heading_style="ATX", escape_asterisks=False).strip()
                if md:
                    return re.sub(r"\n{3,}", "\n\n", md)

            text = target.get_text(separator="\n")
            lines = [line.strip() for line in text.splitlines() if line.strip()]
            return "\n\n".join(lines)
        except Exception as e:
            log.warning("DOM cleaning failed, falling back to regex: %s", e)

    if markdownify:
        try:
            return markdownify(html_text, heading_style="ATX", escape_asterisks=False).strip()
        except Exception:
            pass

    cleaned = re.sub(r"<(script|style|head|noscript|nav|footer|header|aside)[^>]*>.*?</\1>", " ", html_text, flags=re.DOTALL | re.IGNORECASE)
    cleaned = re.sub(r"<!--.*?-->", " ", cleaned, flags=re.DOTALL)
    cleaned = re.sub(r"</?(h[1-6]|p|div|br|li|tr|article|section)[^>]*>", "\n", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"<[^>]+>", "", cleaned)
    text = html.unescape(cleaned)
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.splitlines() if line.strip()]
    return "\n\n".join(lines)


def fetch_url(url: str, max_chars: int = 10000) -> str:
    """Fetch and return cleaned text content from a web URL.
    
    Args:
        url: The web URL to fetch (http/https).
        max_chars: Maximum characters to return.
    """
    if os.environ.get("ANDROMITY_AIRGAP") == "1":
        return "Error: Network fetching is blocked by air-gap policy."

    if not url.startswith(("http://", "https://")):
        return f"Error: URL must start with http:// or https://. Received: {url}"

    from andromity.core.security import get_domain, _is_private_ip
    host = get_domain(url)
    if not host:
        return f"Error: Cannot determine host from URL: {url}"
    if _is_private_ip(host):
        return f"Error: Fetching private/internal addresses is not allowed: {url}"

    cache_key = f"{url}:{max_chars}"
    cached = _URL_CACHE.get(cache_key)
    if cached is not None:
        return cached

    class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            from andromity.core.security import get_domain, _is_private_ip
            parsed = urllib.parse.urlparse(newurl)
            if parsed.scheme.lower() not in ("http", "https"):
                raise urllib.error.HTTPError(
                    newurl, code, f"Redirect to non-HTTP(S) scheme '{parsed.scheme}' blocked for security.", headers, fp
                )
            target_host = get_domain(newurl)
            if not target_host or _is_private_ip(target_host):
                raise urllib.error.HTTPError(
                    newurl, code, f"Redirect to private/internal host '{target_host}' blocked for security.", headers, fp
                )
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        }
    )
    opener = urllib.request.build_opener(_SafeRedirectHandler())
    attempt = 0
    while True:
        try:
            with opener.open(req, timeout=FETCH_TIMEOUT_S) as response:
                content_type = response.headers.get_content_type()
                raw_bytes = response.read(MAX_RESPONSE_BYTES)

                if _looks_binary(raw_bytes):
                    return (
                        f"Error fetching URL '{url}': the response is binary content ({content_type}), "
                        "not text or HTML, so it cannot be shown. Look for an HTML or plain-text version of this page."
                    )

                charset = response.headers.get_content_charset() or "utf-8"
                try:
                    decoded_text = raw_bytes.decode(charset, errors="replace")
                except LookupError:
                    decoded_text = raw_bytes.decode("utf-8", errors="replace")

                if "html" in content_type:
                    cleaned = _clean_html(decoded_text)
                else:
                    cleaned = decoded_text

                if len(cleaned) > max_chars:
                    result = cleaned[:max_chars] + f"\n\n[... Truncated at {max_chars} characters ...]"
                else:
                    result = cleaned

                _URL_CACHE.set(cache_key, result)
                return result

        except Exception as e:
            if attempt + 1 < FETCH_ATTEMPTS and _is_transient_fetch_error(e):
                log.info("Transient error fetching %s (%s), retrying", url, e)
                time.sleep(_backoff_delay(attempt))
                attempt += 1
                continue
            log.warning("Failed to fetch %s: %s", url, e)
            return f"Error fetching URL '{url}': {_describe_fetch_error(e)}"


def _looks_binary(raw_bytes: bytes) -> bool:
    head = raw_bytes[:1024]
    return b"\x00" in head or head.startswith(b"%PDF")


def _is_timeout_error(e: BaseException) -> bool:
    if isinstance(e, (socket.timeout, TimeoutError, FuturesTimeoutError)):
        return True
    reason = getattr(e, "reason", None)
    if isinstance(reason, (socket.timeout, TimeoutError)):
        return True
    return "timed out" in str(e).lower()


def _is_transient_fetch_error(e: BaseException) -> bool:
    if isinstance(e, urllib.error.HTTPError):
        return e.code in _TRANSIENT_HTTP_CODES
    if _is_timeout_error(e):
        return True
    if isinstance(e, urllib.error.URLError):
        return isinstance(e.reason, (ConnectionResetError, ConnectionAbortedError))
    return isinstance(e, (ConnectionResetError, ConnectionAbortedError))


def _describe_fetch_error(e: BaseException) -> str:
    if isinstance(e, urllib.error.HTTPError):
        if "blocked for security" in str(e.msg):
            return str(e.msg)
        if e.code == 404:
            return "the page was not found (HTTP 404). Check the URL or search for the page's current location."
        if e.code in (401, 403):
            return (
                f"the site refused the request (HTTP {e.code}). It may require signing in or block automated "
                "clients; try another source for this information."
            )
        if e.code == 429:
            return "the site is rate-limiting requests (HTTP 429). Wait a minute before fetching it again."
        if e.code >= 500:
            return f"the site returned a server error (HTTP {e.code}). Try again later or use another source."
        return f"the site returned HTTP {e.code} ({e.reason})."
    if _is_timeout_error(e):
        return f"the request timed out after {FETCH_TIMEOUT_S} seconds. The site may be slow or unreachable."
    if isinstance(e, urllib.error.URLError):
        return f"the site could not be reached ({e.reason}). Check the URL and the network connection."
    if isinstance(e, ssl.SSLError):
        return "a secure (TLS) connection to the site could not be established."
    return f"the response could not be read ({type(e).__name__})."


def _backoff_delay(attempt: int) -> float:
    return BACKOFF_BASE_S * (2 ** attempt) + random.uniform(0, BACKOFF_BASE_S)


class _SearchFailure(Exception):
    """A search provider failed; ``kind`` drives the message shown to the user."""

    def __init__(self, kind: str, detail: str):
        super().__init__(detail)
        self.kind = kind
        self.detail = detail


def _classify_search_error(e: BaseException) -> _SearchFailure:
    if isinstance(e, _SearchFailure):
        return e
    name = type(e).__name__.lower()
    text = str(e)
    lowered = text.lower()
    if "ratelimit" in name or "ratelimit" in lowered or "rate limit" in lowered or re.search(r"\b429\b", lowered):
        return _SearchFailure("rate_limited", text)
    if isinstance(e, urllib.error.HTTPError):
        if e.code == 429:
            return _SearchFailure("rate_limited", f"HTTP {e.code}")
        if e.code in (202, 401, 403):
            return _SearchFailure("blocked", f"HTTP {e.code}")
        return _SearchFailure("error", f"HTTP {e.code}")
    if "timeout" in name or _is_timeout_error(e):
        return _SearchFailure("timeout", text or "timed out")
    if isinstance(e, urllib.error.URLError) or isinstance(e, (ConnectionError, socket.gaierror)):
        return _SearchFailure("network", text)
    if "no results found" in lowered:
        return _SearchFailure("empty", text)
    return _SearchFailure("error", f"{type(e).__name__}: {text}")


def _http_read(url: str, data: Optional[bytes] = None, timeout: float = FALLBACK_TIMEOUT_S, accept: str = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8") -> bytes:
    headers = {"User-Agent": USER_AGENT, "Accept": accept, "Accept-Language": "en-US,en;q=0.9"}
    if data is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        if getattr(resp, "status", 200) == 202:
            raise _SearchFailure("blocked", "HTTP 202 challenge page")
        body = resp.read(MAX_RESPONSE_BYTES)
    if body[:2] == b"\x1f\x8b":
        body = gzip.decompress(body)
    return body


def _raise_if_block_page(html_content: str) -> None:
    lowered = html_content.lower()
    if any(marker in lowered for marker in _BLOCK_PAGE_MARKERS):
        raise _SearchFailure("blocked", "bot challenge page")


def _unwrap_redirect(href: str) -> str:
    if "uddg=" in href:
        try:
            return urllib.parse.unquote(href.split("uddg=")[1].split("&")[0])
        except Exception:
            return href
    return href


def _ddg_lite_search(query: str, max_results: int, timeout: float = FALLBACK_TIMEOUT_S) -> List[Dict[str, str]]:
    url = "https://lite.duckduckgo.com/lite/"
    post_data = urllib.parse.urlencode({"q": query}).encode("utf-8")
    html_content = _http_read(url, data=post_data, timeout=timeout).decode("utf-8", errors="replace")

    results = []
    if BeautifulSoup:
        soup = BeautifulSoup(html_content, "html.parser")
        for a in soup.find_all("a", class_="result-link"):
            title = a.get_text().strip()
            href = _unwrap_redirect(a.get("href", ""))
            parent_tr = a.find_parent("tr")
            snippet_tr = parent_tr.find_next_sibling("tr") if parent_tr else None
            snippet = snippet_tr.get_text().strip() if snippet_tr else ""
            if title and href:
                results.append({"title": title, "url": href, "snippet": snippet})
            if len(results) >= max_results:
                break
    else:
        links = re.findall(r'<a[^>]+class=["\']result-link["\'][^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', html_content)
        snippets = re.findall(r'<td[^>]+class=["\']result-snippet["\'][^>]*>(.*?)</td>', html_content, flags=re.DOTALL)
        for i, (href, title_html) in enumerate(links[:max_results]):
            title = _clean_html(title_html)
            snippet = _clean_html(snippets[i]) if i < len(snippets) else ""
            results.append({"title": title, "url": _unwrap_redirect(href), "snippet": snippet})

    if not results:
        _raise_if_block_page(html_content)
    return results


def _ddg_html_search(query: str, max_results: int, timeout: float = FALLBACK_TIMEOUT_S) -> List[Dict[str, str]]:
    encoded_query = urllib.parse.urlencode({"q": query})
    url = f"https://html.duckduckgo.com/html/?{encoded_query}"
    html_content = _http_read(url, timeout=timeout).decode("utf-8", errors="replace")

    results = []
    if BeautifulSoup:
        soup = BeautifulSoup(html_content, "html.parser")
        for div in soup.find_all("div", class_=re.compile(r"result\s+results_links")):
            a_title = div.find("a", class_="result__a")
            if not a_title:
                continue
            title = a_title.get_text().strip()
            href = _unwrap_redirect(a_title.get("href", ""))
            snippet_elem = div.find(class_=re.compile(r"result__snippet"))
            snippet = snippet_elem.get_text().strip() if snippet_elem else ""
            results.append({"title": title, "url": href, "snippet": snippet})
            if len(results) >= max_results:
                break
    else:
        blocks = re.findall(r'<div class="result\s+results_links[^"]*">(.*?)</div>\s*</div>', html_content, flags=re.DOTALL)
        for block in blocks[:max_results]:
            title_match = re.search(r'<a[^>]+class="result__a"[^>]*>(.*?)</a>', block, flags=re.DOTALL)
            url_match = re.search(r'<a[^>]+class="result__url"[^>]*href="([^"]+)"', block) or re.search(r'uddg=([^&"]+)', block)
            snippet_match = re.search(r'<a[^>]+class="result__snippet"[^>]*>(.*?)</a>', block, flags=re.DOTALL)
            title = _clean_html(title_match.group(1)) if title_match else "Untitled"
            raw_url = url_match.group(1) if url_match else ""
            snippet = _clean_html(snippet_match.group(1)) if snippet_match else ""
            if title or snippet:
                results.append({"title": title, "url": _unwrap_redirect(raw_url), "snippet": snippet})

    if not results:
        _raise_if_block_page(html_content)
    return results


def _stackexchange_search(query: str, max_results: int, timeout: float = FALLBACK_TIMEOUT_S) -> List[Dict[str, str]]:
    params = urllib.parse.urlencode({
        "q": query,
        "site": "stackoverflow",
        "order": "desc",
        "sort": "relevance",
        "pagesize": max_results,
        "filter": "withbody",
    })
    body = _http_read(f"https://api.stackexchange.com/2.3/search/advanced?{params}", timeout=timeout, accept="application/json")
    data = json.loads(body.decode("utf-8", errors="replace"))
    if data.get("error_id"):
        kind = "rate_limited" if data.get("error_name") == "throttle_violation" else "error"
        raise _SearchFailure(kind, f"Stack Exchange API: {data.get('error_name', 'error')}")

    results = []
    for item in data.get("items", []):
        text = re.sub(r"\s+", " ", _clean_html(item.get("body", ""))).strip()
        status = "answered" if item.get("is_answered") else "unanswered"
        results.append({
            "title": html.unescape(item.get("title", "")),
            "url": item.get("link", ""),
            "snippet": f"[Stack Overflow, {status}, score {item.get('score', 0)}] {text}",
        })
    return results


def _ddgs_backends(spec: str) -> str:
    if spec != "web":
        return spec
    try:
        from ddgs.engines import ENGINES
        keys = [k for k in ENGINES.get("text", {}) if k not in _ENCYCLOPEDIA_BACKENDS]
    except Exception:
        keys = []
    return ",".join(keys) or "auto"


def _ddgs_search(query: str, max_results: int, backend: str, region: str, timeout: int) -> List[Dict[str, str]]:
    raw = DDGS(timeout=timeout).text(query, max_results=max_results, backend=_ddgs_backends(backend), region=region) or []
    return [
        {"title": r.get("title", "") or "", "url": r.get("href", "") or "", "snippet": r.get("body", "") or ""}
        for r in raw
    ]


def _ddgs_hedged(
    query: str,
    max_results: int,
    domains: List[str],
    failures: List[Tuple[str, "_SearchFailure"]],
) -> List[Dict[str, str]]:
    """Run the ddgs attempts as hedged requests and return the first non-empty normalized result set.

    ddgs fans out to several engines and, on a bad draw, can spend 15+ seconds before giving up. A retry
    starts immediately when an attempt fails, or in parallel once the current one has run for
    DDGS_HEDGE_AFTER_S, so slow failures do not add up sequentially. Attempts still running at the
    deadline are abandoned (their worker threads finish in the background).
    """
    deadline = time.monotonic() + DDGS_BUDGET_S
    pending: Dict[Any, int] = {}
    next_attempt = 0
    hedge_at = 0.0

    def _launch() -> None:
        nonlocal next_attempt, hedge_at
        backend, region, timeout = _DDGS_ATTEMPTS[next_attempt]
        pending[_search_executor.submit(_ddgs_search, query, max_results, backend, region, timeout)] = next_attempt
        next_attempt += 1
        hedge_at = time.monotonic() + DDGS_HEDGE_AFTER_S

    _launch()
    while pending:
        now = time.monotonic()
        if now >= deadline:
            for _ in pending:
                failures.append(("ddgs", _SearchFailure("timeout", f"no response within {DDGS_BUDGET_S:.0f}s")))
            return []
        can_hedge = next_attempt < len(_DDGS_ATTEMPTS)
        wake_at = min(deadline, hedge_at) if can_hedge else deadline
        done, _ = wait(list(pending), timeout=max(0.0, wake_at - now), return_when=FIRST_COMPLETED)
        for future in done:
            pending.pop(future)
            try:
                found = _normalize_results(future.result(), domains, max_results)
            except Exception as e:
                failure = _classify_search_error(e)
                log.info("ddgs attempt failed (%s): %s", failure.kind, failure.detail)
                failures.append(("ddgs", failure))
                continue
            if found:
                return found
            failures.append(("ddgs", _SearchFailure("empty", "no matching results")))
        if can_hedge and (not pending or time.monotonic() >= hedge_at):
            if not pending:
                time.sleep(_backoff_delay(next_attempt - 1))
            if time.monotonic() < deadline:
                _launch()
    return []


def _normalize_domain(domain: str) -> str:
    d = domain.strip().lower()
    if "://" in d:
        d = urllib.parse.urlparse(d).netloc
    d = d.split("/")[0].split(":")[0]
    if d.startswith("*."):
        d = d[2:]
    if d.startswith("www."):
        d = d[4:]
    return d


def _host_matches(url: str, domains: List[str]) -> bool:
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    return any(host == d or host.endswith("." + d) for d in domains)


def _canonical_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    path = parsed.path.rstrip("/") or "/"
    host = (parsed.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    return f"{host}{path}?{parsed.query}" if parsed.query else f"{host}{path}"


def _clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(value or "")).strip()


def _normalize_results(raw: List[Dict[str, str]], domains: List[str], max_results: int) -> List[Dict[str, str]]:
    seen = set()
    results: List[Dict[str, str]] = []
    for r in raw:
        url = _unwrap_redirect((r.get("url") or "").strip())
        if url.startswith("//"):
            url = "https:" + url
        if not url.startswith(("http://", "https://")):
            continue
        if any(marker in url for marker in _AD_URL_MARKERS):
            continue
        if domains and not _host_matches(url, domains):
            continue
        key = _canonical_url(url)
        if key in seen:
            continue
        seen.add(key)
        title = _clean_text(r.get("title", "")) or url
        snippet = _clean_text(r.get("snippet", ""))
        if len(snippet) > MAX_SNIPPET_CHARS:
            snippet = snippet[:MAX_SNIPPET_CHARS].rsplit(" ", 1)[0] + " ..."
        results.append({"title": title, "url": url, "snippet": snippet})
        if len(results) >= max_results:
            break
    return results


def _coerce_int(value: Any, default: int, low: int, high: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(low, min(high, number))


def _failure_message(query: str, failures: List[Tuple[str, _SearchFailure]], domains: List[str]) -> str:
    kinds = {f.kind for _, f in failures}
    tried = ", ".join(dict.fromkeys(name for name, _ in failures)) or "none"
    if kinds and kinds <= {"network"}:
        reason = "No search provider could be reached. Check the internet connection or proxy settings, then retry."
    elif kinds & {"rate_limited", "blocked"}:
        reason = (
            "Search providers are rate-limiting or blocking requests from this network right now. "
            "Wait a minute and retry, or use fetch_url on a documentation page you already know."
        )
    elif "timeout" in kinds:
        reason = "Search providers did not respond in time. Retry shortly, or use fetch_url on a known documentation page."
    elif domains:
        reason = (
            f"Nothing matched on {', '.join(domains)}. Try broader keywords or remove the domain filter."
        )
    else:
        reason = "No provider returned matches. Try fewer, more general keywords or different wording."
    return f"No results found for search query: '{query}'\n\n{reason}\n(Providers tried: {tried}.)"


def web_search(
    query: str,
    max_results: int = 5,
    fetch_top: int = 0,
    domains: Optional[List[str]] = None,
) -> str:
    """Perform a web search and return summarized results.

    Args:
        query: Search query terms.
        max_results: Max number of search results.
        fetch_top: Number of top search results to automatically fetch and extract content for (default 0).
        domains: Optional list of domains to restrict search to.
    """
    if os.environ.get("ANDROMITY_AIRGAP") == "1":
        return "Error: Web search is blocked by air-gap policy."

    base_query = (query or "").strip()
    if not base_query:
        return "Error: Search query cannot be empty."

    max_results = _coerce_int(max_results, 5, 1, MAX_SEARCH_RESULTS)
    fetch_top = _coerce_int(fetch_top, 0, 0, MAX_FETCH_TOP)
    if isinstance(domains, str):
        domains = [domains]
    domain_list = list(dict.fromkeys(d for d in (_normalize_domain(x) for x in (domains or []) if isinstance(x, str)) if d))

    clean_query = base_query
    if len(domain_list) == 1:
        clean_query = f"{base_query} site:{domain_list[0]}"
    elif domain_list:
        clean_query = f"{base_query} ({' OR '.join(f'site:{d}' for d in domain_list)})"

    cache_key = f"{clean_query}:{max_results}:{fetch_top}"
    cached = _SEARCH_CACHE.get(cache_key)
    if cached is not None:
        return cached

    deadline = time.monotonic() + SEARCH_BUDGET_S
    failures: List[Tuple[str, _SearchFailure]] = []
    results: List[Dict[str, str]] = []
    source = ""

    def _attempt(name: str, call: Any) -> List[Dict[str, str]]:
        try:
            found = _normalize_results(call(), domain_list, max_results)
        except Exception as e:
            failure = _classify_search_error(e)
            log.info("Search provider %s failed (%s): %s", name, failure.kind, failure.detail)
            failures.append((name, failure))
            return []
        if not found:
            failures.append((name, _SearchFailure("empty", "no matching results")))
        return found

    if DDGS:
        results = _ddgs_hedged(clean_query, max_results, domain_list, failures)

    for name, func, q in (
        ("DuckDuckGo Lite", _ddg_lite_search, clean_query),
        ("DuckDuckGo HTML", _ddg_html_search, clean_query),
        ("Stack Overflow", _stackexchange_search, base_query),
    ):
        if results:
            break
        # Both DuckDuckGo endpoints share infrastructure and bot protection, so a block or hang on one applies to the other.
        if name == "DuckDuckGo HTML" and any(n == "DuckDuckGo Lite" and f.kind in ("blocked", "rate_limited", "timeout") for n, f in failures):
            continue
        if name == "Stack Overflow" and domain_list and not any(d.endswith("stackoverflow.com") for d in domain_list):
            continue
        timeout = max(3.0, min(FALLBACK_TIMEOUT_S, deadline - time.monotonic()))
        results = _attempt(name, lambda f=func, q=q, t=timeout: f(q, max_results=max_results, timeout=t))
        if results:
            source = name

    if not results:
        log.warning("Web search failed for %r: %s", base_query, [(n, f.kind) for n, f in failures])
        return _failure_message(base_query, failures, domain_list)

    output = [f"### Web Search Results for: `{query}`\n"]
    if source == "Stack Overflow":
        output.append("_General web search was unavailable; these results come from Stack Overflow._\n")
    for i, r in enumerate(results, 1):
        output.append(f"**{i}. {r['title']}**\n- Link: {r['url']}\n- Summary: {r['snippet']}\n")

    if fetch_top > 0:
        top_targets = results[: min(fetch_top, len(results))]
        for i, target in enumerate(top_targets, 1):
            target_url = target.get("url", "")
            if target_url:
                content = fetch_url(target_url, max_chars=4000)
                output.append(f"\n---\n#### [Content Extract #{i}] {target['title']} ({target_url})\n\n{content}\n")

    final_result = "\n".join(output)
    _SEARCH_CACHE.set(cache_key, final_result)
    return final_result
