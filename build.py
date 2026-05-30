#!/usr/bin/env python3
"""
Static site generator for 3pm German Baking.

Reads YAML files from content/products/ and generates static HTML pages in products/
Reads YAML files from content/locations/ and passes them to the landing page template.
Reads markdown files from content/blog/ and generates blog/index.html + blog/*.html
"""

import os
import re
import sys
from datetime import UTC, date, datetime
from email.utils import format_datetime
from enum import StrEnum
from pathlib import Path

import markdown as md
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
    VEGAN = "vegan"

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
            Badge.VEGAN: "V",
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
            Badge.VEGAN: "Vegan",
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
            Badge.VEGAN: "Vegan ✓",
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
    def set_derived_defaults(self) -> Product:
        if self.page_title is None:
            self.page_title = f"{self.title} | 3pm German Baking"
        if self.og_description is None:
            self.og_description = self.description
        return self


def format_schedule_display(sched: dict) -> str | None:
    """Derive a human-readable schedule string from structured schedule data.

    Handles ``interval_weeks`` for frequency prefixes (e.g. "Every other Saturday"
    vs "Saturdays") and formats dates/times in the style used by farmers markets.
    Returns ``None`` if the data is insufficient to generate a string.
    """
    day = sched.get("day_of_week", "")
    interval = sched.get("frequency", {}).get("interval_weeks", 1)

    if not day:
        return None

    # Day prefix — pluralize for weekly, prefix for biweekly
    if interval == 1:
        day_prefix = f"{day}s"
    elif interval == 2:
        day_prefix = f"Every other {day}"
    else:
        day_prefix = f"Every {interval} {day}s"

    # Parse ISO dates from the raw YAML values (still strings at this point)
    start = end = None
    try:
        if sched.get("start_date"):
            start = datetime.strptime(str(sched["start_date"]), "%Y-%m-%d")
    except ValueError, TypeError:
        pass
    try:
        if sched.get("end_date"):
            end = datetime.strptime(str(sched["end_date"]), "%Y-%m-%d")
    except ValueError, TypeError:
        pass

    if not start and not end:
        return None

    def _fmt_date(d: datetime) -> str:
        return d.strftime("%B %d").replace(" 0", " ")

    if start and end:
        date_str = f"{_fmt_date(start)} – {_fmt_date(end)}"
    elif start:
        date_str = f"Starting {_fmt_date(start)}"
    else:
        date_str = f"Through {_fmt_date(end)}"

    # Format times — handles both "15:30" and sexagesimal 540 (= 09:00)
    def _fmt_time(t: object) -> str | None:
        if t is None:
            return None
        raw = str(t)
        # PyYAML 1.1 parses 09:00 as sexagesimal → integer 540
        if raw.lstrip("-").isdigit():
            mins = int(raw)
            raw = f"{mins // 60:02d}:{mins % 60:02d}"
        parts = raw.split(":")
        if len(parts) != 2:
            return None
        try:
            h, m = int(parts[0]), int(parts[1])
        except ValueError:
            return None
        ampm = "am" if h < 12 else "pm"
        h12 = h if 1 <= h <= 12 else (h - 12 if h > 12 else 12)
        if h == 0:
            h12 = 12
        return f"{h12}:{m:02d}{ampm}" if m else f"{h12}{ampm}"

    start_time = _fmt_time(sched.get("start_time"))
    end_time = _fmt_time(sched.get("end_time"))
    time_str = f" · {start_time}–{end_time}" if start_time and end_time else ""

    return f"{day_prefix}, {date_str}{time_str}"


