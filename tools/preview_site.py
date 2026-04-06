from __future__ import annotations

import argparse
import datetime as dt
import html
import re
import shutil
import sys
import textwrap
from dataclasses import dataclass
from pathlib import Path
from typing import Any


TOKEN_RE = re.compile(r"({{.*?}}|{%.*?%})", re.S)
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
FRONT_MATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", re.S)
HTML_TAG_RE = re.compile(r"<[^>]+>")
POST_NAME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}-(.+)\.md$")
INLINE_TOKEN_RE = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|\*\*(.+?)\*\*")
TABLE_SEPARATOR_CELL_RE = re.compile(r"^:?-{3,}:?$")


@dataclass
class TextNode:
    text: str


@dataclass
class OutputNode:
    expression: str


@dataclass
class IncludeNode:
    name: str


@dataclass
class AssignNode:
    name: str
    expression: str


@dataclass
class IfNode:
    condition: str
    true_branch: list[Any]
    false_branch: list[Any]


@dataclass
class ForNode:
    item_name: str
    iterable_expression: str
    body: list[Any]


def split_unquoted(text: str, separator: str) -> list[str]:
    parts: list[str] = []
    current: list[str] = []
    quote: str | None = None

    for char in text:
        if quote:
            current.append(char)
            if char == quote:
                quote = None
            continue

        if char in {"'", '"'}:
            quote = char
            current.append(char)
            continue

        if char == separator:
            parts.append("".join(current).strip())
            current = []
            continue

        current.append(char)

    parts.append("".join(current).strip())
    return parts


def parse_scalar(value: str) -> Any:
    text = value.strip()

    if not text:
        return ""
    if text.lower() in {"null", "~"}:
        return None
    if text in {"{}", "[]"}:
        return {} if text == "{}" else []
    if text.lower() == "true":
        return True
    if text.lower() == "false":
        return False
    if DATE_RE.fullmatch(text):
        return dt.date.fromisoformat(text)
    if re.fullmatch(r"-?\d+", text):
        return int(text)
    if re.fullmatch(r"-?\d+\.\d+", text):
        return float(text)
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {"'", '"'}:
        return html.unescape(text[1:-1])
    if text.startswith("[") and text.endswith("]"):
        inner = text[1:-1].strip()
        if not inner:
            return []
        return [parse_scalar(part) for part in split_unquoted(inner, ",") if part]
    return html.unescape(text)


