# Base: official pgvector image (Postgres 16 + pgvector pre-installed on Debian bookworm)
FROM pgvector/pgvector:pg16

# Optional: install Apache AGE for openCypher graph queries.
# If this fails (e.g. aarch64 with no pre-built .deb), the system still works —
# graph traversal falls back to recursive CTEs in plain SQL.
#
# To enable, build with: docker build -t flock-pg docker/
# Then set `image: flock-pg` in compose.yml instead of `pgvector/pgvector:pg16`.
#
# RUN apt-get update && apt-get install -y build-essential git postgresql-server-dev-16 \
#     && git clone --depth 1 --branch v1.5.0 https://github.com/apache/age.git /tmp/age \
#     && cd /tmp/age && make install \
#     && rm -rf /tmp/age \
#     && apt-get purge -y build-essential git postgresql-server-dev-16 \
#     && apt-get autoremove -y \
#     && apt-get clean && rm -rf /var/lib/apt/lists/*
