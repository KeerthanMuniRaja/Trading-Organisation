"""Build a source-only handoff ZIP; exclude credentials, state and installed packages."""
from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
import zipfile


ROOT = Path(__file__).resolve().parents[1]
EXCLUDED = {"node_modules", "dist", ".git", ".local", ".data", ".state",
            ".npm-cache", "__pycache__", ".venv", "coverage", "runtime"}
ROOT_FILES = {"README.md", "package.json", "package-lock.json", ".gitignore", ".npmrc", ".env.example"}
SOURCE_DIRS = {"backend", "db", "docs", "integrations", "scripts", "services"}
EXTENSIONS = {".ts", ".mjs", ".py", ".sql", ".md", ".json", ".toml", ".lock"}


def main() -> None:
    version = json.loads((ROOT / 'package.json').read_text())['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Source package version must be major.minor.patch')
    entries: list[tuple[str, bytes]] = []
    secrets: list[bytes] = []
    credentials = ROOT / ".local" / "credentials.json"
    if credentials.exists():
        secrets.extend(p["token"].encode() for p in json.loads(credentials.read_text()) if p.get("token"))
    signing_key = ROOT / ".local" / "owner-signing-key.pem"
    if signing_key.exists():
        secrets.append(signing_key.read_bytes())

    for directory, names, files in os.walk(ROOT):
        current = Path(directory)
        names[:] = sorted(n for n in names if n not in EXCLUDED and not (current / n).is_symlink())
        if current == ROOT:
            names[:] = [n for n in names if n in SOURCE_DIRS]
        for name in sorted(files):
            path = current / name
            if path.is_symlink():
                continue
            relative = path.relative_to(ROOT)
            if len(relative.parts) == 1:
                if name not in ROOT_FILES:
                    continue
            elif path.suffix not in EXTENSIONS and name not in {".gitignore", ".npmrc"}:
                continue
            if name.startswith(".env") and name != ".env.example":
                continue
            content = path.read_bytes()
            if any(secret in content for secret in secrets):
                raise RuntimeError(f"Secret detected in source file: {relative}")
            entries.append(("trading-organisation/" + relative.as_posix(), content))

    manifest = {name: hashlib.sha256(content).hexdigest() for name, content in entries}
    manifest_content = json.dumps({"version": version, "files": manifest}, indent=2).encode()
    output = ROOT.parent / "outputs" / f"trading-organisation-backend-v{version}.zip"
    output.parent.mkdir(exist_ok=True)
    # Refuse to overwrite an earlier handoff; an operator can choose a new version.
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in entries:
            archive.writestr(name, content)
        archive.writestr("trading-organisation/SOURCE-MANIFEST.json", manifest_content)
    with zipfile.ZipFile(output) as archive:
        if archive.testzip() is not None:
            raise RuntimeError("ZIP integrity check failed")
        for name, expected in manifest.items():
            if hashlib.sha256(archive.read(name)).hexdigest() != expected:
                raise RuntimeError("Source manifest mismatch")
    print(json.dumps({"path": str(output), "sourceFiles": len(entries),
                      "bytes": output.stat().st_size,
                      "sha256": hashlib.sha256(output.read_bytes()).hexdigest()}))


if __name__ == "__main__":
    main()
