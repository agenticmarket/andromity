"""Web search and URL content fetching tools with safety guardrails."""
import html
import logging
import re
import time
import urllib.parse
import urllib.request
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
            target_host = get_domain(newurl)
            if not target_host or _is_private_ip(target_host):
                raise urllib.error.HTTPError(
                    newurl, code, f"Redirect to private/internal host '{target_host}' blocked for security.", headers, fp
                )
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    try:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            }
        )
        opener = urllib.request.build_opener(_SafeRedirectHandler())
        with opener.open(req, timeout=15) as response:
            content_type = response.headers.get_content_type()
            raw_bytes = response.read(MAX_RESPONSE_BYTES)
            
            charset = response.headers.get_content_charset() or "utf-8"
            decoded_text = raw_bytes.decode(charset, errors="replace")

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
        log.warning("Failed to fetch %s: %s", url, e)
        return f"Error fetching URL '{url}': {e}"


def _ddg_lite_search(query: str, max_results: int) -> List[Dict[str, str]]:
    url = "https://lite.duckduckgo.com/lite/"
    post_data = urllib.parse.urlencode({"q": query}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=post_data,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Content-Type": "application/x-www-form-urlencoded",
        }
    )
    with urllib.request.urlopen(req, timeout=12) as resp:
        html_content = resp.read().decode("utf-8", errors="replace")

    results = []
    if BeautifulSoup:
        soup = BeautifulSoup(html_content, "html.parser")
        for a in soup.find_all("a", class_="result-link"):
            title = a.get_text().strip()
            href = a.get("href", "")
            if "uddg=" in href:
                try:
                    href = urllib.parse.unquote(href.split("uddg=")[1].split("&")[0])
                except Exception:
                    pass
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
            if "uddg=" in href:
                try:
                    href = urllib.parse.unquote(href.split("uddg=")[1].split("&")[0])
                except Exception:
                    pass
            results.append({"title": title, "url": href, "snippet": snippet})

    return results


def _ddg_html_search(query: str, max_results: int) -> List[Dict[str, str]]:
    encoded_query = urllib.parse.urlencode({"q": query})
    url = f"https://html.duckduckgo.com/html/?{encoded_query}"
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        }
    )
    with urllib.request.urlopen(req, timeout=12) as resp:
        html_content = resp.read().decode("utf-8", errors="replace")

    results = []
    if BeautifulSoup:
        soup = BeautifulSoup(html_content, "html.parser")
        for div in soup.find_all("div", class_=re.compile(r"result\s+results_links")):
            a_title = div.find("a", class_="result__a")
            if not a_title:
                continue
            title = a_title.get_text().strip()
            href = a_title.get("href", "")
            if "uddg=" in href:
                try:
                    href = urllib.parse.unquote(href.split("uddg=")[1].split("&")[0])
                except Exception:
                    pass
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
            if "uddg=" in raw_url:
                try:
                    actual_url = urllib.parse.unquote(raw_url.split("uddg=")[1].split("&")[0])
                except Exception:
                    actual_url = raw_url
            else:
                actual_url = raw_url
            snippet = _clean_html(snippet_match.group(1)) if snippet_match else ""
            if title or snippet:
                results.append({"title": title, "url": actual_url, "snippet": snippet})

    return results


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
    clean_query = query.strip()
    if not clean_query:
        return "Error: Search query cannot be empty."

    if domains:
        site_filters = " ".join([f"site:{d.strip()}" for d in domains if d.strip()])
        if site_filters:
            clean_query = f"{clean_query} {site_filters}"

    cache_key = f"{clean_query}:{max_results}:{fetch_top}"
    cached = _SEARCH_CACHE.get(cache_key)
    if cached is not None:
        return cached

    results: List[Dict[str, str]] = []

    if DDGS:
        try:
            ddgs_res = DDGS().text(clean_query, max_results=max_results)
            if ddgs_res:
                for r in ddgs_res:
                    results.append({
                        "title": r.get("title", "Untitled"),
                        "url": r.get("href", ""),
                        "snippet": r.get("body", ""),
                    })
        except Exception as e:
            log.warning("DDGS search failed: %s, trying DDG Lite", e)

    if not results:
        try:
            results = _ddg_lite_search(clean_query, max_results=max_results)
        except Exception as e:
            log.warning("DDG Lite search failed: %s, trying DDG HTML", e)

    if not results:
        try:
            results = _ddg_html_search(clean_query, max_results=max_results)
        except Exception as e:
            log.warning("DDG HTML search failed: %s", e)

    if not results:
        return f"No results found for search query: '{query}'"

    output = [f"### Web Search Results for: `{query}`\n"]
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

