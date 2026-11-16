"""One-off migration of www.maltbyscouts.org (Scout Websites / WordPress) into Zola content.

- Pages come from the open WordPress REST API (/wp-json/wp/v2/pages).
- News is a custom post type that isn't exposed over REST, so articles are scraped from
  the HTML pages listed in /news-sitemap.xml, and their tags from the /news_tag/<tag> listings.
- Images under /wp-content/uploads/ are downloaded to site/static/images/uploads/ and links rewritten.

Usage (from the repo root):
    python -m venv .venv && .venv/Scripts/pip install -r tools/migrate/requirements.txt
    .venv/Scripts/python tools/migrate/migrate.py [--out site]

Re-running overwrites generated files. Pages listed in HAND_WRITTEN are never touched.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup
from markdownify import markdownify

ORIGIN = "https://www.maltbyscouts.org"
UA = "Mozilla/5.0 (compatible; maltbyscouts-site-migration)"

# WordPress pages we deliberately drop (theme placeholders, empty pages, the old members area).
SKIP_PAGES = {
    "/",  # home is hand-written (content/_index.md)
    "/blog",
    "/sitemap",
    "/news",
    "/news/archive",
    "/events",
    "/members-area",
    "/members-area/registration",
    "/network-18-to-25",  # empty page; nav links to the District's Network page instead
    "/contact",  # hand-written: new form
    "/join",  # hand-written: new form
}

session = requests.Session()
session.headers["User-Agent"] = UA


def get(url: str) -> requests.Response:
    for attempt in range(3):
        r = session.get(url, timeout=30)
        if r.status_code < 500:
            r.raise_for_status()
            return r
        time.sleep(2 * (attempt + 1))
    r.raise_for_status()
    return r


def path_of(url: str) -> str:
    p = urlparse(url).path.rstrip("/")
    return p or "/"


class Images:
    def __init__(self, static_dir: Path):
        self.dir = static_dir / "images" / "uploads"
        self.dir.mkdir(parents=True, exist_ok=True)

    def local(self, src: str) -> str:
        """Download an /wp-content/uploads/ file (once) and return its site-relative URL."""
        name = Path(urlparse(src).path).name
        dest = self.dir / name
        if not dest.exists():
            try:
                dest.write_bytes(get(src if src.startswith("http") else ORIGIN + src).content)
            except requests.HTTPError as e:
                print(f"  ! image failed {src}: {e}", file=sys.stderr)
                return src
        return f"/images/uploads/{name}"


def clean_html(fragment: str, images: Images) -> BeautifulSoup:
    s = BeautifulSoup(fragment, "html.parser")
    for t in s.select("script, style, noscript, form, .gform_wrapper, .btn_row:empty"):
        t.decompose()
    for img in s.find_all("img"):
        src = img.get("src", "")
        # prefer the largest srcset candidate, then strip WP's -300x200 size suffixes
        if img.get("srcset"):
            cands = [c.strip().split(" ")[0] for c in img["srcset"].split(",") if c.strip()]
            src = cands[-1] if cands else src
        if "/wp-content/uploads/" in src:
            img["src"] = images.local(src)
        for a in ("srcset", "sizes", "class", "width", "height", "decoding", "loading", "style"):
            img.attrs.pop(a, None)
    for a in s.find_all("a"):
        # Image "cards" (<a><div><img></div><h4>Text</h4></a>) would become Markdown links that span
        # blank lines, which break. Flatten them to <a><img> Text</a>.
        if a.find("img") and a.find(["div", "p", "h1", "h2", "h3", "h4", "h5", "h6"]):
            img, text = a.find("img").extract(), a.get_text(" ", strip=True)
            a.clear()
            a.append(img)
            if text:
                a.append(" " + text)
        href = a.get("href", "")
        if "/wp-content/uploads/" in href:
            a["href"] = images.local(href)
        elif href.startswith(ORIGIN):
            a["href"] = (urlparse(href).path or "/") + (f"#{urlparse(href).fragment}" if urlparse(href).fragment else "")
        a.attrs.pop("target", None)
        a.attrs.pop("rel", None)
    return s


def to_markdown(s: BeautifulSoup) -> str:
    md = markdownify(str(s), heading_style="ATX", bullets="-", strip=["div", "span", "section"])
    md = md.replace(" ", " ")
    md = re.sub(r"[ \t]+\n", "\n", md)
    md = re.sub(r"\n{3,}", "\n\n", md)
    return md.strip() + "\n"


def toml_str(v: str) -> str:
    return json.dumps(v, ensure_ascii=False)


def front_matter(title: str, extra_lines: list[str] | None = None, body: str = "") -> str:
    lines = ["+++", f"title = {toml_str(title)}"] + (extra_lines or []) + ["+++", ""]
    return "\n".join(lines) + body


# ---------------------------------------------------------------- pages

def migrate_pages(content: Path, images: Images) -> None:
    pages = get(f"{ORIGIN}/wp-json/wp/v2/pages?per_page=100").json()
    by_path = {path_of(p["link"]): p for p in pages}
    for path, p in sorted(by_path.items()):
        if path in SKIP_PAGES or p["status"] != "publish":
            continue
        title = html.unescape(p["title"]["rendered"]).replace("�", "½")
        soup = clean_html(p["content"]["rendered"], images)
        extra: list[str] = [f"weight = {p.get('menu_order', 0)}"]
        tpl = None

        if path == "/about-us":
            # Volunteer cards -> front matter so the template can lay them out.
            members = []
            for m in soup.select(".member"):
                name = m.select_one(".info h5").get_text(strip=True)
                role = m.select_one(".info span").get_text(" ", strip=True)
                members.append((name, role))
                m.decompose()
            tpl = "about.html"
            extra += ["", "[extra]", "members = ["]
            extra += [f"  {{ name = {toml_str(n)}, role = {toml_str(r)} }}," for n, r in members]
            extra += ["]"]
            for iframe in soup.find_all("iframe"):  # embedded Facebook post etc.
                iframe.decompose()

        if tpl:
            extra.insert(0, f'template = "{tpl}"')

        # Child pages exist for these, so they become Zola sections (_index.md).
        has_children = any(other.startswith(path + "/") for other in by_path if other != path)
        rel = path.lstrip("/")
        out = content / rel / "_index.md" if has_children else content / f"{rel}.md"
        if has_children:
            extra = [e for e in extra if not e.startswith("template")]
            if tpl:
                extra.insert(0, f'template = "{tpl}"')
            extra.insert(0, "sort_by = \"weight\"")
            extra = ["render = true"] + extra
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(front_matter(title, extra, to_markdown(soup)), encoding="utf-8")
        print(f"page  {path} -> {out.relative_to(content.parent)}")


# ---------------------------------------------------------------- news

def news_tags() -> dict[str, list[str]]:
    """slug -> [tag, ...] read from the news cards on /news and the home page.

    (The /news_tag/<tag> pages just redirect to the home page, and article pages don't show tags.)
    """
    tags: dict[str, list[str]] = {}
    for url in (f"{ORIGIN}/news", f"{ORIGIN}/"):
        page = BeautifulSoup(get(url).text, "html.parser")
        for card in page.select("a.article.block"):
            slug = path_of(card["href"]).split("/")[-1]
            tags.setdefault(slug, [t.get_text(strip=True) for t in card.select(".tag")])
    return tags


def migrate_news(content: Path, images: Images) -> None:
    out_dir = content / "news" / "article"
    out_dir.mkdir(parents=True, exist_ok=True)
    tags = news_tags()
    sm = get(f"{ORIGIN}/news-sitemap.xml").text
    for url in re.findall(r"<loc>([^<]+)</loc>", sm):
        path = path_of(url)
        if path.count("/") < 3:
            continue  # /news/article index
        slug = path.split("/")[-1]
        page = BeautifulSoup(get(url).text, "html.parser")
        title = page.select_one(".post__title").get_text(strip=True)
        details = [s.get_text(strip=True) for s in page.select(".post__details span")]
        date_txt = next((d.split(":", 1)[1].strip() for d in details if d.startswith("Date")), "")
        author = next((d.split(":", 1)[1].strip() for d in details if d.startswith("Author")), "")
        date = datetime.strptime(re.sub(r"(\d+)(st|nd|rd|th)", r"\1", date_txt), "%d %b %Y").date()
        og = page.find("meta", property="og:image")
        image = images.local(og["content"]) if og and "/wp-content/uploads/" in og.get("content", "") else ""
        desc = page.find("meta", property="og:description")
        summary = html.unescape(desc["content"]).replace("[…]", "…").strip() if desc else ""
        body = clean_html(str(page.select_one(".playground")), images)

        fm = [f"date = {date.isoformat()}"]
        if summary:
            fm.append(f"description = {toml_str(summary)}")
        fm += ["", "[taxonomies]", f"news_tag = {json.dumps(tags.get(slug, []))}", "", "[extra]"]
        if author:
            fm.append(f"author = {toml_str(author)}")
        if image:
            fm.append(f"image = {toml_str(image)}")
        (out_dir / f"{slug}.md").write_text(front_matter(title, fm, to_markdown(body)), encoding="utf-8")
        print(f"news  {date} {slug}  tags={tags.get(slug, [])}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="site", help="Zola site root (default: site)")
    ap.add_argument("--only", choices=["pages", "news"], help="migrate just one kind")
    a = ap.parse_args()
    root = Path(a.out)
    content, images = root / "content", Images(root / "static")
    if a.only in (None, "pages"):
        migrate_pages(content, images)
    if a.only in (None, "news"):
        migrate_news(content, images)


if __name__ == "__main__":
    main()
