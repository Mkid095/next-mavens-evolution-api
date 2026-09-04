FROM node:20 AS builder

RUN apt-get update && \
    apt-get install -y --no-install-recommends git ffmpeg wget curl dos2unix && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

LABEL version="1.0.0" description="Next Mavens Fidscript WhatsApp API - Enterprise WhatsApp Business API Platform"
LABEL maintainer="Next Mavens" git="https://github.com/NextMavens/fidscript-whatsapp-api"
LABEL contact="info@nextmavens.com"

WORKDIR /fidscript

COPY ./package*.json ./
COPY ./tsconfig.json ./
COPY ./tsup.config.ts ./

RUN npm ci --silent

COPY ./src ./src
COPY ./public ./public
COPY ./prisma ./prisma
COPY ./node_modules/.prisma ./node_modules/.prisma
COPY ./.env.example ./.env
COPY ./runWithProvider.js ./

COPY ./Docker ./Docker

RUN chmod +x ./Docker/scripts/* && dos2unix ./Docker/scripts/*

# Copy pre-generated Prisma client (with query engine binary) to override
# whatever npm ci installed (avoiding SIGSEGV in prisma CLI at build time)
COPY ./node_modules/.prisma ./node_modules/.prisma

RUN npx tsup

FROM node:20-slim AS final

RUN apt-get update && \
    apt-get install -y --no-install-recommends tzdata ffmpeg postgresql-client bash && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

ENV TZ=UTC
ENV DOCKER_ENV=true

WORKDIR /fidscript

COPY --from=builder /fidscript/package.json ./package.json
COPY --from=builder /fidscript/package-lock.json ./package-lock.json

COPY --from=builder /fidscript/node_modules ./node_modules
COPY --from=builder /fidscript/dist ./dist
COPY --from=builder /fidscript/prisma ./prisma
COPY --from=builder /fidscript/public ./public
COPY --from=builder /fidscript/.env ./.env
COPY --from=builder /fidscript/Docker ./Docker
COPY --from=builder /fidscript/runWithProvider.js ./runWithProvider.js
COPY --from=builder /fidscript/tsup.config.ts ./tsup.config.ts

ENV DOCKER_ENV=true

EXPOSE 8080

COPY <<'EOF' /entrypoint.sh
#!/bin/sh
set -e

# Determine postgres host: use POSTGRES_HOST env if set, else fall back to 'postgres'
PGHOST="${POSTGRES_HOST:-postgres}"

# Ensure evolution DB exists (quoted heredoc so $vars expand at container RUNTIME)
if PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$PGHOST" -U "${POSTGRES_USER:-fidscript}" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='evolution'" | grep -q 1; then
  echo "evolution database already exists"
else
  echo "Creating evolution database..."
  PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$PGHOST" -U "${POSTGRES_USER:-fidscript}" -d postgres -c "CREATE DATABASE evolution"
fi

# Symlink migrations folder so Prisma CLI can find it
if [ ! -L prisma/migrations ] && [ -d prisma/postgresql-migrations ]; then
  ln -s postgresql-migrations prisma/migrations
  echo "Created migrations symlink"
fi

# Run pending migrations
echo "Running migrations..."
DATABASE_PROVIDER=postgresql npx prisma migrate deploy --schema prisma/postgresql-schema.prisma

# Start the server
npm run start:prod
EOF
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
