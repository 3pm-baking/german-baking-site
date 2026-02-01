#!/usr/bin/env python3
"""
Static site generator for 3pm German Baking product pages.

Reads YAML files from content/products/ and generates static HTML pages in products/
"""

import sys
from pathlib import Path
import yaml
from jinja2 import Environment, FileSystemLoader, select_autoescape

# Badge mappings
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


def build_products():
    """Main build function."""
    # Setup paths
    base_dir = Path(__file__).parent
    content_dir = base_dir / "content" / "products"
    output_dir = base_dir / "products"
    templates_dir = base_dir / "templates"

    # Check directories exist
    if not content_dir.exists():
        print(f"Error: Content directory not found: {content_dir}")
        sys.exit(1)

    if not templates_dir.exists():
        print(f"Error: Templates directory not found: {templates_dir}")
        sys.exit(1)

    output_dir.mkdir(exist_ok=True)

    # Setup Jinja2
    env = Environment(
        loader=FileSystemLoader(templates_dir),
        autoescape=select_autoescape(["html", "xml"]),
    )
    template = env.get_template("product.html")

    # Find all YAML files
    yaml_files = sorted(content_dir.glob("*.yml"))

    if not yaml_files:
        print(f"Warning: No YAML files found in {content_dir}")
        return

    print("Building 3pm German Baking product pages...\n")

    built_count = 0
    errors = []

    for yaml_file in yaml_files:
        try:
            # Parse YAML file
            product_data = parse_product(yaml_file)

            # Render template
            html = template.render(page=product_data, badge_names=BADGE_NAMES)

            # Write output file
            output_file = output_dir / f"{product_data['slug']}.html"
            output_file.write_text(html, encoding="utf-8")

            print(f"✓ {yaml_file.name} → products/{output_file.name}")
            built_count += 1

        except Exception as e:
            error_msg = f"✗ {yaml_file.name}: {str(e)}"
            print(error_msg)
            errors.append(error_msg)

    print(f"\nBuild complete! {built_count} products generated.")

    if errors:
        print(f"\n{len(errors)} error(s) occurred:")
        for error in errors:
            print(f"  {error}")
        sys.exit(1)


if __name__ == "__main__":
    build_products()
