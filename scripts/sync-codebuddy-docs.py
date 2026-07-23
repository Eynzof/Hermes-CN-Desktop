#!/usr/bin/env python3
"""Mirror the public CodeBuddy Enterprise and WorkBuddy docs as Markdown.

Dependencies: ``pip install requests beautifulsoup4 lxml markdownify``.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import date
from pathlib import Path, PurePosixPath
from urllib.parse import quote, unquote, urljoin, urlsplit

import requests
from bs4 import BeautifulSoup, Tag
from markdownify import ATX, MarkdownConverter


BASE_URL = "https://www.codebuddy.cn"
SECTIONS = {
    "enterprise": "/docs/enterprise/Overview",
    "workbuddy": "/docs/workbuddy/Overview",
}


@dataclass(frozen=True)
class Page:
    section: str
    path: str
    title: str

    @property
    def url(self) -> str:
        return urljoin(BASE_URL, self.path)


class CodeBuddyMarkdownConverter(MarkdownConverter):
    def convert_pre(self, el: Tag, text: str, parent_tags: set[str]) -> str:
        code = el.find("code")
        if code is None:
            return super().convert_pre(el, text, parent_tags)

        language = ""
        for class_name in [*el.get("class", []), *code.get("class", [])]:
            if class_name.startswith("language-"):
                language = class_name.removeprefix("language-")
                break

        content = code.get_text().rstrip("\n")
        fence = "```"
        if "```" in content:
            fence = "````"
        return f"\n\n{fence}{language}\n{content}\n{fence}\n\n"

    def convert_div(self, el: Tag, text: str, parent_tags: set[str]) -> str:
        classes = set(el.get("class", []))
        if "custom-block" not in classes:
            return text

        kind = next(
            (item.upper() for item in classes if item in {"tip", "warning", "danger", "info", "note"}),
            "NOTE",
        )
        title_element = el.select_one(".custom-block-title")
        title = title_element.get_text(" ", strip=True) if title_element else kind
        lines = text.strip().splitlines()
        if lines and lines[0].strip() == title:
            lines.pop(0)
        while lines and not lines[0].strip():
            lines.pop(0)
        quoted = [f"> **{title}**", ">"]
        quoted.extend(">" if not line else f"> {line}" for line in lines)
        return "\n\n" + "\n".join(quoted) + "\n\n"

    def convert_video(self, el: Tag, text: str, parent_tags: set[str]) -> str:
        source = el.get("src")
        if not source:
            nested_source = el.find("source", src=True)
            source = nested_source.get("src") if nested_source else None
        if not source:
            return text
        label = el.get("title") or "查看演示视频"
        return f"\n\n[{label}]({source})\n\n"

    def convert_audio(self, el: Tag, text: str, parent_tags: set[str]) -> str:
        source = el.get("src")
        if not source:
            nested_source = el.find("source", src=True)
            source = nested_source.get("src") if nested_source else None
        if not source:
            return text
        label = el.get("title") or "播放音频"
        return f"\n\n[{label}]({source})\n\n"

    def convert_source(self, el: Tag, text: str, parent_tags: set[str]) -> str:
        return ""


def fetch(session: requests.Session, url: str) -> str:
    response = session.get(url, timeout=45)
    response.raise_for_status()
    response.encoding = response.apparent_encoding or "utf-8"
    return response.text


def discover_pages(session: requests.Session) -> list[Page]:
    pages: list[Page] = []
    seen: set[str] = set()

    for section, entry_path in SECTIONS.items():
        soup = BeautifulSoup(fetch(session, urljoin(BASE_URL, entry_path)), "lxml")
        sidebar = soup.select_one("#VPSidebarNav")
        if sidebar is None:
            raise RuntimeError(f"Sidebar not found: {entry_path}")

        prefix = f"/docs/{section}/"
        for link in sidebar.select("a[href]"):
            href = str(link.get("href", "")).split("#", 1)[0]
            if not href.startswith(prefix) or href in seen:
                continue
            title = " ".join(link.get_text(" ", strip=True).split())
            pages.append(Page(section=section, path=href, title=title))
            seen.add(href)

    return pages


def route_to_file(output_root: Path, route: str) -> Path:
    decoded = unquote(urlsplit(route).path).strip("/")
    relative = PurePosixPath(decoded).relative_to("docs")
    return output_root.joinpath(*relative.parts).with_suffix(".md")


def local_link(output_root: Path, source: Path, href: str) -> str:
    parsed = urlsplit(href)
    if not parsed.path.startswith("/docs/"):
        return href

    destination = route_to_file(output_root, parsed.path)
    relative = Path(os.path.relpath(destination, source.parent)).as_posix()
    suffix = f"?{parsed.query}" if parsed.query else ""
    fragment = f"#{parsed.fragment}" if parsed.fragment else ""
    return quote(relative, safe="/.-_~") + suffix + fragment


def clean_document(
    soup: BeautifulSoup,
    page: Page,
    output_root: Path,
    known_routes: set[str],
) -> Tag:
    body = soup.select_one("main .vp-doc > div")
    if body is None:
        raise RuntimeError(f"Document body not found: {page.url}")

    for selector in (
        ".header-anchor",
        ".vp-copy-code-button",
        "script",
        "style",
    ):
        for element in body.select(selector):
            element.decompose()

    output_file = route_to_file(output_root, page.path)
    for link in body.select("a[href]"):
        href = str(link.get("href", ""))
        if href.startswith("#"):
            continue
        resolved = urljoin(page.url, href)
        resolved_parts = urlsplit(resolved)
        if resolved_parts.path in known_routes:
            link["href"] = local_link(output_root, output_file, resolved)
        elif resolved_parts.netloc == urlsplit(BASE_URL).netloc:
            link["href"] = resolved

    for media in body.select("img[src], video[src], audio[src], source[src], iframe[src]"):
        src = str(media.get("src", ""))
        media["src"] = urljoin(page.url, src)
        media.attrs.pop("data-src", None)

    return body


def page_to_markdown(
    page: Page,
    html: str,
    output_root: Path,
    known_routes: set[str],
) -> tuple[Path, str]:
    soup = BeautifulSoup(html, "lxml")
    body = clean_document(soup, page, output_root, known_routes)
    converter = CodeBuddyMarkdownConverter(
        heading_style=ATX,
        bullets="-",
        strong_em_symbol="*",
        escape_underscores=False,
        wrap=False,
    )
    markdown = converter.convert_soup(body)
    markdown = re.sub(r"[ \t]+\n", "\n", markdown)
    markdown = re.sub(r"\n{3,}", "\n\n", markdown).strip()
    if not re.search(r"^# ", markdown, flags=re.MULTILINE):
        markdown = f"# {page.title}\n\n{markdown}"
    source = f"> 来源：[CodeBuddy 官方文档]({page.url})"
    return route_to_file(output_root, page.path), f"{source}\n\n{markdown}\n"


def build_index(output_root: Path, pages: list[Page]) -> str:
    lines = [
        "# CodeBuddy 文档镜像",
        "",
        "本目录按官方导航保存 CodeBuddy 企业版与 WorkBuddy 文档。",
        f"抓取日期：{date.today().isoformat()}。",
        "",
    ]
    for section, label in (("enterprise", "企业版"), ("workbuddy", "WorkBuddy")):
        lines.extend((f"## {label}", ""))
        for page in (item for item in pages if item.section == section):
            target = route_to_file(output_root, page.path)
            relative = target.relative_to(output_root).as_posix()
            lines.append(f"- [{page.title}]({quote(relative, safe='/.-_~')})")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8", newline="\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "workbuddy",
    )
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    session = requests.Session()
    session.headers["User-Agent"] = "Mozilla/5.0 CodeBuddyDocsMirror/1.0"
    pages = discover_pages(session)
    print(f"Discovered {len(pages)} pages")

    downloaded: dict[Page, str] = {}
    failures: list[tuple[Page, Exception]] = []
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(fetch, session, page.url): page for page in pages}
        for future in as_completed(futures):
            page = futures[future]
            try:
                downloaded[page] = future.result()
            except Exception as exc:  # noqa: BLE001 - report every failed page together
                failures.append((page, exc))

    if failures:
        for page, error in failures:
            print(f"ERROR {page.url}: {error}", file=sys.stderr)
        return 1

    known_routes = {urlsplit(page.path).path for page in pages}
    for page in pages:
        path, markdown = page_to_markdown(
            page,
            downloaded[page],
            args.output,
            known_routes,
        )
        write_text(path, markdown)

    write_text(args.output / "README.md", build_index(args.output, pages))
    print(f"Wrote {len(pages)} Markdown pages to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