class Location(BaseModel):
    name: str
    schedule: str | dict | None = None
    schedule_display: str | None = None
    address: str | None = None
    url: str | None = None
    note: str | None = None
    notes: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    # Computed at validation time — not read from YAML
    upcoming: bool = False
    active: bool = True
    stale: bool = False

    @model_validator(mode="before")
    @classmethod
    def normalize(cls, data: dict) -> dict:
        # Normalize notes -> note
        if "notes" in data and "note" not in data:
            data["note"] = data.pop("notes")

        # Strip redundant note prefixes that duplicate location name content
        if data.get("note") and data.get("name"):
            name = data["name"]
            note = data["note"]
            for match in re.finditer(r"\(([^)]+)\)", name):
                prefix = match.group(1).lower()
                if note.lower().startswith(prefix):
                    stripped = note[len(match.group(1)) :].lstrip(" —:,-–")
                    data["note"] = stripped if stripped else None
                    break

        # Handle structured schedule (new format)
        sched = data.get("schedule")
        if isinstance(sched, dict):
            # Extract dates from nested schedule if not already top-level
            if "start_date" not in data and sched.get("start_date"):
                data["start_date"] = sched["start_date"]
            if "end_date" not in data and sched.get("end_date"):
                data["end_date"] = sched["end_date"]
            # Derive display string from structured data (with fallback)
            derived = format_schedule_display(sched)
            if derived:
                data["schedule"] = derived
            elif data.get("schedule_display"):
                data["schedule"] = data["schedule_display"]
            else:
                data["schedule"] = ""

        # Suppress note when it duplicates the schedule text
        if data.get("note") and data.get("schedule"):
            if data["note"].strip().lower() in data["schedule"].lower():
                data["note"] = None

        return data

    @model_validator(mode="after")
    def compute_status(self) -> Location:
        if self.start_date and self.end_date:
            today = date.today()
            self.upcoming = self.start_date > today
            self.active = self.start_date <= today <= self.end_date
            self.stale = self.end_date < today
        return self


