"""Project identification from repo manifests (pom.xml / package.json / context.stack.manifests).

Replaces hardcoded business project names (e.g. "your-project-backend")
with discovery driven by the actual repository contents.
"""
from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_IGNORED_DIR_NAMES = {
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    "coverage",
    "test-results",
    ".qa-agent",
}

_MAX_SCAN_DEPTH = 4


class ProjectDiscoveryError(Exception):
    """Raised when no project can be identified for a task/case."""


@dataclass(frozen=True)
class ProjectInfo:
    name: str
    root: Path
    kind: str  # "maven" | "npm"


def _read_maven_artifact_id(pom_path: Path) -> str | None:
    try:
        tree = ET.parse(pom_path)
    except ET.ParseError:
        return None
    root = tree.getroot()
    # Namespace-agnostic lookup: Maven POMs declare a default xmlns.
    for child in root:
        tag = child.tag.rsplit("}", 1)[-1]
        if tag == "artifactId":
            return (child.text or "").strip() or None
    return None


def _is_maven_aggregator(pom_path: Path) -> bool:
    try:
        root = ET.parse(pom_path).getroot()
    except ET.ParseError:
        return False
    packaging = ""
    has_modules = False
    for child in root:
        tag = child.tag.rsplit("}", 1)[-1]
        if tag == "packaging":
            packaging = (child.text or "").strip().lower()
        elif tag == "modules":
            has_modules = any(grandchild.tag.rsplit("}", 1)[-1] == "module" for grandchild in child)
    return packaging == "pom" and has_modules


def _read_npm_name(package_json_path: Path) -> str | None:
    try:
        data = json.loads(package_json_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(data, dict):
        return None
    name = data.get("name")
    return str(name).strip() or None if name else None


def _scan_repo_for_projects(repo: Path) -> list[ProjectInfo]:
    found: list[ProjectInfo] = []
    seen_roots: set[Path] = set()

    def _walk(directory: Path, depth: int) -> None:
        if depth > _MAX_SCAN_DEPTH or not directory.is_dir():
            return
        pom = directory / "pom.xml"
        package_json = directory / "package.json"
        if pom.exists():
            artifact_id = _read_maven_artifact_id(pom)
            if artifact_id and not _is_maven_aggregator(pom) and directory.resolve() not in seen_roots:
                found.append(ProjectInfo(name=artifact_id, root=directory.resolve(), kind="maven"))
                seen_roots.add(directory.resolve())
        elif package_json.exists():
            name = _read_npm_name(package_json)
            if name and directory.resolve() not in seen_roots:
                found.append(ProjectInfo(name=name, root=directory.resolve(), kind="npm"))
                seen_roots.add(directory.resolve())
        try:
            children = sorted(p for p in directory.iterdir() if p.is_dir())
        except OSError:
            return
        for child in children:
            if child.name in _IGNORED_DIR_NAMES or child.name.startswith("."):
                continue
            _walk(child, depth + 1)

    _walk(repo, 0)
    return found


def _projects_from_context_manifests(context: dict[str, Any] | None) -> list[ProjectInfo]:
    if not context:
        return []
    manifests = (context.get("stack") or {}).get("manifests") if isinstance(context.get("stack"), dict) else None
    if not isinstance(manifests, list):
        return []
    found: list[ProjectInfo] = []
    for entry in manifests:
        manifest_path = Path(str(entry))
        if not manifest_path.exists():
            continue
        if manifest_path.name == "pom.xml":
            artifact_id = _read_maven_artifact_id(manifest_path)
            if artifact_id:
                found.append(ProjectInfo(name=artifact_id, root=manifest_path.parent.resolve(), kind="maven"))
        elif manifest_path.name == "package.json":
            name = _read_npm_name(manifest_path)
            if name:
                found.append(ProjectInfo(name=name, root=manifest_path.parent.resolve(), kind="npm"))
    return found


def discover_projects(repo: Path, context: dict[str, Any] | None = None) -> list[ProjectInfo]:
    """Discover all identifiable projects under repo, plus any context-declared manifests.

    Repo-scanned projects are returned in deterministic (sorted-path) order first,
    followed by any context-only manifests not already found under repo.
    """
    repo = Path(repo).resolve()
    projects = _scan_repo_for_projects(repo) if repo.exists() else []
    known_roots = {p.root for p in projects}
    for extra in _projects_from_context_manifests(context):
        if extra.root not in known_roots:
            projects.append(extra)
            known_roots.add(extra.root)
    return projects


def _case_text(case: dict[str, Any]) -> str:
    parts = [str(case.get(key, "")) for key in ("title", "module", "businessActor", "operationPath")]
    steps = case.get("steps")
    if isinstance(steps, list):
        parts.extend(str(s) for s in steps)
    return " ".join(parts).lower()


def resolve_target_project(
    repo: Path,
    case: dict[str, Any],
    layer: str,
    context: dict[str, Any] | None = None,
) -> ProjectInfo:
    """Pick the project a spec-task for `case`/`layer` should target.

    Preference order: a maven project whose name/root hints match the case text,
    then an npm project with the same hint match, then the first discovered
    project of the kind implied by `layer` (maven for api/integration/unit-backend,
    npm otherwise), then any discovered project. Raises ProjectDiscoveryError
    if none exist.
    """
    projects = discover_projects(repo, context)
    if not projects:
        raise ProjectDiscoveryError(
            f"未识别到可执行项目：repo={repo} 中没有 pom.xml/package.json，也没有 context.stack.manifests 可用"
        )

    text = _case_text(case)

    def _matches_text(project: ProjectInfo) -> bool:
        haystack = f"{project.name} {project.root.name}".lower()
        return any(tok and tok in haystack for tok in text.split()) or any(
            tok and tok in text for tok in (project.name.lower(), project.root.name.lower())
        )

    maven_projects = [p for p in projects if p.kind == "maven"]
    npm_projects = [p for p in projects if p.kind == "npm"]

    if layer in {"api", "integration"}:
        for project in maven_projects:
            if _matches_text(project):
                return project
        if maven_projects:
            return maven_projects[0]
        for project in npm_projects:
            if _matches_text(project):
                return project
        if npm_projects:
            return npm_projects[0]
    else:
        preferred_order = maven_projects + npm_projects
        for project in preferred_order:
            if _matches_text(project):
                return project

    return projects[0]
