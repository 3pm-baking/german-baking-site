"""
Sync location YAML files from a locations payload.

Usage:
  Local testing:
    uv run python sync_locations.py payload.json

  CI (GitHub Actions) — reads from PAYLOAD env var and writes to GITHUB_OUTPUT:
    python sync_locations.py
"""

import json
import os
import re
import sys
import yaml
from pathlib import Path


LOCATIONS_DIR = Path("content/locations")


def build_slug_index(base: Path) -> dict[str, Path]:
    """Build a slug → file path index across the locations directory.

    Prefers the explicit `slug:` field in the YAML; falls back to the
    filename stem with any leading numeric prefix (e.g. "01-") stripped.
    """
    slug_index = {}
    if not base.exists():
        return slug_index
    for f in sorted(base.glob("*.yml")):
        data = yaml.safe_load(f.read_text()) or {}
        key = data.get("slug") or re.sub(r"^\d+-", "", f.stem)
        slug_index[key] = f
    return slug_index


def sync_locations(locations: list[dict], base: Path) -> dict:
    """Apply a list of location updates to the content/locations directory.

    Returns a dict with keys: created, updated, skipped, deleted.
    """
    base.mkdir(parents=True, exist_ok=True)
    slug_index = build_slug_index(base)
    created, updated, skipped, deleted = [], [], [], []

    for location in locations:
        slug = location["slug"]
        # Strip slug from the written file — it's encoded in the filename
        update = {k: v for k, v in location.items() if k != "slug"}

        existing_path = slug_index.get(slug)

        if existing_path:
            existing = yaml.safe_load(existing_path.read_text()) or {}
            # Merge: preserve site-specific fields, overwrite with incoming fields
            merged = {**existing, **update}
            content = yaml.dump(
                merged, allow_unicode=True, default_flow_style=False, sort_keys=False
            )
            if existing_path.read_text() == content:
                skipped.append(slug)
            else:
                existing_path.write_text(content)
                updated.append(slug)
        else:
            write_path = base / f"{slug}.yml"
            content = yaml.dump(
                update, allow_unicode=True, default_flow_style=False, sort_keys=False
            )
            write_path.write_text(content)
            created.append(slug)

    # Remove locations absent from the payload (payload is source of truth)
    payload_slugs = {loc["slug"] for loc in locations}
    for slug, path in slug_index.items():
        if slug not in payload_slugs:
            path.unlink()
            deleted.append(slug)

    return {"created": created, "updated": updated, "skipped": skipped, "deleted": deleted}


def build_summary(results: dict) -> str:
    created, updated, skipped, deleted = (
        results["created"],
        results["updated"],
        results["skipped"],
        results["deleted"],
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
        lines.append(f"**Unchanged:** {len(skipped)} location(s)")
    return "\n".join(lines) + "\n"


def main():
    # --- Load payload ---
    if len(sys.argv) > 1:
        payload = json.loads(Path(sys.argv[1]).read_text())
    elif "PAYLOAD" in os.environ:
        payload = json.loads(os.environ["PAYLOAD"])
    else:
        print("No payload provided — skipping location sync.")
        return

    locations = payload.get("locations", [])

    # --- Run sync ---
    results = sync_locations(locations, LOCATIONS_DIR)
    created, updated, skipped, deleted = (
        results["created"],
        results["updated"],
        results["skipped"],
        results["deleted"],
    )

    print(
        f"created={len(created)} updated={len(updated)} "
        f"skipped={len(skipped)} deleted={len(deleted)}"
    )
    for s in created:
        print(f"  created: {s}")
    for s in updated:
        print(f"  updated: {s}")
    for s in deleted:
        print(f"  deleted: {s}")

    summary = build_summary(results)

    has_changes = bool(created or updated or deleted)
    if "GITHUB_OUTPUT" in os.environ:
        # Append to existing PR summary if products script already wrote it
        with open("/tmp/pr-summary.md", "a") as f:
            if summary.strip():
                f.write("\n### Locations\n\n")
                f.write(summary)
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write(f"locations_has_changes={'true' if has_changes else 'false'}\n")
    else:
        print()
        print(summary)


if __name__ == "__main__":
    main()
