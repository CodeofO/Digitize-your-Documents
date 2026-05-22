FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/backend \
    APP_ENV=production \
    STORAGE_BACKEND=local \
    DOCUMENT_STORAGE_DIR=/data/documents \
    RAW_STORAGE_DIR=/data/raw \
    PROCESSING_TMP_DIR=/data/processing

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libreoffice \
        fonts-noto-cjk \
        curl \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /usr/sbin/nologin appuser

WORKDIR /app
COPY backend/pyproject.toml /app/backend/pyproject.toml
COPY backend/app /app/backend/app
COPY backend/alembic.ini /app/backend/alembic.ini
COPY backend/alembic /app/backend/alembic

RUN pip install --no-cache-dir -e /app/backend

RUN mkdir -p /data/documents /data/raw /data/processing \
    && chown -R appuser:appuser /data /app

USER appuser
WORKDIR /app/backend

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
