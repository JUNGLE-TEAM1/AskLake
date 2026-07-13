FROM apache/spark:4.0.1 AS spark-runtime

USER root
COPY --chown=185:185 scripts /opt/asklake/scripts
RUN chmod -R a=rX /opt/asklake/scripts
USER 185:185

FROM python:3.13-slim AS backend-runtime

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV APP_ENV=production

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends nodejs npm ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN python -c "import duckdb; connection = duckdb.connect(); connection.execute('INSTALL httpfs'); connection.close()"

COPY package*.json ./
RUN npm ci --omit=dev

COPY app ./app
COPY scripts ./scripts
COPY fixtures ./fixtures
COPY src ./src

EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
