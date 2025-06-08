# dump_repo.py  (safe version: skips data files)
# dump_repo.py  (safe version: skips data files)
import os, pathlib, textwrap

ROOT = pathlib.Path(__file__).resolve().parent
OUT  = ROOT / "repo_dump.md"
MAX_KB = 200                        # still skip very large files

# File types we WANT to keep
CODE_EXTS = {
    ".py", ".ipynb", ".js", ".ts", ".tsx", ".jsx",
    ".java", ".go", ".rb", ".rs", ".cpp", ".c", ".h",
    ".md", ".toml", ".yaml", ".yml", ".jsonnet",
    ".html", ".css", ".scss", ".sh", ".bat", ".ps1",".lock",".env",'.toml'
}

# Or:  folders we want to ignore entirely
SKIP_DIRS = {"data", "datasets", "assets", ".git", "__pycache__", "bixbench/fhbixbench.egg-info",'bixbench/__pycache__','.github', "tests"}

SKIP_FILES = {                      # ALWAYS ignore these exact names
    ".gitignore",
    ".env",
    "uv.lock",
    "LICENSE",
    "pyproject.toml",
    "repo_dump.md",  # <-- Add this line to skip the output file
}
SKIP_EXTS  = {".toml", '.md'}              # ignore any file ending with these ext's
# ---------------------------------------------------------------------------

def should_include(p: pathlib.Path) -> bool:
    # Skip the output file itself
    if p.resolve() == OUT.resolve():  # <-- Add this check as well for extra safety
        return False
    if any(part in SKIP_DIRS for part in p.parts):
        return False
    if p.name in SKIP_FILES:
        return False
    if p.suffix.lower() in SKIP_EXTS:
        return False
    if p.suffix.lower() not in CODE_EXTS:
        return False
    if p.stat().st_size > MAX_KB * 1024:
        return False
    return True

# ... rest of the code remains the same ...
def md_header(rel):
    lang = rel.suffix.lstrip(".") or "text"
    return f"\n\n---\n\n### `{rel}`\n\n{lang}"

with OUT.open("w", encoding="utf-8") as out:
    out.write(f"# Repository dump of {ROOT.name}\n")
    for p in ROOT.rglob("*"):
        if p.is_file() and should_include(p):
            rel = p.relative_to(ROOT)
            out.write(md_header(rel))
            out.write("\n" + p.read_text(errors="ignore") + "\n")

print(f"✅ Wrote {OUT}")