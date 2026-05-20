import shutil
from pathlib import Path
from uuid import uuid4

import fitz
from fastapi import UploadFile
from PIL import Image, ImageOps, UnidentifiedImageError

from app.config import get_settings
from app.raw_extractor import convert_office_to_pdf


ALLOWED_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".docx", ".pptx"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg"}
OFFICE_EXTENSIONS = {".docx", ".pptx"}


class DocumentProcessingError(ValueError):
    pass


def validate_upload(filename: str) -> str:
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise DocumentProcessingError("Only PDF, PNG, JPG, JPEG, DOCX, and PPTX files are supported")
    return suffix


def save_upload_file(upload: UploadFile) -> tuple[str, Path, int]:
    suffix = validate_upload(upload.filename or "")
    settings = get_settings()
    document_dir = settings.resolved_storage_dir / uuid4().hex
    document_dir.mkdir(parents=True, exist_ok=True)
    original_path = document_dir / f"original{suffix}"

    size = 0
    with original_path.open("wb") as destination:
        while True:
            chunk = upload.file.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            destination.write(chunk)

    return upload.filename or original_path.name, original_path, size


def rasterize_document(source_path: Path) -> list[dict[str, int | str]]:
    suffix = source_path.suffix.lower()
    page_dir = source_path.parent / "pages"
    page_dir.mkdir(parents=True, exist_ok=True)

    if suffix == ".pdf":
        return _rasterize_pdf(source_path, page_dir)
    if suffix in IMAGE_EXTENSIONS:
        return _rasterize_image(source_path, page_dir)
    if suffix in OFFICE_EXTENSIONS:
        return _rasterize_office(source_path, suffix, page_dir)
    raise DocumentProcessingError("Unsupported document type")


def is_supported_image(source_path: Path) -> bool:
    return source_path.suffix.lower() in IMAGE_EXTENSIONS


def read_image_size(source_path: Path) -> tuple[int, int]:
    try:
        with Image.open(source_path) as source:
            image = ImageOps.exif_transpose(source)
            return image.size
    except UnidentifiedImageError as exc:
        raise DocumentProcessingError("Failed to read image") from exc
    except OSError as exc:
        raise DocumentProcessingError("Failed to process image") from exc


def rasterize_image_page(source_path: Path, page_dir: Path) -> dict[str, int | str]:
    image_path = page_dir / "page_1.png"
    page_dir.mkdir(parents=True, exist_ok=True)
    try:
        with Image.open(source_path) as source:
            image = ImageOps.exif_transpose(source)
            if image.mode == "RGBA":
                background = Image.new("RGB", image.size, (255, 255, 255))
                background.paste(image, mask=image.getchannel("A"))
                image = background
            elif image.mode != "RGB":
                image = image.convert("RGB")
            width, height = image.size
            image.save(image_path, format="PNG")
    except UnidentifiedImageError as exc:
        raise DocumentProcessingError("Failed to read image") from exc
    except OSError as exc:
        raise DocumentProcessingError("Failed to process image") from exc

    return {
        "page_number": 1,
        "image_path": str(image_path),
        "width": width,
        "height": height,
    }


def _rasterize_office(source_path: Path, suffix: str, page_dir: Path) -> list[dict[str, int | str]]:
    pdf_path = source_path.parent / "preview.pdf"
    convert_office_to_pdf(source_path, suffix, pdf_path)
    return _rasterize_pdf(pdf_path, page_dir)


def _rasterize_pdf(source_path: Path, page_dir: Path) -> list[dict[str, int | str]]:
    pages: list[dict[str, int | str]] = []
    try:
        with fitz.open(source_path) as document:
            if document.page_count == 0:
                raise DocumentProcessingError("PDF has no pages")
            for index, page in enumerate(document, start=1):
                pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
                image_path = page_dir / f"page_{index}.png"
                pixmap.save(image_path)
                pages.append(
                    {
                        "page_number": index,
                        "image_path": str(image_path),
                        "width": pixmap.width,
                        "height": pixmap.height,
                    }
                )
    except fitz.FileDataError as exc:
        raise DocumentProcessingError("Failed to read PDF") from exc
    return pages


def _rasterize_image(source_path: Path, page_dir: Path) -> list[dict[str, int | str]]:
    try:
        return [rasterize_image_page(source_path, page_dir)]
    except DocumentProcessingError:
        image_path = page_dir / "page_1.png"
        shutil.copyfile(source_path, image_path)
        with fitz.open(image_path) as document:
            page = document[0]
            return [
                {
                    "page_number": 1,
                    "image_path": str(image_path),
                    "width": int(page.rect.width),
                    "height": int(page.rect.height),
                }
            ]
