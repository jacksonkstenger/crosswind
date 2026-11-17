"""Inline app/src/*.css and *.js into app/index.html (one self-contained page)."""
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "app" / "src"
css = (SRC / "style.css").read_text()
js = "\n".join(p.read_text() for p in sorted(SRC.glob("*.js")))
html = (SRC / "index.template.html").read_text().replace("/*__CSS__*/", css).replace("/*__JS__*/", js)
out = SRC.parent / "index.html"
out.write_text(html)
print(f"wrote {out} ({len(html) / 1024:.0f} KB)")