def parse_mapping(text: str, *, include_indented: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {}

    for raw_line in text.splitlines():
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        if not include_indented and raw_line.startswith((" ", "\t")):
            continue

        line = raw_line.strip()
        if ":" not in line:
            continue

        key, value = line.split(":", 1)
        result[key.strip()] = parse_scalar(value)

    return result


def parse_mapping_list(text: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None

    for raw_line in text.splitlines():
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue

        if raw_line.startswith("- "):
            if current is not None:
                items.append(current)
            current = {}
            remainder = raw_line[2:].strip()
            if remainder:
                key, value = remainder.split(":", 1)
                current[key.strip()] = parse_scalar(value)
            continue

        if current is None:
            continue

        line = raw_line.strip()
        if ":" not in line:
            continue

        key, value = line.split(":", 1)
        current[key.strip()] = parse_scalar(value)

    if current is not None:
        items.append(current)

    return items


def extract_top_level_block(text: str, key: str) -> str:
    lines = text.splitlines()
    collecting = False
    block_lines: list[str] = []

    for line in lines:
        if not collecting:
            if line.startswith(f"{key}:"):
                collecting = True
            continue

        if line and not line.startswith((" ", "\t")):
            break

        block_lines.append(line)

    return textwrap.dedent("\n".join(block_lines)).strip()


def parse_config(text: str) -> dict[str, Any]:
    config = parse_mapping(text)
    defaults_block = extract_top_level_block(text, "defaults")
    config["defaults"] = parse_mapping_list(defaults_block) if defaults_block else []
    return config


def read_front_matter(path: Path) -> tuple[dict[str, Any], str]:
    text = path.read_text(encoding="utf-8")
    match = FRONT_MATTER_RE.match(text)
    if not match:
        return {}, text
    return parse_mapping(match.group(1), include_indented=False), match.group(2)


def strip_html(text: str) -> str:
    return HTML_TAG_RE.sub("", text)


def truncate_text(text: str, length: int) -> str:
    value = text.strip()
    if len(value) <= length:
        return value
    clipped = value[: max(0, length - 3)].rstrip()
    return f"{clipped}..."


def render_inline_segment(text: str) -> str:
    rendered: list[str] = []
    last_index = 0

    for match in INLINE_TOKEN_RE.finditer(text):
        rendered.append(html.escape(text[last_index : match.start()], quote=False))

        image_alt, image_src, link_label, link_href, strong_text = match.groups()
        if image_src is not None:
            alt_attr = html.escape(image_alt, quote=True)
            src_attr = html.escape(image_src.strip(), quote=True)
            rendered.append(f'<img src="{src_attr}" alt="{alt_attr}" />')
        elif link_href is not None:
            href_attr = html.escape(link_href.strip(), quote=True)
            rendered.append(f'<a href="{href_attr}">{render_inline_segment(link_label)}</a>')
        else:
            rendered.append(f"<strong>{render_inline_segment(strong_text)}</strong>")

        last_index = match.end()

    rendered.append(html.escape(text[last_index:], quote=False))
    return "".join(rendered)


def render_inline_markdown(text: str) -> str:
    parts = re.split(r"(`[^`]+`)", text)
    rendered: list[str] = []

    for part in parts:
        if not part:
            continue
        if part.startswith("`") and part.endswith("`"):
            rendered.append(f"<code>{html.escape(part[1:-1], quote=False)}</code>")
            continue

        rendered.append(render_inline_segment(part))

    return "".join(rendered)


def parse_table_row(line: str) -> list[str]:
    trimmed = line.strip()
    if trimmed.startswith("|"):
        trimmed = trimmed[1:]
    if trimmed.endswith("|"):
        trimmed = trimmed[:-1]
    return [cell.strip() for cell in trimmed.split("|")]


def parse_table_alignments(separator_line: str) -> list[str | None] | None:
    alignments: list[str | None] = []

    for cell in parse_table_row(separator_line):
        compact = cell.replace(" ", "")
        if not TABLE_SEPARATOR_CELL_RE.fullmatch(compact):
            return None
        if compact.startswith(":") and compact.endswith(":"):
            alignments.append("center")
        elif compact.endswith(":"):
            alignments.append("right")
        elif compact.startswith(":"):
            alignments.append("left")
        else:
            alignments.append(None)

    return alignments


def render_markdown(text: str) -> str:
    lines = text.strip().splitlines()
    html_lines: list[str] = []
    paragraph: list[str] = []
    unordered_items: list[str] = []
    ordered_items: list[str] = []
    table_lines: list[str] = []
    code_lines: list[str] = []
    code_language = ""
    in_code_block = False

    def flush_paragraph() -> None:
        if not paragraph:
            return
        html_lines.append(f"<p>{render_inline_markdown(' '.join(paragraph).strip())}</p>")
        paragraph.clear()

    def flush_unordered() -> None:
        if not unordered_items:
            return
        html_lines.append("<ul>")
        for item in unordered_items:
            html_lines.append(f"  <li>{render_inline_markdown(item)}</li>")
        html_lines.append("</ul>")
        unordered_items.clear()

    def flush_ordered() -> None:
        if not ordered_items:
            return
        html_lines.append("<ol>")
        for item in ordered_items:
            html_lines.append(f"  <li>{render_inline_markdown(item)}</li>")
        html_lines.append("</ol>")
        ordered_items.clear()

    def flush_table() -> None:
        if not table_lines:
            return

        if len(table_lines) < 2:
            for line in table_lines:
                html_lines.append(f"<p>{render_inline_markdown(line)}</p>")
            table_lines.clear()
            return

        header_cells = parse_table_row(table_lines[0])
        alignments = parse_table_alignments(table_lines[1])

        if not header_cells or alignments is None or len(alignments) != len(header_cells):
            for line in table_lines:
                html_lines.append(f"<p>{render_inline_markdown(line)}</p>")
            table_lines.clear()
            return

        html_lines.append("<table>")
        html_lines.append("  <thead>")
        html_lines.append("    <tr>")
        for index, cell in enumerate(header_cells):
            style_attr = f' style="text-align: {alignments[index]};"' if alignments[index] else ""
            html_lines.append(f"      <th{style_attr}>{render_inline_markdown(cell)}</th>")
        html_lines.append("    </tr>")
        html_lines.append("  </thead>")

        body_rows = table_lines[2:]
        if body_rows:
            html_lines.append("  <tbody>")
            for row in body_rows:
                cells = parse_table_row(row)
                if len(cells) < len(header_cells):
                    cells.extend([""] * (len(header_cells) - len(cells)))
                elif len(cells) > len(header_cells):
                    cells = cells[: len(header_cells)]

                html_lines.append("    <tr>")
                for index, cell in enumerate(cells):
                    style_attr = f' style="text-align: {alignments[index]};"' if alignments[index] else ""
                    html_lines.append(f"      <td{style_attr}>{render_inline_markdown(cell)}</td>")
                html_lines.append("    </tr>")
            html_lines.append("  </tbody>")

        html_lines.append("</table>")
        table_lines.clear()

    def flush_lists() -> None:
        flush_unordered()
        flush_ordered()

    for raw_line in lines:
        stripped = raw_line.strip()

        if in_code_block:
            if stripped.startswith("```"):
                class_attr = f' class="language-{code_language}"' if code_language else ""
                code_html = html.escape("\n".join(code_lines), quote=False)
                html_lines.append(f"<pre><code{class_attr}>{code_html}</code></pre>")
                code_lines.clear()
                code_language = ""
                in_code_block = False
            else:
                code_lines.append(raw_line)
            continue

        if stripped.startswith("```"):
            flush_paragraph()
            flush_lists()
            flush_table()
            in_code_block = True
            code_language = stripped[3:].strip()
            continue

        if not stripped:
            flush_paragraph()
            flush_lists()
            flush_table()
            continue

        heading_match = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if heading_match:
            flush_paragraph()
            flush_lists()
            flush_table()
            level = len(heading_match.group(1))
            html_lines.append(f"<h{level}>{render_inline_markdown(heading_match.group(2))}</h{level}>")
            continue

        unordered_match = re.match(r"^[-*]\s+(.*)$", stripped)
        if unordered_match:
            flush_paragraph()
            flush_ordered()
            flush_table()
            unordered_items.append(unordered_match.group(1))
            continue

        ordered_match = re.match(r"^\d+\.\s+(.*)$", stripped)
        if ordered_match:
            flush_paragraph()
            flush_unordered()
            flush_table()
            ordered_items.append(ordered_match.group(1))
            continue

        if stripped.startswith("|"):
            flush_paragraph()
            flush_lists()
            table_lines.append(stripped)
            continue

        flush_table()
        paragraph.append(stripped)

    flush_paragraph()
    flush_lists()
    flush_table()

    if in_code_block:
        class_attr = f' class="language-{code_language}"' if code_language else ""
        code_html = html.escape("\n".join(code_lines), quote=False)
        html_lines.append(f"<pre><code{class_attr}>{code_html}</code></pre>")

    return "\n".join(html_lines)


def extract_excerpt(markdown_text: str) -> str:
    for block in re.split(r"\n\s*\n", markdown_text.strip()):
        candidate = block.strip()
        if not candidate or candidate.startswith("#") or candidate.startswith("```"):
            continue
        excerpt = strip_html(render_markdown(candidate)).strip()
        if excerpt:
            return excerpt
    return strip_html(render_markdown(markdown_text)).strip()


def coerce_date(value: Any) -> dt.date | None:
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    if isinstance(value, str) and DATE_RE.fullmatch(value):
        return dt.date.fromisoformat(value)
    return None


def stringify(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, dt.datetime):
        return value.isoformat()
    if isinstance(value, dt.date):
        return value.isoformat()
    return str(value)


def truthy(value: Any) -> bool:
    if value is None or value is False:
        return False
    if isinstance(value, (str, list, tuple, dict, set)) and len(value) == 0:
        return False
    return True


class TemplateEngine:
    def __init__(self, source_root: Path, site: dict[str, Any]):
        self.source_root = source_root
        self.site = site

    def render(self, template_text: str, context: dict[str, Any]) -> str:
        nodes, index, stop_tag = self._parse_nodes([part for part in TOKEN_RE.split(template_text) if part], 0, set())
        if stop_tag is not None or index != len([part for part in TOKEN_RE.split(template_text) if part]):
            raise ValueError("Unexpected dangling Liquid block while rendering template.")
        return self._render_nodes(nodes, context)

    def _parse_nodes(
        self,
        parts: list[str],
        index: int,
        stop_tags: set[str],
    ) -> tuple[list[Any], int, str | None]:
        nodes: list[Any] = []

        while index < len(parts):
            part = parts[index]

            if part.startswith("{{"):
                nodes.append(OutputNode(part[2:-2].strip()))
                index += 1
                continue

            if part.startswith("{%"):
                tag = part[2:-2].strip()

                if tag in stop_tags:
                    return nodes, index + 1, tag

                if tag.startswith("include "):
                    nodes.append(IncludeNode(tag[len("include ") :].strip()))
                    index += 1
                    continue

                if tag.startswith("assign "):
                    assignment = tag[len("assign ") :]
                    name, expression = assignment.split("=", 1)
                    nodes.append(AssignNode(name.strip(), expression.strip()))
                    index += 1
                    continue

                if tag.startswith("if "):
                    condition = tag[len("if ") :].strip()
                    true_branch, index, stop_tag = self._parse_nodes(parts, index + 1, {"else", "endif"})
                    false_branch: list[Any] = []
                    if stop_tag == "else":
                        false_branch, index, stop_tag = self._parse_nodes(parts, index, {"endif"})
                    if stop_tag != "endif":
                        raise ValueError(f"Unclosed if block in template: {condition}")
                    nodes.append(IfNode(condition, true_branch, false_branch))
                    continue

                if tag.startswith("for "):
                    loop_match = re.match(r"for\s+(\w+)\s+in\s+(.+)", tag)
                    if not loop_match:
                        raise ValueError(f"Unsupported for tag: {tag}")
                    body, index, stop_tag = self._parse_nodes(parts, index + 1, {"endfor"})
                    if stop_tag != "endfor":
                        raise ValueError(f"Unclosed for block in template: {tag}")
                    nodes.append(ForNode(loop_match.group(1), loop_match.group(2).strip(), body))
                    continue

                raise ValueError(f"Unsupported Liquid tag: {tag}")

            nodes.append(TextNode(part))
            index += 1

        return nodes, index, None

    def _render_nodes(self, nodes: list[Any], context: dict[str, Any]) -> str:
        output: list[str] = []

        for node in nodes:
            if isinstance(node, TextNode):
                output.append(node.text)
                continue

            if isinstance(node, OutputNode):
                output.append(stringify(self._evaluate_expression(node.expression, context)))
                continue

            if isinstance(node, IncludeNode):
                include_path = self.source_root / "_includes" / node.name
                include_text = include_path.read_text(encoding="utf-8")
                output.append(self.render(include_text, context.copy()))
                continue

            if isinstance(node, AssignNode):
                context[node.name] = self._evaluate_expression(node.expression, context)
                continue

            if isinstance(node, IfNode):
                branch = node.true_branch if self._evaluate_condition(node.condition, context) else node.false_branch
                output.append(self._render_nodes(branch, context))
                continue

            if isinstance(node, ForNode):
                iterable = self._evaluate_expression(node.iterable_expression, context)
                if iterable is None:
                    continue

                previous_value = context.get(node.item_name)
                had_previous = node.item_name in context

                for item in iterable:
                    context[node.item_name] = item
                    output.append(self._render_nodes(node.body, context.copy()))

                if had_previous:
                    context[node.item_name] = previous_value
                else:
                    context.pop(node.item_name, None)
                continue

            raise TypeError(f"Unsupported node type: {type(node)!r}")

        return "".join(output)

    def _evaluate_condition(self, condition: str, context: dict[str, Any]) -> bool:
        if " contains " in condition:
            left, right = condition.split(" contains ", 1)
            left_value = self._evaluate_expression(left.strip(), context)
            right_value = self._evaluate_expression(right.strip(), context)
            if isinstance(left_value, (list, tuple, set)):
                return right_value in left_value
            return stringify(right_value) in stringify(left_value)

        for operator in (">=", "<=", "==", "!=", ">", "<"):
            if operator in condition:
                left, right = condition.split(operator, 1)
                left_value = self._evaluate_expression(left.strip(), context)
                right_value = self._evaluate_expression(right.strip(), context)
                return self._compare(left_value, right_value, operator)

        return truthy(self._evaluate_expression(condition.strip(), context))

    def _compare(self, left: Any, right: Any, operator: str) -> bool:
        if operator == "==":
            return left == right
        if operator == "!=":
            return left != right
        if operator == ">":
            return left > right
        if operator == "<":
            return left < right
        if operator == ">=":
            return left >= right
        if operator == "<=":
            return left <= right
        raise ValueError(f"Unsupported operator: {operator}")

    def _evaluate_expression(self, expression: str, context: dict[str, Any]) -> Any:
        segments = split_unquoted(expression, "|")
        value = self._resolve_value(segments[0], context)

        for raw_filter in segments[1:]:
            value = self._apply_filter(raw_filter, value, context)

        return value

    def _resolve_value(self, value: str, context: dict[str, Any]) -> Any:
        token = value.strip()

        if not token:
            return ""
        if len(token) >= 2 and token[0] == token[-1] and token[0] in {"'", '"'}:
            return html.unescape(token[1:-1])
        if DATE_RE.fullmatch(token):
            return dt.date.fromisoformat(token)
        if re.fullmatch(r"-?\d+", token):
            return int(token)
        if re.fullmatch(r"-?\d+\.\d+", token):
            return float(token)

        current: Any = context
        for part in token.split("."):
            if isinstance(current, dict):
                if part == "size":
                    current = len(current)
                else:
                    current = current.get(part)
            elif isinstance(current, (list, tuple)):
                if part == "size":
                    current = len(current)
                else:
                    return None
            else:
                current = getattr(current, part, None)

            if current is None:
                return None

        return current

    def _apply_filter(self, raw_filter: str, value: Any, context: dict[str, Any]) -> Any:
        filter_text = raw_filter.strip()
        if ":" in filter_text:
            name, raw_args = filter_text.split(":", 1)
            args = [self._resolve_value(arg, context) for arg in split_unquoted(raw_args, ",") if arg]
        else:
            name = filter_text
            args = []

        name = name.strip()

        if name == "relative_url":
            return relative_url(stringify(value), stringify(self.site.get("baseurl", "")))
        if name == "date":
            date_value = coerce_date(value)
            if date_value is None:
                return stringify(value)
            fmt = stringify(args[0]) if args else "%Y-%m-%d"
            return date_value.strftime(fmt)
        if name == "strip_html":
            return strip_html(stringify(value))
        if name == "strip_newlines":
            return stringify(value).replace("\r", "").replace("\n", "")
        if name == "truncate":
            limit = int(args[0]) if args else 50
            return truncate_text(stringify(value), limit)
        if name == "replace":
            old = stringify(args[0]) if args else ""
            new = stringify(args[1]) if len(args) > 1 else ""
            return stringify(value).replace(old, new)
        if name == "capitalize":
            return stringify(value).capitalize()
        if name == "first":
            if isinstance(value, (list, tuple)) and value:
                return value[0]
            return None
        if name == "slice":
            start = int(args[0]) if args else 0
            length = int(args[1]) if len(args) > 1 else None
            if isinstance(value, str):
                return value[start:] if length is None else value[start : start + length]
            if isinstance(value, (list, tuple)):
                sliced = value[start:] if length is None else value[start : start + length]
                return list(sliced)
            return value

        raise ValueError(f"Unsupported Liquid filter: {name}")


def relative_url(path: str, baseurl: str) -> str:
    if not path:
        return baseurl or "/"
    if path.startswith(("http://", "https://", "#", "mailto:")):
        return path
    normalized = path if path.startswith("/") else f"/{path}"
    base = baseurl.rstrip("/")
    return f"{base}{normalized}" if base else normalized


def copy_static_files(source_root: Path, output_root: Path) -> None:
    assets_dir = source_root / "assets"
    if assets_dir.exists():
        shutil.copytree(assets_dir, output_root / "assets")

    passthrough_suffixes = {
        ".pdf",
        ".png",
        ".jpg",
        ".jpeg",
        ".svg",
        ".webp",
        ".ico",
        ".txt",
        ".xml",
        ".json",
        ".webmanifest",
    }

    for entry in source_root.iterdir():
        if entry.is_dir() or entry.name.startswith((".", "_")):
            continue
        if entry.name in {"index.html", "index-jekyll.html", "index-test.html", "serve-local.ps1"}:
            continue
        if entry.name == "CNAME" or entry.suffix.lower() in passthrough_suffixes:
            shutil.copy2(entry, output_root / entry.name)


def clear_directory(path: Path) -> None:
    if not path.exists():
        path.mkdir(parents=True, exist_ok=True)
        return

    for child in path.iterdir():
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink()


def load_posts(source_root: Path) -> list[dict[str, Any]]:
    posts: list[dict[str, Any]] = []

    for path in sorted((source_root / "_posts").glob("*.md")):
        metadata, body = read_front_matter(path)
        filename_match = POST_NAME_RE.match(path.name)
        if not filename_match:
            raise ValueError(f"Unsupported post filename format: {path.name}")

        slug = filename_match.group(1)
        content_html = render_markdown(body)
        excerpt = extract_excerpt(body)
        post = {
            **metadata,
            "slug": slug,
            "url": f"/blog/{slug}/",
            "content": content_html,
            "excerpt": excerpt,
            "source_path": path,
        }
        posts.append(post)

    posts.sort(key=lambda post: coerce_date(post.get("date")) or dt.date.min, reverse=True)

    for index, post in enumerate(posts):
        post["next"] = posts[index - 1] if index > 0 else None
        post["previous"] = posts[index + 1] if index + 1 < len(posts) else None

    return posts


def apply_defaults(
    defaults: list[dict[str, Any]],
    metadata: dict[str, Any],
    *,
    source_root: Path,
    source_path: Path,
    content_type: str | None = None,
) -> dict[str, Any]:
    resolved = dict(metadata)
    relative_path = source_path.relative_to(source_root).as_posix()

    for default in defaults:
        scope_type = stringify(default.get("type")).strip()
        scope_path = stringify(default.get("path")).strip().strip("/")

        if content_type and scope_type and scope_type != content_type:
            continue
        if not content_type and scope_type:
            continue
        if scope_path and not relative_path.startswith(scope_path):
            continue

        for key, value in default.items():
            if key in {"scope", "values", "path", "type"}:
                continue
            resolved.setdefault(key, value)

    return resolved


def apply_layouts(
    engine: TemplateEngine,
    source_root: Path,
    page: dict[str, Any],
    layout_name: str | None,
    content_html: str,
) -> str:
    rendered = content_html
    current_layout = layout_name

    while current_layout:
        layout_path = source_root / "_layouts" / f"{current_layout}.html"
        layout_front_matter, layout_body = read_front_matter(layout_path)
        rendered = engine.render(
            layout_body,
            {
                "site": engine.site,
                "page": page,
                "content": rendered,
            },
        )
        current_layout = layout_front_matter.get("layout")

    return rendered


def render_page(engine: TemplateEngine, page_path: Path, page_overrides: dict[str, Any] | None = None) -> str:
    metadata, body = read_front_matter(page_path)
    page = apply_defaults(
        engine.site.get("defaults", []),
        metadata,
        source_root=engine.source_root,
        source_path=page_path,
    )
    page.update(page_overrides or {})
    content_html = engine.render(
        body,
        {
            "site": engine.site,
            "page": page,
            "content": "",
        },
    )
    return apply_layouts(engine, engine.source_root, page, page.get("layout"), content_html)


def render_post(engine: TemplateEngine, post: dict[str, Any]) -> str:
    metadata, _ = read_front_matter(post["source_path"])
    page = apply_defaults(
        engine.site.get("defaults", []),
        metadata,
        source_root=engine.source_root,
        source_path=post["source_path"],
        content_type="posts",
    )
    page.update({key: value for key, value in post.items() if key != "source_path"})
    return apply_layouts(engine, engine.source_root, page, page.get("layout"), post["content"])


def write_output(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def build_preview(source_root: Path, output_root: Path) -> None:
    config = parse_config((source_root / "_config.yml").read_text(encoding="utf-8"))
    projects = parse_mapping_list((source_root / "_data" / "projects.yml").read_text(encoding="utf-8"))
    posts = load_posts(source_root)

    site = {
        **config,
        "time": dt.datetime.now(),
        "data": {
            "projects": projects,
        },
        "posts": posts,
    }

    engine = TemplateEngine(source_root, site)

    clear_directory(output_root)

    copy_static_files(source_root, output_root)

    home_html = render_page(engine, source_root / "index.html", {"url": "/"})
    blog_html = render_page(engine, source_root / "blog" / "index.html", {"url": "/blog/"})

    write_output(output_root / "index.html", home_html)
    write_output(output_root / "blog" / "index.html", blog_html)

    extra_templates = [
        ("robots.txt", "/robots.txt"),
        ("sitemap.xml", "/sitemap.xml"),
    ]

    for page_path in sorted(source_root.glob("*.html")):
        if page_path.name == "index.html":
            continue
        extra_templates.append((page_path.name, f"/{page_path.stem}/"))

    for relative_path, page_url in extra_templates:
        source_path = source_root / relative_path
        if source_path.exists():
            extra_html = render_page(engine, source_path, {"url": page_url})
            if relative_path.endswith(".html"):
                write_output(output_root / Path(relative_path).stem / "index.html", extra_html)
            else:
                write_output(output_root / relative_path, extra_html)

    for post in posts:
        post_html = render_post(engine, post)
        write_output(output_root / "blog" / post["slug"] / "index.html", post_html)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a local static preview from the Jekyll source files.")
    parser.add_argument("--source", required=True, help="Path to the site source directory.")
    parser.add_argument("--output", required=True, help="Path to the generated preview directory.")
    args = parser.parse_args()

    source_root = Path(args.source).resolve()
    output_root = Path(args.output).resolve()

    build_preview(source_root, output_root)
    print(f"Preview generated at {output_root}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # pragma: no cover - CLI reporting path
        print(f"Preview build failed: {exc}", file=sys.stderr)
        raise
