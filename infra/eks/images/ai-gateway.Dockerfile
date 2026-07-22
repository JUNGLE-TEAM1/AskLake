FROM python:3.13-slim

ARG ASKLAKE_RELEASE_REVISION=unknown
LABEL org.opencontainers.image.revision="$ASKLAKE_RELEASE_REVISION" \
      com.asklake.release.profile="ec2-recovery-e6f86eb8"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY ai-server/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid 10001 --home-dir /app --shell /usr/sbin/nologin app
COPY --chown=10001:10001 ai-server/app ./app
USER 10001:10001

EXPOSE 8090
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8090"]
