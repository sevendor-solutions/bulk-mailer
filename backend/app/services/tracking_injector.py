import re
from urllib.parse import quote
from app.services.provider_config import get_effective_tracking_url


def inject_tracking(html_body: str, recipient_id: int, campaign_id: int) -> str:
    """
    Inject open tracking pixel and wrap links for click tracking.
    Called at send-time per-recipient.
    """
    base_url = get_effective_tracking_url()
    if not base_url:
        return html_body

    # 1. Click tracking: wrap all href links
    html_body = _wrap_links(html_body, recipient_id, campaign_id, base_url)

    # 2. Open tracking: inject 1x1 pixel before </body>
    # Note: Avoid display:none because many email clients/proxies (e.g. Gmail Image Proxy)
    # suppress fetching images marked display:none. Use absolute positioning with opacity instead.
    pixel = f'<img src="{base_url}/track/open/{recipient_id}" width="1" height="1" border="0" alt="" style="position:absolute;top:0;left:0;width:1px;height:1px;opacity:0.01;pointer-events:none;border:none;" />'
    
    body_pattern = re.compile(r'</body>', re.IGNORECASE)
    if body_pattern.search(html_body):
        html_body = body_pattern.sub(f"{pixel}</body>", html_body, count=1)
    else:
        html_body += pixel

    return html_body


def _wrap_links(html_body: str, recipient_id: int, campaign_id: int, base_url: str) -> str:
    """
    Replace all <a href="..."> links with tracking redirect URLs,
    and auto-link any standalone raw URLs in text content.
    """
    # 1. First, wrap existing <a ... href="..."> tags
    def replace_existing_a(m):
        prefix = m.group(1)
        quote_char = m.group(2)
        orig_url = m.group(3)
        suffix = m.group(4)
        if "unsubscribe" in orig_url.lower() or orig_url.startswith("mailto:") or orig_url.startswith("#") or f"{base_url}/track/click" in orig_url:
            return m.group(0)
        encoded_url = quote(orig_url, safe="")
        tracking_url = f"{base_url}/track/click/{recipient_id}?url={encoded_url}&cid={campaign_id}"
        return f"{prefix}{quote_char}{tracking_url}{suffix}"

    pattern_a = r'(<a\b[^>]*?\bhref=)([\'"])(.*?)([\'"])'
    html_body = re.sub(pattern_a, replace_existing_a, html_body, flags=re.IGNORECASE)

    # 2. Next, auto-link standalone raw URLs in text outside of <a>, <style>, <script> tags
    parts = re.split(r'(<[^>]+>)', html_body)
    in_a_tag = False
    in_style_or_script = False
    new_parts = []

    for part in parts:
        if part.startswith('<'):
            tag_lower = part.lower().strip()
            if tag_lower.startswith('<a ') or tag_lower == '<a>':
                in_a_tag = True
            elif tag_lower == '</a>':
                in_a_tag = False
            elif tag_lower.startswith('<style') or tag_lower.startswith('<script'):
                in_style_or_script = True
            elif tag_lower == '</style>' or tag_lower == '</script>':
                in_style_or_script = False
            new_parts.append(part)
        else:
            if not in_a_tag and not in_style_or_script and ('http://' in part or 'https://' in part):
                def make_link(m):
                    raw_url = m.group(0)
                    trailing = ""
                    while raw_url and raw_url[-1] in ".,!?;:)":
                        trailing = raw_url[-1] + trailing
                        raw_url = raw_url[:-1]
                    if not raw_url:
                        return trailing
                    encoded_url = quote(raw_url, safe="")
                    tracking_url = f"{base_url}/track/click/{recipient_id}?url={encoded_url}&cid={campaign_id}"
                    return f'<a href="{tracking_url}">{raw_url}</a>{trailing}'

                url_pattern = r'https?://[^\s<>"]+'
                part = re.sub(url_pattern, make_link, part)
            new_parts.append(part)

    return "".join(new_parts)
