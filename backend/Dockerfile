FROM python:3.12-slim

RUN useradd -m -u 1000 user
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /home/user/app
COPY --chown=user:user requirements.txt .
USER user
ENV PATH="/home/user/.local/bin:${PATH}" \
    PORT=7860 \
    PYTHONUNBUFFERED=1

RUN pip install --no-cache-dir --user -r requirements.txt

COPY --chown=user:user . .

EXPOSE 7860

CMD ["sh", "-c", "python -m uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-7860}"]

