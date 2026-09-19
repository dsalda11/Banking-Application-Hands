FROM maven:3.8.8-eclipse-temurin-8 AS build
WORKDIR /build
COPY pom.xml .
COPY .mvn .mvn
RUN mvn -B -DskipTests dependency:go-offline
COPY src src
RUN mvn -B -DskipTests clean package

FROM eclipse-temurin:8-jre-jammy
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home appuser
WORKDIR /app
COPY --from=build /build/target/demo-0.0.1-SNAPSHOT.war app.war
RUN chown -R appuser:appuser /app
USER appuser
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=45s --retries=12 CMD curl --fail --silent http://127.0.0.1:8080/index >/dev/null || exit 1
ENTRYPOINT ["java", "-jar", "/app/app.war"]
