#!/usr/bin/env python3
"""
Static site generator for 3pm German Baking product pages.

Reads YAML files from content/products/ and generates static HTML pages in products/
"""

import sys
from pathlib import Path
import yaml
from jinja2 import Environment, FileSystemLoader, select_autoescape

# Badge icon mappings for landing page (2-letter codes)
BADGE_ICONS = {
    "gf-option": "GF",
    "gf": "GF",
    "dairy-free-option": "DF",
    "dairy-free": "DF",
    "lf-option": "LF",
    "lf": "LF",
    "vegetarian": None,  # Hidden on landing page
}

# Badge aria labels for accessibility
BADGE_LABELS = {
    "gf-option": "Gluten-Free option available",
    "gf": "Gluten-Free",
    "dairy-free-option": "Dairy-Free option available",
    "dairy-free": "Dairy-Free",
    "lf-option": "Lactose-Free option available",
    "lf": "Lactose-Free",
    "vegetarian": "Vegetarian",
}

# Badge full names for product pages
BADGE_NAMES = {
    "gf-option": "Gluten-Free Option",
    "gf": "Gluten-Free ✓",
    "lf": "Lactose-Free ✓",
    "lf-option": "Lactose-Free Option",
    "dairy-free-option": "Dairy-Free Option",
    "dairy-free": "Dairy-Free ✓",
    "vegetarian": "Vegetarian ✓",
}


def parse_product(filepath: Path) -> dict:
    """Parse a YAML file with product data.

    Returns:
        dict with product metadata
    """
    content = filepath.read_text(encoding="utf-8")

    # Parse YAML (entire file is YAML)
    metadata = yaml.safe_load(content)

    if not metadata:
        raise ValueError(f"File {filepath} is empty or invalid YAML")

    # Validate required fields
    required = [
        "title",
        "german_name",
        "slug",
        "image",
        "description",
        "meta_description",
    ]
    missing = [f for f in required if f not in metadata]
    if missing:
        raise ValueError(
            f"File {filepath} missing required fields: {', '.join(missing)}"
        )

    # Set defaults
    if "page_title" not in metadata:
        metadata["page_title"] = f"{metadata['title']} | 3pm German Baking"

    if "og_description" not in metadata:
        metadata["og_description"] = metadata["description"]

    if "badges" not in metadata:
        metadata["badges"] = []

    if "sections" not in metadata or metadata["sections"] is None:
        metadata["sections"] = []

    return metadata


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


def build_landing_page(env, categories):
    """Generate the landing page (index.html) from template."""
    template = env.get_template("index.html")

    html = template.render(
        oven_products=categories["oven"],
        pantry_products=categories["pantry"],
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

    # Setup Jinja2
    env = Environment(
        loader=FileSystemLoader(templates_dir),
        autoescape=select_autoescape(["html", "xml"]),
    )

    print()  # Blank line

    # Build landing page
    build_landing_page(env, categories)

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
