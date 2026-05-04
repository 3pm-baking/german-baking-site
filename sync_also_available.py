#!/usr/bin/env python3
"""
Sync 'Also Available' items from local market/recipe data.

Reads all market session files from the sibling expenses repo to collect
every recipe name ever sold, then writes YAML files into
content/products/also-available/ for each item not already covered by a
full product card on the site.

Existing files are PRESERVED — descriptions you have manually edited will
not be overwritten. Only new items (not yet in also-available/) are created.

Usage:
    uv run python sync_also_available.py

Requires the expenses repo to be present at ../expenses/ relative to this
script (i.e. a sibling directory of the baking site repo).
"""

from pathlib import Path
import yaml

# ---------------------------------------------------------------------------
# Exclusion list — recipe names to never add to "Also Available".
# Covers items that already have a full product card, pantry items, and
# anything explicitly skipped.
# ---------------------------------------------------------------------------
EXCLUDED: set[str] = {
    # Full product cards on the site
    "German Cheese Cake",
    "Russian Pull Cake",
    "Russischer Zupfkuchen",
    "Lemon Cake",
    "Spinach Tartlets",
    # "Vegan Kraut Strudel",
    # Pantry items
    "Chocolate Pudding Powder 200g",
    "Chocolate Pudding Powder 300g",
    "Vanilla Pudding Powder 300g",
    "Vanilla Sugar 100g",
    # Explicitly skipped
    "Terrazzo Cheesecake",
    "Cake Pops",
    "Königskuchen",
    "Poppyseed Streusel Cheese Cake",
    "Vanilla Pudding Powder 200g",
}


def slugify(name: str) -> str:
    """Convert a recipe name to a filename slug."""
    return (
        name.lower()
        .replace("ö", "oe")
        .replace("ä", "ae")
        .replace("ü", "ue")
        .replace("ß", "ss")
        .replace(" ", "-")
    )


def main() -> None:
    base_dir = Path(__file__).parent
    expenses_data = base_dir.parent / "expenses" / "data"
    markets_dir = expenses_data / "markets"
    recipes_dir = expenses_data / "recipes"
    also_available_dir = base_dir / "content" / "products" / "also-available"

    if not markets_dir.exists():
        print(f"Error: markets directory not found at {markets_dir}")
        print("Make sure the expenses repo is present at ../expenses/")
        raise SystemExit(1)

    also_available_dir.mkdir(parents=True, exist_ok=True)

    # Collect all unique recipe names ever sold at markets (insertion order = first seen)
    seen: set[str] = set()
    ordered: list[str] = []
    for market_file in sorted(markets_dir.glob("2*.yaml")):
        data = yaml.safe_load(market_file.read_text(encoding="utf-8"))
        for product in (data or {}).get("products", []):
            name = product["recipe"]
            if name not in seen:
                seen.add(name)
                ordered.append(name)

    # Build lookup: recipe name → {german_name, description}
    recipe_lookup: dict[str, dict] = {}
    if recipes_dir.exists():
        for recipe_file in recipes_dir.glob("*.yaml"):
            raw = yaml.safe_load(recipe_file.read_text(encoding="utf-8"))
            if raw and "name" in raw:
                recipe_lookup[raw["name"]] = {
                    "german_name": raw.get("german") or raw.get("german_name") or "",
                    "description": raw.get("description") or "",
                }

    created = 0
    skipped_excluded = 0
    skipped_existing = 0

    for name in ordered:
        if name in EXCLUDED:
            skipped_excluded += 1
            continue

        slug = slugify(name)
        out_file = also_available_dir / f"{slug}.yml"

        if out_file.exists():
            print(f"  (exists, preserving) {out_file.name}")
            skipped_existing += 1
            continue

        info = recipe_lookup.get(name, {})
        content = f"title: {name}\n"
        if info.get("german_name"):
            content += f"german_name: {info['german_name']}\n"
        if info.get("description"):
            content += f"description: {info['description']}\n"

        out_file.write_text(content, encoding="utf-8")
        print(f"  ✓ created {out_file.name}")
        created += 1

    print(
        f"\nDone. {created} created, {skipped_existing} already existed, "
        f"{skipped_excluded} excluded."
    )
    if created:
        print("Review new files in content/products/also-available/, then run:")
        print("  uv run python build.py")


if __name__ == "__main__":
    main()
