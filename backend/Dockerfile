FROM maven:3.9.11-eclipse-temurin-17 AS spark-msk-iam-shaded

WORKDIR /build
COPY spark-msk-iam-shaded/pom.xml ./pom.xml
RUN mvn --batch-mode --no-transfer-progress -DskipTests package \
  && jar tf target/aws-msk-iam-auth-2.3.6-asklake-shaded.jar > /tmp/msk-iam-jar-contents.txt \
  && grep -q '^software/amazon/msk/auth/iam/IAMClientCallbackHandler.class$' /tmp/msk-iam-jar-contents.txt \
  && grep -q '^com/asklake/spark/msk/shadow/software/amazon/awssdk/core/' /tmp/msk-iam-jar-contents.txt \
  && grep -q '^com/asklake/spark/msk/shadow/io/netty/' /tmp/msk-iam-jar-contents.txt \
  && if grep -Eq '^(software/amazon/awssdk|io/netty)/' /tmp/msk-iam-jar-contents.txt; then exit 1; fi

FROM maven:3.9.11-eclipse-temurin-17 AS spark-runtime-dependencies

WORKDIR /build
COPY spark-runtime-dependencies/pom.xml ./pom.xml
RUN mvn --batch-mode --no-transfer-progress \
      org.apache.maven.plugins:maven-dependency-plugin:3.8.1:copy-dependencies \
      -DincludeScope=runtime \
      -DoutputDirectory=/build/jars \
  && test -f /build/jars/spark-sql-kafka-0-10_2.13-4.0.1.jar \
  && test -f /build/jars/hadoop-aws-3.4.1.jar \
  && test -f /build/jars/iceberg-spark-runtime-4.0_2.13-1.11.0.jar \
  && test -f /build/jars/postgresql-42.7.7.jar \
  && test "$(find /build/jars -maxdepth 1 -name 'kafka-clients-*.jar' | wc -l)" -eq 1 \
  && test "$(find /build/jars -maxdepth 1 -name 'bundle-*.jar' | wc -l)" -eq 1

FROM apache/spark:4.0.1 AS spark-runtime

USER root
COPY --chown=185:185 scripts /opt/asklake/scripts
COPY --from=spark-runtime-dependencies --chown=185:185 /build/jars/ /opt/spark/jars/
COPY --from=spark-msk-iam-shaded --chown=185:185 \
  /build/target/aws-msk-iam-auth-2.3.6-asklake-shaded.jar \
  /opt/asklake/jars/aws-msk-iam-auth-2.3.6-asklake-shaded.jar
RUN chmod -R a=rX /opt/asklake/scripts /opt/asklake/jars /opt/spark/jars \
  && test -r /opt/asklake/jars/aws-msk-iam-auth-2.3.6-asklake-shaded.jar \
  && test -r /opt/spark/jars/spark-sql-kafka-0-10_2.13-4.0.1.jar \
  && test -r /opt/spark/jars/hadoop-aws-3.4.1.jar \
  && test -r /opt/spark/jars/iceberg-spark-runtime-4.0_2.13-1.11.0.jar \
  && test -r /opt/spark/jars/postgresql-42.7.7.jar \
  && install -d -o 185 -g 185 -m 0750 \
    /work \
    /work/output \
    /work/reports \
    /work/review-text-models
USER 185:185

FROM python:3.13-slim AS backend-runtime

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV APP_ENV=production
ENV PYTHONPATH=/app

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends nodejs npm ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN python -c "import duckdb; connection = duckdb.connect(); connection.execute('INSTALL httpfs'); connection.execute('INSTALL aws'); connection.close()"

COPY package*.json ./
RUN npm run install:production

COPY app ./app
COPY alembic.ini ./alembic.ini
COPY alembic ./alembic
COPY scripts ./scripts
COPY fixtures ./fixtures
COPY src ./src

EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
