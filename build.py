#!/usr/bin/env python3
"""
Static site generator for 3pm German Baking product pages.

Reads YAML files from content/products/ and generates static HTML pages in products/
Reads YAML files from content/locations/ and passes them to the landing page template.
"""

import re
import sys
from datetime import date
from enum import StrEnum
from pathlib import Path
import yaml
from jinja2 import Environment, FileSystemLoader, select_autoescape
from pydantic import BaseModel, field_validator, model_validator


class Badge(StrEnum):
    """Food sensitivity / dietary badges.

    Values match the CSS class suffixes used in templates
    (e.g. ``badge--gf-option``, ``badge-icon--gf``).
    """

    GF_OPTION = "gf-option"
    GF = "gf"
    DAIRY_FREE_OPTION = "dairy-free-option"
    DAIRY_FREE = "dairy-free"
    LF_OPTION = "lf-option"
    LF = "lf"
    VEGETARIAN = "vegetarian"

    @property
    def icon(self) -> str | None:
        """2-letter icon shown on the landing page product card, or None to hide."""
        return {
            Badge.GF_OPTION: "GF",
            Badge.GF: "GF",
            Badge.DAIRY_FREE_OPTION: "DF",
            Badge.DAIRY_FREE: "DF",
            Badge.LF_OPTION: "LF",
            Badge.LF: "LF",
            Badge.VEGETARIAN: None,
        }[self]

    @property
    def aria_label(self) -> str:
        """Accessible label used in ``aria-label`` / ``title`` attributes."""
        return {
            Badge.GF_OPTION: "Gluten-Free option available",
            Badge.GF: "Gluten-Free",
            Badge.DAIRY_FREE_OPTION: "Dairy-Free option available",
            Badge.DAIRY_FREE: "Dairy-Free",
            Badge.LF_OPTION: "Lactose-Free option available",
            Badge.LF: "Lactose-Free",
            Badge.VEGETARIAN: "Vegetarian",
        }[self]

    @property
    def display_name(self) -> str:
        """Full human-readable name shown on product detail pages."""
        return {
            Badge.GF_OPTION: "Gluten-Free Option",
            Badge.GF: "Gluten-Free ✓",
            Badge.DAIRY_FREE_OPTION: "Dairy-Free Option",
            Badge.DAIRY_FREE: "Dairy-Free ✓",
            Badge.LF_OPTION: "Lactose-Free Option",
            Badge.LF: "Lactose-Free ✓",
            Badge.VEGETARIAN: "Vegetarian ✓",
        }[self]


class ProductSection(BaseModel):
    title: str
    content: str
    type: str | None = None


class Product(BaseModel):
    title: str
    german_name: str
    slug: str | None = None
    image: str | None = None
    description: str
    meta_description: str | None = None
    page_title: str | None = None
    og_description: str | None = None
    price: float | None = None
    badges: list[Badge] = []
    sections: list[ProductSection] = []

    @field_validator("sections", mode="before")
    @classmethod
    def coerce_null_sections(cls, v: object) -> object:
        return v if v is not None else []

    @model_validator(mode="after")
    def set_derived_defaults(self) -> "Product":
        if self.page_title is None:
            self.page_title = f"{self.title} | 3pm German Baking"
        if self.og_description is None:
            self.og_description = self.description
        return self


class Location(BaseModel):
    name: str
    schedule: str
    address: str | None = None
    url: str | None = None
    note: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    # Computed at validation time — not read from YAML
    upcoming: bool = False
    active: bool = True
    stale: bool = False

    @model_validator(mode="after")
    def compute_status(self) -> "Location":
        if self.start_date and self.end_date:
            today = date.today()
            self.upcoming = self.start_date > today
            self.active = self.start_date <= today <= self.end_date
            self.stale = self.end_date < today
        return self


# Badge lookup dicts for templates — derived from the Badge enum so there is
# a single source of truth.
BADGE_ICONS = {b.value: b.icon for b in Badge}
BADGE_LABELS = {b.value: b.aria_label for b in Badge}
BADGE_NAMES = {b.value: b.display_name for b in Badge}


def load_also_available(content_dir: Path) -> list[dict]:
    """Load 'Also Available' items from content/products/also-available/.

    Returns:
        list of dicts with keys: title, german_name, description
    """
    also_available_dir = content_dir / "also-available"
    if not also_available_dir.exists():
        print(f"Warning: {also_available_dir} not found, skipping")
        return []

    items = []
    for yaml_file in sorted(also_available_dir.glob("*.yml")):
        raw = yaml.safe_load(yaml_file.read_text(encoding="utf-8"))
        if not raw:
            print(f"  (skipping empty file: {yaml_file.name})")
            continue
        items.append(
            {
                "title": raw["title"],
                "german_name": raw.get("german_name", ""),
                "description": raw.get("description", ""),
            }
        )

    print(f"Loaded {len(items)} item(s) for 'Also Available'")
    return items


def parse_location(filepath: Path) -> dict:
    """Parse a YAML file with farmers market / location data.

    Validates with the Location Pydantic model and computes upcoming/active/stale
    flags from start_date and end_date.

    Returns:
        dict with location metadata
    """
    raw = yaml.safe_load(filepath.read_text(encoding="utf-8"))
    if not raw:
        raise ValueError(f"File {filepath} is empty or invalid YAML")
    location = Location.model_validate(raw)
    return location.model_dump()