class BlogPost(BaseModel):
    title: str
    date: date
    slug: str | None = None
    author: str = "3pm German Baking Team"
    excerpt: str
    image: str | None = None
    meta_description: str | None = None
    page_title: str | None = None
    og_description: str | None = None
    hide_featured_image: bool = False
    updated_date: date | None = None
    alt_text: str | None = None
    tags: list[str] = []
    related_products: list[str] = []
    word_count: int = 0
    reading_time: int = 0
    content_html: str = ""
    display_date: str = ""

    @model_validator(mode="after")
    def set_derived_defaults(self) -> BlogPost:
        if self.page_title is None:
            self.page_title = f"{self.title} | 3pm German Baking Blog"
        if self.og_description is None:
            self.og_description = self.excerpt
        if self.slug is None:
            slug = re.sub(r"[^a-z0-9\s-]", "", self.title.lower())
            slug = re.sub(r"\s+", "-", slug)
            self.slug = slug.strip("-")
        self.display_date = self.date.strftime("%B %d, %Y")
        if self.author not in AUTHOR_EMAILS:
            raise ValueError(f"Unknown author '{self.author}' — add email to AUTHOR_EMAILS in build.py")
        text = re.sub(r"<[^>]+>", "", self.content_html)
        self.word_count = len(text.split())
        self.reading_time = max(1, (self.word_count + 199) // 200)
        return self


# Badge lookup dicts for templates — derived from the Badge enum so there is
# a single source of truth.
BADGE_ICONS = {b.value: b.icon for b in Badge}
BADGE_LABELS = {b.value: b.aria_label for b in Badge}
BADGE_NAMES = {b.value: b.display_name for b in Badge}

# Author emails for RSS feed attribution (single source of truth)
AUTHOR_EMAILS = {
    "William": "william@germanbakingasheville.com",
    "Mary": "mary@germanbakingasheville.com",
    "3pm German Baking Team": "info@germanbakingasheville.com",
}


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
        if raw.get("website") is False:
            print(f"  (skipping website: false — {yaml_file.name})")
            continue
        items.append(
            {
                "title": raw["title"],
                "german_name": raw.get("german_name", ""),
                "description": raw.get("description", ""),
                "badges": raw.get("badges", []),
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


def load_blog_posts(content_dir: Path) -> list[dict]:
    """Load blog posts from content/blog/*.md.

    Each file has YAML frontmatter followed by markdown content.
    Posts dated in the future are excluded unless PREVIEW=true is set.
    Posts are returned sorted by date (newest first).

    Returns:
        list of blog post dicts
    """
    preview = os.environ.get("PREVIEW", "").lower() in ("1", "true", "yes")
    blog_dir = content_dir.parent / "blog"
    if not blog_dir.exists():
        print("Warning: content/blog/ not found, skipping blog")
        return []

    raw_posts = []
    for md_file in sorted(blog_dir.glob("*.md"), reverse=True):
        raw_text = md_file.read_text(encoding="utf-8")
        parts = raw_text.split("---", 2)
        if len(parts) < 3:
            print(f"  (skipping {md_file.name}: no valid frontmatter)")
            continue

        frontmatter_raw = parts[1].strip()
        markdown_body = parts[2].strip()

        frontmatter = yaml.safe_load(frontmatter_raw)
        if not frontmatter:
            print(f"  (skipping empty file: {md_file.name})")
            continue

        frontmatter["content_html"] = md.markdown(markdown_body, extensions=["extra"])
        post = BlogPost.model_validate(frontmatter)
        raw_posts.append(post)

    if not preview:
        today = date.today()
        skipped = [p for p in raw_posts if p.date > today]
        for p in skipped:
            print(f"  (skipping future post: {p.title} [{p.date}])")
        raw_posts = [p for p in raw_posts if p.date <= today]
    else:
        print("  PREVIEW mode: including future-dated posts")

    posts = [p.model_dump(mode="json") for p in raw_posts]
    posts.sort(key=lambda p: p["date"], reverse=True)
    print(f"Loaded {len(posts)} blog post(s) from blog/")
    return posts


def _rfc822_filter(value: str) -> str:
    """Jinja2 filter: convert ISO date/datetime string to RFC 822 format."""
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return format_datetime(dt)


def build_rss_feed(env: Environment, posts: list[dict]) -> None:
    """Generate the RSS 2.0 feed (feed.xml) from blog posts."""
    template = env.get_template("rss.xml")
    build_date = datetime.now(UTC).isoformat()
    enriched_posts = [{**post, "author_email": AUTHOR_EMAILS.get(post["author"])} for post in posts]
    xml = template.render(posts=enriched_posts, build_date=build_date)

    output_file = Path(__file__).parent / "feed.xml"
    if output_file.exists():
        old_xml = output_file.read_text(encoding="utf-8")
        # Strip the timestamp-only diff (lastBuildDate) from comparison
        old_stripped = re.sub(r"\s*<lastBuildDate>.*?</lastBuildDate>", "", old_xml)
        new_stripped = re.sub(r"\s*<lastBuildDate>.*?</lastBuildDate>", "", xml)
        if old_stripped == new_stripped:
            print(f"  feed.xml unchanged ({len(posts[:20])} post(s))")
            return
    output_file.write_text(xml, encoding="utf-8")
    print(f"✓ templates/rss.xml → feed.xml ({len(posts[:20])} post(s))")


def build_blog_index(env: Environment, posts: list[dict]) -> None:
    """Generate the blog listing page (blog/index.html)."""
    template = env.get_template("blog-index.html")
    html = template.render(posts=posts)

    output_dir = Path(__file__).parent / "blog"
    output_dir.mkdir(exist_ok=True)
    output_file = output_dir / "index.html"
    output_file.write_text(html, encoding="utf-8")
    print("✓ templates/blog-index.html → blog/index.html")


def build_blog_pages(env: Environment, posts: list[dict]) -> tuple[int, list]:
    """Generate individual blog post pages in blog/.

    Cleans up stale generated HTML files before building
    (e.g. leftover pages from a PREVIEW build that are no longer published).
    """
    output_dir = Path(__file__).parent / "blog"
    output_dir.mkdir(exist_ok=True)

    for html_file in output_dir.glob("*.html"):
        if html_file.name == "index.html":
            continue
        html_file.unlink()

    template = env.get_template("blog-post.html")
    built_count = 0
    errors = []

    for post in posts:
        try:
            html = template.render(post=post)
            output_file = output_dir / f"{post['slug']}.html"
            output_file.write_text(html, encoding="utf-8")
            print(f"✓ {post['slug']}.md → blog/{output_file.name}")
            built_count += 1
        except Exception as e:
            error_msg = f"✗ {post['slug']}: {str(e)}"
            print(error_msg)
            errors.append(error_msg)

    return built_count, errors


def update_sitemap(
    base_dir: Path,
    product_slugs: list[str] | None = None,
    blog_posts: list[dict] | None = None,
) -> None:
    """Update lastmod dates and auto-generate sitemap entries.

    Updates the homepage lastmod to today's date.
    If product_slugs is provided, replaces content between <!-- PRODUCT_START -->
    and <!-- PRODUCT_END --> markers with generated product entries.
    If blog_posts is provided, replaces content between <!-- BLOG_START -->
    and <!-- BLOG_END --> markers with generated blog entries.
    """
    sitemap_path = base_dir / "sitemap.xml"
    if not sitemap_path.exists():
        print("Warning: sitemap.xml not found, skipping sitemap update")
        return

    today_str = date.today().isoformat()
    content = sitemap_path.read_text(encoding="utf-8")

    # Update homepage lastmod
    updated = re.sub(
        r"(<loc>https://germanbakingasheville\.com/</loc>\s*<lastmod>)[^<]*(</lastmod>)",
        rf"\g<1>{today_str}\g<2>",
        content,
    )

    if product_slugs is not None:
        product_entries = _generate_product_sitemap_entries(product_slugs, today_str)
        if "<!-- PRODUCT_START -->" in updated and "<!-- PRODUCT_END -->" in updated:
            updated = re.sub(
                r"<!-- PRODUCT_START -->.*<!-- PRODUCT_END -->",
                f"<!-- PRODUCT_START -->\n{product_entries}\n  <!-- PRODUCT_END -->",
                updated,
                flags=re.DOTALL,
            )
            print(f"  sitemap.xml → product entries regenerated ({len(product_slugs)} product(s))")
        else:
            print("  Warning: PRODUCT_START/PRODUCT_END markers not found in sitemap.xml")

    if blog_posts is not None:
        blog_entries = _generate_blog_sitemap_entries(blog_posts, today_str)
        if "<!-- BLOG_START -->" in updated and "<!-- BLOG_END -->" in updated:
            updated = re.sub(
                r"<!-- BLOG_START -->.*<!-- BLOG_END -->",
                f"<!-- BLOG_START -->\n{blog_entries}\n  <!-- BLOG_END -->",
                updated,
                flags=re.DOTALL,
            )
            print(f"  sitemap.xml → blog entries updated ({len(blog_posts)} post(s))")
        else:
            print("  Warning: BLOG_START/BLOG_END markers not found in sitemap.xml")

    if updated == content:
        print("  sitemap.xml unchanged")
    else:
        sitemap_path.write_text(updated, encoding="utf-8")
        print(f"✓ sitemap.xml → all lastmod dates updated to {today_str}")


def _generate_product_sitemap_entries(slugs: list[str], today_str: str) -> str:
    """Generate sitemap <url> entries for all product pages."""
    entries = []
    for slug in sorted(slugs):
        entries.append("  <url>")
        entries.append(f"    <loc>https://germanbakingasheville.com/products/{slug}.html</loc>")
        entries.append(f"    <lastmod>{today_str}</lastmod>")
        entries.append("    <changefreq>monthly</changefreq>")
        entries.append("    <priority>0.8</priority>")
        entries.append("  </url>")
    return "\n".join(entries)


def _generate_blog_sitemap_entries(posts: list[dict], today_str: str) -> str:
    """Generate sitemap <url> entries for blog index and all blog posts."""
    entries = [
        "  <url>",
        "    <loc>https://germanbakingasheville.com/blog/</loc>",
        f"    <lastmod>{today_str}</lastmod>",
        "    <changefreq>weekly</changefreq>",
        "    <priority>0.7</priority>",
        "  </url>",
    ]
    for post in posts:
        entries.append("  <url>")
        entries.append(f"    <loc>https://germanbakingasheville.com/blog/{post['slug']}.html</loc>")
        entries.append(f"    <lastmod>{today_str}</lastmod>")
        entries.append("    <changefreq>monthly</changefreq>")
        entries.append("    <priority>0.7</priority>")
        entries.append("  </url>")
    return "\n".join(entries)


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


def build_landing_page(env, categories, locations, market_items, blog_posts):
    """Generate the landing page (index.html) from template."""
    template = env.get_template("index.html")

    recent_posts = blog_posts[:3] if blog_posts else []

    html = template.render(
        oven_products=categories["oven"],
        oven_listed_only=market_items,
        pantry_products=categories["pantry"],
        locations=locations,
        badge_icons=BADGE_ICONS,
        badge_labels=BADGE_LABELS,
        recent_posts=recent_posts,
    )

    # Write to root directory
    output_file = Path(__file__).parent / "index.html"
    output_file.write_text(html, encoding="utf-8")

    print("✓ templates/index.html → index.html")


def build_product_pages(env, categories, product_to_blog_posts=None):
    """Generate individual product detail pages.

    If *product_to_blog_posts* is provided (a dict mapping product slug → list
    of blog post dicts), attaches ``related_blog_posts`` to each product so
    templates can render "Related Blog Posts" links.
    """
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
            # Resolve related blog posts from blog frontmatter mapping
            related = (product_to_blog_posts or {}).get(product_data["slug"], [])
            product_data["related_blog_posts"] = related

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

    # Load blog posts
    blog_posts = load_blog_posts(content_dir)

    # Collect product slugs for sitemap
    all_product_slugs = [p["slug"] for p in categories.get("oven", []) + categories.get("pantry", [])]

    # Build product → blog post mapping from blog frontmatter (related_products)
    # so product pages can show "Related Blog Posts" without declaring it in product YAML.
    product_to_blog_posts = {}
    for post in blog_posts:
        for product_slug in post.get("related_products", []):
            product_to_blog_posts.setdefault(product_slug, []).append(post)

    # Setup Jinja2
    env = Environment(
        loader=FileSystemLoader(templates_dir),
        autoescape=select_autoescape(["html", "xml"]),
    )
    env.filters["rfc822"] = _rfc822_filter

    # Load "Also Available" items
    market_items = load_also_available(content_dir)

    print()  # Blank line

    # Build landing page
    build_landing_page(env, categories, locations, market_items, blog_posts)

    # Update sitemap lastmod for homepage and regenerate product entries
    update_sitemap(base_dir, product_slugs=all_product_slugs)

    # Build product pages
    built_count, errors = build_product_pages(env, categories, product_to_blog_posts=product_to_blog_posts)

    # Build blog
    build_blog_index(env, blog_posts)
    blog_count, blog_errors = build_blog_pages(env, blog_posts)
    build_rss_feed(env, blog_posts)

    # Update sitemap with blog entries
    update_sitemap(base_dir, product_slugs=all_product_slugs, blog_posts=blog_posts)

    print(f"\nBuild complete! Landing page + {built_count} product pages + {blog_count} blog posts generated.")

    total_errors = errors + blog_errors
    if total_errors:
        print(f"\n{len(total_errors)} error(s) occurred:")
        for error in total_errors:
            print(f"  {error}")
        sys.exit(1)


if __name__ == "__main__":
    build_all()
