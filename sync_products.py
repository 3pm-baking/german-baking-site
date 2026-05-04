"""
Sync product YAML files from a recipes payload.

Usage:
  Local testing:
    uv run python sync_products.py payload.json

  CI (GitHub Actions) — reads from PAYLOAD env var and writes to GITHUB_OUTPUT:
    python sync_products.py
"""

import json
import os
import re
import sys
import yaml
from pathlib import Path


def build_slug_index(base: Path) -> dict[str, Path]:
    """Build a slug → file path index across all product directories.

    Prefers the explicit `slug:` field in the YAML; falls back to the
    filename stem with any leading numeric prefix (e.g. "01-") stripped.
    """
    slug_index = {}
    for search_dir in ["oven", "pantry", "also-available"]:
        for f in sorted((base / search_dir).glob("*.yml")):
            data = yaml.safe_load(f.read_text()) or {}
            key = data.get("slug") or re.sub(r'^\d+-', '', f.stem)
            slug_index[key] = f
    return slug_index


def sync_products(products: list[dict], base: Path) -> dict:
    """Apply a list of product updates to the content directory.

    Returns a dict with keys: created, updated, skipped, deleted.
    """
    slug_index = build_slug_index(base)
    created, updated, skipped, deleted = [], [], [], []

    for product in products:
        slug = product["slug"]
        website = product.get("website", True)
        # Strip upstream-only keys — never write these to the website repo
        update = {k: v for k, v in product.items() if k not in ("slug", "website")}

        existing_path = slug_index.get(slug)

        # Upstream controls what appears on the site via website: false
        if not website:
            if existing_path:
                existing_path.unlink()
                deleted.append(slug)
            else:
                skipped.append(slug)
            continue

        if existing_path:
            # Merge into the existing file wherever it lives.
            # Preserve all existing fields; overwrite with incoming fields.
            existing = yaml.safe_load(existing_path.read_text()) or {}
            merged = {**existing, **update}
            content = yaml.dump(merged, allow_unicode=True, default_flow_style=False, sort_keys=False)
            if existing_path.read_text() == content:
                skipped.append(slug)
            else:
                existing_path.write_text(content)
                updated.append(slug)
        else:
            # New product — create in also-available by default.
            write_path = base / "also-available" / f"{slug}.yml"
            write_path.parent.mkdir(parents=True, exist_ok=True)
            content = yaml.dump(update, allow_unicode=True, default_flow_style=False, sort_keys=False)
            write_path.write_text(content)
            created.append(slug)

    # Delete products absent from the payload entirely (treat payload as source of truth)
    payload_slugs = {p["slug"] for p in products}
    for slug, path in slug_index.items():
        if slug not in payload_slugs:
            path.unlink()
            deleted.append(slug)

    return {"created": created, "updated": updated, "skipped": skipped, "deleted": deleted}


def build_summary(results: dict) -> str:
    created, updated, skipped, deleted = (
        results["created"], results["updated"], results["skipped"], results["deleted"]
    )
    lines = []
    if created:
        lines.append("**Created:**")
        lines += [f"- `{s}`" for s in created]
    if updated:
        lines.append("**Updated:**")
        lines += [f"- `{s}`" for s in updated]
    if deleted:
        lines.append("**Deleted:**")
        lines += [f"- `{s}`" for s in deleted]
    if skipped:
        lines.append(f"**Unchanged:** {len(skipped)} product(s)")
    return "\n".join(lines) + "\n"


def main():
    base = Path("content/products")

    # --- Load payload ---
    if len(sys.argv) > 1:
        # Local: read from file argument
        payload = json.loads(Path(sys.argv[1]).read_text())
    else:
        # CI: read from environment variable
        payload = json.loads(os.environ["PAYLOAD"])

    products = payload["products"]

    # --- Run sync ---
    results = sync_products(products, base)
    created, updated, skipped, deleted = (
        results["created"], results["updated"], results["skipped"], results["deleted"]
    )

    # --- Print results ---
    print(f"created={len(created)} updated={len(updated)} skipped={len(skipped)} deleted={len(deleted)}")
    for s in created:
        print(f"  created: {s}")
    for s in updated:
        print(f"  updated: {s}")
    for s in deleted:
        print(f"  deleted: {s}")

    summary = build_summary(results)

    # --- Write outputs (CI only) ---
    has_changes = bool(created or updated or deleted)
    if "GITHUB_OUTPUT" in os.environ:
        Path("/tmp/pr-summary.md").write_text(summary)
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write(f"has_changes={'true' if has_changes else 'false'}\n")
    else:
        # Local: just print the summary
        print()
        print(summary)


if __name__ == "__main__":
    main()