def load_locations(content_dir: Path) -> list:
    """Load farmers market / location data from content/locations/.

    Stale locations (past end_date) are excluded from the returned list.

    Returns:
        list of active/upcoming location dicts, sorted by filename
        (01-, 02- prefix = display order)
    """
    locations_dir = content_dir.parent / "locations"
    if not locations_dir.exists():
        print(f"Warning: {locations_dir} not found, skipping locations")
        return []

    yaml_files = sorted(locations_dir.glob("*.yml"))
    locations = []

    for yaml_file in yaml_files:
        try:
            location_data = parse_location(yaml_file)
            if location_data["stale"]:
                print(f"  (skipping stale location: {location_data['name']})")
                continue
            locations.append(location_data)
        except Exception as e:
            print(f"✗ Error loading {yaml_file.name}: {e}")

    print(f"Loaded {len(locations)} location(s) from locations/")
    return locations


def update_sitemap(base_dir: Path) -> None:
    """Update the lastmod date for all entries in sitemap.xml.

    Updates the homepage entry and all product page entries to today's date.
    """
    sitemap_path = base_dir / "sitemap.xml"
    if not sitemap_path.exists():
        print("Warning: sitemap.xml not found, skipping sitemap update")
        return

    today_str = date.today().isoformat()
    content = sitemap_path.read_text(encoding="utf-8")

    # Replace lastmod for every <url> entry on the site
    updated = re.sub(
        r"(<loc>https://germanbakingasheville\.com/[^<]*</loc>\s*<lastmod>)[^<]*(</lastmod>)",
        rf"\g<1>{today_str}\g<2>",
        content,
    )

    if updated == content:
        print("  sitemap.xml unchanged")
    else:
        sitemap_path.write_text(updated, encoding="utf-8")
        print(f"✓ sitemap.xml → all lastmod dates updated to {today_str}")


def parse_product(filepath: Path) -> dict:
    """Parse a YAML file with product data.

    Validates with the Product Pydantic model.

    Returns:
        dict with product metadata
    """
    raw = yaml.safe_load(filepath.read_text(encoding="utf-8"))
    if not raw:
        raise ValueError(f"File {filepath} is empty or invalid YAML")
    product = Product.model_validate(raw)
    return product.model_dump(mode="json")


def load_products_by_category(content_dir: Path) -> dict:
    """
    Load products from oven/ and pantry/ subdirectories.

    Returns:
        {
            'oven': [product1, product2, ...],
            'pantry': [product3, product4, ...]
        }
    Products sorted by filename (01-, 02- prefix determines order)
    """
    categories = {}

    for category in ["oven", "pantry"]:
        category_dir = content_dir / category
        if not category_dir.exists():
            print(f"Warning: {category_dir} not found, skipping")
            categories[category] = []
            continue

        # Sort by filename (number prefix gives us order)
        yaml_files = sorted(category_dir.glob("*.yml"))
        products = []

        for yaml_file in yaml_files:
            try:
                product_data = parse_product(yaml_file)
                products.append(product_data)
            except Exception as e:
                print(f"✗ Error loading {yaml_file.name}: {e}")

        categories[category] = products
        print(f"Loaded {len(products)} products from {category}/")

    return categories


def build_landing_page(env, categories, locations, market_items):
    """Generate the landing page (index.html) from template."""
    template = env.get_template("index.html")

    html = template.render(
        oven_products=categories["oven"],
        oven_listed_only=market_items,
        pantry_products=categories["pantry"],
        locations=locations,
        badge_icons=BADGE_ICONS,
        badge_labels=BADGE_LABELS,
    )

    # Write to root directory
    output_file = Path(__file__).parent / "index.html"
    output_file.write_text(html, encoding="utf-8")

    print("✓ templates/index.html → index.html")


def build_product_pages(env, categories):
    """Generate individual product detail pages."""
    output_dir = Path(__file__).parent / "products"
    output_dir.mkdir(exist_ok=True)

    template = env.get_template("product.html")

    # Flatten into single list for product page generation
    all_products = categories["oven"] + categories["pantry"]

    if not all_products:
        print("Warning: No products found")
        return 0, []

    built_count = 0
    errors = []

    for product_data in all_products:
        try:
            # Render template
            html = template.render(page=product_data, badge_names=BADGE_NAMES)

            # Write output file
            output_file = output_dir / f"{product_data['slug']}.html"
            output_file.write_text(html, encoding="utf-8")

            print(f"✓ {product_data['slug']}.yml → products/{output_file.name}")
            built_count += 1

        except Exception as e:
            error_msg = f"✗ {product_data['slug']}: {str(e)}"
            print(error_msg)
            errors.append(error_msg)

    return built_count, errors


def build_all():
    """Main build function - generates landing page and product pages."""
    # Setup paths
    base_dir = Path(__file__).parent
    content_dir = base_dir / "content" / "products"
    templates_dir = base_dir / "templates"

    # Check directories exist
    if not content_dir.exists():
        print(f"Error: Content directory not found: {content_dir}")
        sys.exit(1)

    if not templates_dir.exists():
        print(f"Error: Templates directory not found: {templates_dir}")
        sys.exit(1)

    print("Building 3pm German Baking website...\n")

    # Load products by category
    categories = load_products_by_category(content_dir)

    # Load farmers market locations
    locations = load_locations(content_dir)

    # Setup Jinja2
    env = Environment(
        loader=FileSystemLoader(templates_dir),
        autoescape=select_autoescape(["html", "xml"]),
    )

    # Load "Also Available" items
    market_items = load_also_available(content_dir)

    print()  # Blank line

    # Build landing page
    build_landing_page(env, categories, locations, market_items)

    # Update sitemap lastmod for index.html
    update_sitemap(base_dir)

    # Build product pages
    built_count, errors = build_product_pages(env, categories)

    print(f"\nBuild complete! Landing page + {built_count} product pages generated.")

    if errors:
        print(f"\n{len(errors)} error(s) occurred:")
        for error in errors:
            print(f"  {error}")
        sys.exit(1)


if __name__ == "__main__":
    build_all()
