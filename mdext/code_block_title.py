"""
Markdown extension for named fenced code blocks.

Usage:
    ```python title="example.py"
    print("hello")
    ```
"""

import re

from markdown.extensions import Extension
from markdown.preprocessors import Preprocessor

FENCE_RE = re.compile(
    r"^(?P<fence>[~`]{3,})\s*(?P<info>.*?)\s*$",
    re.MULTILINE,
)

TITLE_RE = re.compile(r'^(\w[\w.]*)\s+title="([^"]+)"\s*$')


def _closing_pattern(fence):
    """Build a compiled regex for the closing fence."""
    return re.compile(r"^[ ]{0,3}" + re.escape(fence[:3]) + r"\s*$")


class _FencedBlockTitlePreprocessor(Preprocessor):
    """Processes fenced code blocks with optional title support.

    Runs before the built-in fenced_code_block preprocessor (priority 30 vs 25).
    Only intercepts blocks that have a title="..." parameter; all others pass
    through unchanged for the default processor.
    """

    def run(self, lines):
        text = "\n".join(lines)
        index = 0
        while True:
            m = FENCE_RE.search(text, index)
            if not m:
                break

            info = m.group("info").strip()
            title_match = TITLE_RE.match(info)
            if not title_match:
                index = m.end()
                continue

            lang = title_match.group(1)
            title = title_match.group(2)
            fence = m.group("fence")
            closing = _closing_pattern(fence)

            # Walk lines from the opening fence to find the closing fence
            block_lines = text[m.start() :].split("\n")
            code_parts = []
            block_end_line = 0
            for j, line in enumerate(block_lines):
                if j == 0:
                    continue  # skip opening fence line
                if closing.match(line):
                    block_end_line = j
                    break
                code_parts.append(line)
            else:
                index = m.end()
                continue

            code_text = "\n".join(code_parts)
            escaped = code_text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")

            html = '<div class="code-block">'
            html += f'<div class="code-block__title">{title}</div>'
            html += f'<pre><code class="language-{lang}">{escaped}</code></pre>'
            html += "</div>"

            placeholder = self.md.htmlStash.store(html)

            # Calculate byte offset of the closing fence line end
            block_start = m.start()
            block_lines_text = text[block_start:]
            line_breaks = [j for j, c in enumerate(block_lines_text) if c == "\n"]
            if block_end_line < len(line_breaks):
                block_end = block_start + line_breaks[block_end_line] + 1
            else:
                block_end = len(text)

            text = text[:block_start] + "\n" + placeholder + "\n" + text[block_end:]
            index = block_start + 1 + len(placeholder)

        return text.split("\n")


class CodeBlockTitleExtension(Extension):
    """Extension adding title support to fenced code blocks."""

    def extendMarkdown(self, md):
        md.preprocessors.register(
            _FencedBlockTitlePreprocessor(md),
            "code_block_with_title",
            30,  # Higher priority than fenced_code_block (25)
        )
