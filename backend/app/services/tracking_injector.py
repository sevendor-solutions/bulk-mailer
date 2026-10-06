import re
from urllib.parse import quote
from app.services.provider_config import get_effective_tracking_url


def inject_unsubscribe(html_body: str, recipient_id: int, base_url: str | None = None) -> str:
    """
    Ensure the email contains an unsubscribe link.
    1. Replaces {{unsubscribe_url}} placeholder with the actual unsubscribe URL.
    2. If no unsubscribe link is present in the HTML, injects a clean default footer.
    """
    url = (base_url or get_effective_tracking_url() or "").strip().rstrip("/")
    if not url:
        return html_body.replace("{{unsubscribe_url}}", "#")

    unsub_url = f"{url}/unsubscribe/{recipient_id}"

    # Replace placeholder if present
    if "{{unsubscribe_url}}" in html_body:
        html_body = html_body.replace("{{unsubscribe_url}}", unsub_url)

    # Check if there is already an unsubscribe link in the HTML body
    has_unsub = bool(
        re.search(r'href=[\'"][^\'"]*unsubscribe[^\'"]*[\'"]', html_body, re.IGNORECASE)
        or re.search(r'>\s*unsubscribe\s*<', html_body, re.IGNORECASE)
    )

    if not has_unsub:
        footer = f'''
<div style="margin-top: 32px; padding: 16px 8px; border-top: 1px solid #e5e7eb; text-align: center; font-size: 12px; color: #6b7280; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
    <p style="margin: 0 0 4px 0;">You received this email because you are on our mailing list.</p>
    <p style="margin: 0;"><a href="{unsub_url}" style="color: #4f46e5; text-decoration: underline;">Unsubscribe</a></p>
</div>
'''
        body_pattern = re.compile(r'</body>', re.IGNORECASE)
        if body_pattern.search(html_body):
            html_body = body_pattern.sub(f"{footer}</body>", html_body, count=1)
        else:
            html_body += footer

    return html_body


def inject_tracking(html_body: str, recipient_id: int, campaign_id: int) -> str:
    """
    Inject open tracking pixel, default unsubscribe footer, and wrap links for click tracking.
    Called at send-time per-recipient.
    """
    base_url = get_effective_tracking_url()
    if not base_url:
        return html_body

    # 1. Ensure unsubscribe link/footer is present
    html_body = inject_unsubscribe(html_body, recipient_id, base_url)

    # 2. Click tracking: wrap all href links
    html_body = _wrap_links(html_body, recipient_id, campaign_id, base_url)

    # 3. Open tracking: inject 1x1 pixel before </body>
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
    """Replace all <a href="..."> links with tracking redirect URLs."""
    
    def replace_link(match):
        quote_char = match.group(1)
        original_url = match.group(2)
        # Don't wrap unsubscribe links, anchors, or mailto
        if "unsubscribe" in original_url.lower() or original_url.startswith("mailto:") or original_url.startswith("#"):
            return match.group(0)
        encoded_url = quote(original_url, safe="")
        tracking_url = f"{base_url}/track/click/{recipient_id}?url={encoded_url}&cid={campaign_id}"
        return f'href="{tracking_url}"'

    pattern = r'href=([\'"])(.*?)\1'
    return re.sub(pattern, replace_link, html_body)
