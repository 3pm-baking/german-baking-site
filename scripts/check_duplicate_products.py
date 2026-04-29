#!/usr/bin/env python3
"""
Pre-commit hook: detect duplicate product slugs across content directories.

A product must exist in exactly one of: oven/, pantry/, or also-available/.
Slugs are derived by stripping the numeric ordering prefix from filenames
(e.g. "02-russian-pull-cake" -> "russian-pull-cake").
"""
import sys
from pathlib import Path

CONTENT_DIR = Path("content/products")
SEARCH_DIRS = ["oven", "pantry", "also-available"]


def normalize_slug(stem: str) -> str:
    """Strip numeric ordering prefix from a filename stem.

    e.g. "02-russian-pull-cake" -> "russian-pull-cake"
         "russian-pull-cake"    -> "russian-pull-cake"
    """
    parts = stem.split("-")
    # Drop leading numeric segment if present
    if parts[0].isdigit():
        parts = parts[1:]
    return "-".join(parts)


def collect_slugs() -> dict[str, list[Path]]:
    """Return a mapping of slug -> list of files that carry that slug."""
    slug_to_files: dict[str, list[Path]] = {}

    for search_dir in SEARCH_DIRS:
        directory = CONTENT_DIR / search_dir
        if not directory.exists():
            continue
        for f in sorted(directory.glob("*.yml")):
            slug = normalize_slug(f.stem)
            slug_to_files.setdefault(slug, []).append(f)

    return slug_to_files


def main() -> int:
    slug_to_files = collect_slugs()

    duplicates = {
        slug: paths
        for slug, paths in slug_to_files.items()
        if len(paths) > 1
    }

    if not duplicates:
        print("check-duplicate-products: OK", file=sys.stderr)
        return 0

    print("ERROR: Duplicate products found across directories!\n", file=sys.stderr)
    for slug, paths in sorted(duplicates.items()):
        print(f'  slug "{slug}" exists in:', file=sys.stderr)
        for p in paths:
            print(f"    {p}", file=sys.stderr)
        print(file=sys.stderr)

    print(
        "Remove the also-available/ entry when a product is promoted to oven/ or pantry/.\n"
        "Commit aborted.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
