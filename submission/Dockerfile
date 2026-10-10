# One image for the whole app: the Angular build is served by the API.
# Build context is this folder (submission/):
#   docker build -t dataveil submission
#   docker run -p 10000:10000 --env-file submission/backend/.env dataveil

FROM node:22-alpine AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npx ng build --configuration production

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
# detector.py reads ../prompt.txt, as in the repository.
COPY prompt.txt /app/prompt.txt
COPY backend/ ./
COPY --from=frontend /frontend/dist/dataveil/browser ./static
RUN useradd --create-home app && chown -R app /app
USER app
# The Gemini key comes from the platform's environment, never the image.
# One worker: analyses live in memory between /analyze and /anonymize.
CMD ["sh", "-c", "uvicorn api.main:app --host 0.0.0.0 --port ${PORT:-10000} --workers 1"]
