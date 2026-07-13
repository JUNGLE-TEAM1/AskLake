FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends nodejs npm docker-cli ca-certificates \
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
