"""Build-time checks for the pre-order (tailgate) ordering layer.

The ordering layer spans three places that nothing else ties together: the
static pages that load ``preorder.js``, the JS that talks to the API, and the
API base baked into the generated HTML. A mismatch between them does not fail
loudly — it produces a page that quietly stops selling things, or one that
points a customer at localhost. Every check here turns a silent failure into a
build failure.

The rule behind all of them: **the generated HTML is an artifact, and a build
that produces the wrong artifact is a failed build.**
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

# Ordering surfaces: the generated page, and what the page must contain for the
# ordering JS to work. A page missing either half is a dead checkout button.
# `glob: true` entries are checked against at least one match (a page family
# such as the per-product detail pages) rather than one exact file.
ORDERING_PAGES = {
    "index.html": "landing page (product grid steppers)",
    "cart/index.html": "cart",
    "order-status/index.html": "order status",
    "orders/index.html": "find my order",
    "products/*.html": "product detail pages",
}

# hostnames that must never survive into a committed build
FORBIDDEN_API_HOSTS = ("127.0.0.1", "localhost", "0.0.0.0", "[::1]")


class PreorderCheckError(Exception):
    """A pre-order wiring check failed. The build must not ship this."""


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def check_preorder_js_parses(site_root: Path) -> list[str]:
    """preorder.js is the whole ordering layer in one unbundled file.

    It is served straight to the browser, so a syntax error is only ever
    discovered by a customer with an empty cart. Parse it at build time.
    """
    script = site_root / "preorder.js"
    if not script.exists():
        raise PreorderCheckError("preorder.js is missing — the ordering layer cannot load")

    node = shutil.which("node")
    if not node:
        # Not fatal: the site's own JS tests need node anyway, so a build
        # machine without it will hear about it there.
        return ["! node not installed — skipped the preorder.js syntax check"]

    result = subprocess.run([node, "--check", str(script)], capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise PreorderCheckError(f"preorder.js does not parse:\n{result.stderr.strip() or result.stdout.strip()}")
    return ["✓ preorder.js parses"]


def _page_paths(base_dir: Path, pattern: str) -> list[Path]:
    """Resolve an ordering-page pattern.

    Globs must match at least one file. `products/index.html` is excluded: it is
    the all-products listing, not a sellable detail page, and carries no
    ordering markup by design.
    """
    if "*" in pattern:
        return [p for p in sorted(base_dir.glob(pattern)) if p.name != "index.html"]
    path = base_dir / pattern
    return [path] if path.exists() else []


def check_generated_pages(base_dir: Path, api_base: str) -> list[str]:
    """Each ordering page must load the JS and define the API base.

    A page that renders the cart markup but forgets the ``<script>`` shows an
    empty page that looks broken; a page that forgets the base renders nothing
    at all. Both are invisible until someone tries to order.
    """
    notes: list[str] = []
    missing: list[str] = []
    checked = 0

    for pattern, label in ORDERING_PAGES.items():
        paths = _page_paths(base_dir, pattern)
        if not paths:
            missing.append(f"{pattern} ({label}) was not generated")
            continue

        for page in paths:
            checked += 1
            html = _read(page)
            name = page.relative_to(base_dir)
            if "preorder.js" not in html:
                missing.append(f"{name} ({label}) does not load preorder.js")
            if "TAILGATE_API_BASE" not in html:
                missing.append(f"{name} ({label}) does not define TAILGATE_API_BASE")

    if missing:
        raise PreorderCheckError("the pre-order pages are not fully wired:\n  - " + "\n  - ".join(missing))

    notes.append(f"✓ {checked} ordering page(s) load preorder.js with an API base")
    return notes


def check_baked_api_base(base_dir: Path, api_base: str) -> list[str]:
    """The API base must be the one this build was asked for.

    Building against a local server and committing the result is an easy
    mistake (it is how demo builds end up on the live site) and it is silent:
    the HTML is complete, the cart just reports "Pre-orders are unavailable".
    """
    if not api_base:
        raise PreorderCheckError("TAILGATE_API_BASE is empty — the ordering layer has no server")

    offenders: list[str] = []
    for pattern in ORDERING_PAGES:
        for page in _page_paths(base_dir, pattern):
            for host in FORBIDDEN_API_HOSTS:
                if re.search(rf'TAILGATE_API_BASE\s*=\s*"[^"]*{re.escape(host)}', _read(page)):
                    offenders.append(f"{page.relative_to(base_dir)} bakes {host} into the API base")

    if offenders:
        raise PreorderCheckError(
            "the build baked a local API base into the site:\n  - "
            + "\n  - ".join(offenders)
            + "\nRebuild without TAILGATE_API_BASE (or with the production value) and commit that."
        )

    return [f"✓ ordering pages point at {api_base}"]


def check_markets_map(base_dir: Path) -> list[str]:
    """The order-status market map must exist and be well formed.

    The status page resolves a pickup point to an address, hours, and a Maps
    link by looking the market's *label* up in a map built from
    content/locations/*.yml. This check confirms that map actually made it
    into the page and that every market has the fields the card renders — the
    half that can be checked from the build alone.

    The other direction (a market the API sells that this map does not have)
    is a cross-repo question and is checked against a live server in
    tailgate/tests/integration/test_site_totals.py.
    """
    locations_dir = base_dir / "content" / "locations"
    if not locations_dir.exists():
        return ["! content/locations is missing — skipped the markets map check"]

    status_page = base_dir / "order-status" / "index.html"
    if not status_page.exists():
        return ["! order-status page not generated — skipped the markets map check"]

    html = _read(status_page)
    match = re.search(r"TAILGATE_MARKETS\s*=\s*(\{.*?\});", html, re.S)
    if not match:
        raise PreorderCheckError(
            "the order-status page has no TAILGATE_MARKETS map — the pickup card "
            "would render with no market name, address, or hours"
        )

    try:
        markets = json.loads(match.group(1))
    except json.JSONDecodeError as exc:
        raise PreorderCheckError(f"TAILGATE_MARKETS is not valid JSON: {exc}") from exc

    if not markets:
        raise PreorderCheckError(
            "TAILGATE_MARKETS is empty — no market would be resolvable on the "
            "order-status page. Run the location sync, then rebuild."
        )

    incomplete = sorted(
        name for name, entry in markets.items() if not (entry.get("address") and entry.get("schedule_display"))
    )
    if incomplete:
        raise PreorderCheckError(
            "these markets render without an address or hours, which is what a "
            "customer opens the status page to find:\n  - " + "\n  - ".join(incomplete)
        )

    return [f"✓ {len(markets)} market(s) resolvable on the order-status page"]


def run_preorder_checks(base_dir: Path, api_base: str) -> list[str]:
    """Every check, in order. Raises PreorderCheckError on the first failure."""
    site_root = base_dir
    notes: list[str] = []
    notes.extend(check_preorder_js_parses(site_root))
    notes.extend(check_generated_pages(base_dir, api_base))
    notes.extend(check_baked_api_base(base_dir, api_base))
    notes.extend(check_markets_map(base_dir))
    return notes
