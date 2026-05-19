#!/usr/bin/env python3
"""
raw/ 아래의 .pptx → pdf/ 로 PDF 변환, .pdf → pdf/ 로 동일 상대경로 복사.
폴더 구조는 raw 기준 상대경로를 그대로 유지한다.

pptx → PDF 변환에는 LibreOffice(headless)가 필요하다.
경로는 consider.py 와 동일하게 OS별로 하드코딩되어 있다.
"""

from __future__ import annotations

import argparse
import glob
import os
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import cast


DEFAULT_RAW = Path(__file__).resolve().parent / "raw"
DEFAULT_PDF_ROOT = Path(__file__).resolve().parent / "pdf"

# consider.py 와 동일: OS별 LibreOffice 경로 (하드코딩)
IMPRESS_PDF_EXPORT_OPTION = {
    "MaxImageResolution": {"type": "long", "value": "300"},
    "Quality": {"type": "long", "value": "95"},
    "ReduceImageResolution": {"type": "boolean", "value": "false"},
    "EmbedStandardFonts": {"type": "boolean", "value": "true"},
    "EmbedFonts": {"type": "boolean", "value": "true"},
    "SubsetFonts": {"type": "boolean", "value": "false"},
}


def get_libreoffice_paths() -> tuple[Path, str, str]:
    """운영체제에 따른 LibreOffice 경로 (consider.py와 동일)."""
    system = platform.system()

    if system == "Darwin":  # macOS
        soffice_path = Path(
            "/Applications/LibreOffice.app/Contents/MacOS/soffice"
        )
        python_path = (
            "/Applications/LibreOffice.app/Contents/Frameworks/"
            "LibreOfficePython.framework/Versions/3.10/lib/python3.10"
        )
        python_home = (
            "/Applications/LibreOffice.app/Contents/Frameworks/"
            "LibreOfficePython.framework/Versions/3.10"
        )
    elif system == "Linux":
        soffice_path = Path("/opt/libreoffice25.2/program/soffice")
        python_path = "/opt/libreoffice25.2/program"
        python_home = "/opt/libreoffice25.2/program/python"
    else:
        raise RuntimeError(f"지원하지 않는 운영체제입니다: {system}")

    if not soffice_path.is_file():
        raise FileNotFoundError(f"LibreOffice를 찾을 수 없습니다: {soffice_path}")

    return soffice_path, python_path, python_home


def convert_pptx_to_pdf(
    soffice: Path,
    python_path: str,
    python_home: str,
    pptx: Path,
    out_dir: Path,
) -> Path:
    """
    pptx 한 개를 out_dir에 PDF로 저장. LibreOffice는 출력 파일명을
    원본 베이스명(.pdf)으로 만든다.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    # LibreOffice는 출력 디렉터리에 쓰므로 임시 디렉터리에서 변환 후 이동
    with tempfile.TemporaryDirectory(prefix="pptx2pdf_") as tmp:
        tmp_path = Path(tmp)
        env = os.environ.copy()
        env["PYTHONPATH"] = python_path
        env["PYTHONHOME"] = python_home
        # consider.py 와 동일한 변환 필터 / 인자
        cmd = [
            str(soffice),
            "--headless",
            "--convert-to",
            "pdf:impress_pdf_Export:",
            str(IMPRESS_PDF_EXPORT_OPTION),
            "--outdir",
            str(tmp_path),
            str(pptx),
        ]
        r = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=600,
            env=env,
        )
        if r.returncode != 0:
            raise RuntimeError(
                f"LibreOffice 실패 (exit {r.returncode}): {pptx}\n"
                f"stdout: {r.stdout}\nstderr: {r.stderr}"
            )
        produced = tmp_path / (pptx.stem + ".pdf")
        if not produced.is_file():
            raise FileNotFoundError(
                f"변환 결과 PDF 없음: {produced} (명령: {' '.join(cmd)})"
            )
        dest = out_dir / produced.name
        shutil.move(str(produced), dest)
        return dest


def collect_files(raw_root: Path, extensions: tuple[str, ...]) -> list[Path]:
    """glob `**/*.{ext}` 로 재귀 탐색 (extensions 예: ('pptx', 'pdf'))."""
    paths: list[Path] = []
    root_s = str(raw_root)
    for ext in extensions:
        pattern = os.path.join(root_s, "**", f"*.{ext}")
        for s in glob.glob(pattern, recursive=True):
            p = Path(s)
            if not p.is_file():
                continue
            try:
                p.resolve().relative_to(raw_root.resolve())
            except ValueError:
                continue
            paths.append(p)
    return sorted(set(paths))


def main() -> int:
    parser = argparse.ArgumentParser(description="raw의 pptx/pdf를 pdf 폴더로 동기화")
    parser.add_argument(
        "--raw",
        type=Path,
        default=DEFAULT_RAW,
        help=f"원본 루트 (기본: {DEFAULT_RAW})",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_PDF_ROOT,
        help=f"출력 루트 (기본: {DEFAULT_PDF_ROOT})",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="실제 변환/복사 없이 대상만 출력",
    )
    args = parser.parse_args()

    raw_root = args.raw.resolve()
    pdf_root = args.out.resolve()

    if not raw_root.is_dir():
        print(f"오류: raw 디렉터리가 없습니다: {raw_root}", file=sys.stderr)
        return 1

    pptx_files = collect_files(raw_root, ("pptx",))
    pdf_files = collect_files(raw_root, ("pdf",))

    lo_paths: tuple[Path, str, str] | None = None
    if pptx_files:
        try:
            lo_paths = get_libreoffice_paths()
        except (FileNotFoundError, RuntimeError) as e:
            if not args.dry_run:
                print(
                    f"오류: .pptx 변환에 필요한 LibreOffice를 사용할 수 없습니다.\n  {e}",
                    file=sys.stderr,
                )
                return 1
            print(
                f"경고: LibreOffice 경로 확인 실패 — 실제 변환 시 설치/경로 필요\n  {e}",
                file=sys.stderr,
            )

    print(f"raw:   {raw_root}")
    print(f"pdf:   {pdf_root}")
    if lo_paths is not None:
        print(f"soffice: {lo_paths[0]}")
    print(f".pptx: {len(pptx_files)}개, .pdf: {len(pdf_files)}개")

    for src in pptx_files:
        rel = src.relative_to(raw_root)
        dest_dir = pdf_root / rel.parent
        dest_pdf = dest_dir / (src.stem + ".pdf")
        if args.dry_run:
            print(f"[pptx→pdf] {src} -> {dest_pdf}")
            continue
        dest_dir.mkdir(parents=True, exist_ok=True)
        if dest_pdf.is_file():
            if dest_pdf.stat().st_mtime >= src.stat().st_mtime:
                print(f"skip (up-to-date): {dest_pdf}")
                continue
            dest_pdf.unlink()
        soffice, python_path, python_home = cast(tuple[Path, str, str], lo_paths)
        try:
            convert_pptx_to_pdf(soffice, python_path, python_home, src, dest_dir)
            print(f"ok: {src.name} -> {dest_pdf}")
        except Exception as e:
            print(f"FAIL: {src}\n  {e}", file=sys.stderr)

    for src in pdf_files:
        rel = src.relative_to(raw_root)
        dest = pdf_root / rel
        if args.dry_run:
            print(f"[pdf 복사] {src} -> {dest}")
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.is_file() and dest.stat().st_mtime >= src.stat().st_mtime:
            print(f"skip (up-to-date): {dest}")
            continue
        shutil.copy2(src, dest)
        print(f"ok: {rel}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
