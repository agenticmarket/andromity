"""Web search and URL content fetching tools with safety guardrails."""
import html
import json
import logging
import re
import urllib.parse
import urllib.request
from typing import Optional

try:
    from markdownify import markdownify
except ImportError:
    markdownify = None

try:
    from ddgs import DDGS
except ImportError:
    DDGS = None

log = logging.getLogger("andromity.web")

# Safe user agent
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Andromity/1.0"


def _clean_html(html_text: str) -> str:
    """Convert HTML string to readable plain text / markdown snippet."""
    if markdownify:
        try:
            return markdownify(html_text, heading_style="ATX", escape_asterisks=False).strip()
        except Exception as e:
            log.warning("markdownify failed, falling back to regex: %s", e)

    # Fallback: Remove scripts, styles, head, comments
    cleaned = re.sub(r"<(script|style|head|noscript)[^>]*>.*?</\1>", " ", html_text, flags=re.DOTALL | re.IGNORECASE)
    cleaned = re.sub(r"<!--.*?-->", " ", cleaned, flags=re.DOTALL)
    
    # Replace block-level tags with newlines
    cleaned = re.sub(r"</?(h[1-6]|p|div|br|li|tr|article|section)[^>]*>", "\n", cleaned, flags=re.IGNORECASE)
    
    # Strip remaining HTML tags
    cleaned = re.sub(r"<[^>]+>", "", cleaned)
    
    # Unescape HTML entities
    text = html.unescape(cleaned)
    
    # Collapse consecutive whitespace and empty lines
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.splitlines()]
    non_empty = [line for line in lines if line]
    return "\n\n".join(non_empty)


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
            }
        )
        urllib.request.install_opener(urllib.request.build_opener(_SafeRedirectHandler()))
        with urllib.request.urlopen(req, timeout=15) as response:
            content_type = response.headers.get_content_type()
            raw_bytes = response.read(max_chars * 4)  # Read enough bytes
            
            charset = response.headers.get_content_charset() or "utf-8"
            decoded_text = raw_bytes.decode(charset, errors="replace")

            if "html" in content_type:
                cleaned = _clean_html(decoded_text)
            else:
                cleaned = decoded_text

            if len(cleaned) > max_chars:
                return cleaned[:max_chars] + f"\n\n[... Truncated at {max_chars} characters ...]"
            return cleaned

    except Exception as e:
        log.warning("Failed to fetch %s: %s", url, e)
        return f"Error fetching URL '{url}': {e}"


def web_search(query: str, max_results: int = 5) -> str:
    """Perform a web search and return summarized results.
    
    Args:
        query: Search query terms.
        max_results: Max number of search results.
    """
    query = query.strip()
    if not query:
        return "Error: Search query cannot be empty."

    if DDGS:
        try:
            results = DDGS().text(query, max_results=max_results)
            if not results:
                return f"No results found for search query: '{query}'"
            
            output = [f"### Web Search Results for: `{query}`\n"]
            for i, r in enumerate(results, 1):
                output.append(f"**{i}. {r.get('title', 'Untitled')}**\n- Link: {r.get('href', '')}\n- Summary: {r.get('body', '')}\n")
            
            return "\n".join(output)
        except Exception as e:
            log.warning("DDGS API search failed for %s: %s, falling back to HTML scrape", query, e)

    # Fallback to HTML scraping
    try:
        # Use DuckDuckGo HTML search API endpoint for lightweight text parsing
        encoded_query = urllib.parse.urlencode({"q": query})
        search_url = f"https://html.duckduckgo.com/html/?{encoded_query}"

        req = urllib.request.Request(
            search_url,
            headers={"User-Agent": USER_AGENT}
        )
        with urllib.request.urlopen(req, timeout=15) as response:
            html_content = response.read().decode("utf-8", errors="replace")

        # Extract result links and snippets
        # Matches <a class="result__snippet" ...>...</a> and <a class="result__url" ...>...</a>
        results = []
        # Find result blocks
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
                results.append({
                    "title": title,
                    "url": actual_url,
                    "snippet": snippet
                })

        if not results:
            return f"No results found for search query: '{query}'"

        output = [f"### Web Search Results for: `{query}`\n"]
        for i, r in enumerate(results, 1):
            output.append(f"**{i}. {r['title']}**\n- Link: {r['url']}\n- Summary: {r['snippet']}\n")

        return "\n".join(output)

    except Exception as e:
        log.warning("Search failed for %s: %s", query, e)
        return f"Error executing web search for '{query}': {e}"
