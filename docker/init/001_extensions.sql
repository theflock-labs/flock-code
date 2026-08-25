-- Load pgvector (always present in pgvector/pgvector:pg16 image)
CREATE EXTENSION IF NOT EXISTS vector;

-- Load Apache AGE if available (optional — graph queries fall back to recursive CTEs without it)
-- Uncomment after building the custom image from docker/Dockerfile
-- CREATE EXTENSION IF NOT EXISTS age;
