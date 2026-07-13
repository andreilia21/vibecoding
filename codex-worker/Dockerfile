FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client \
  && rm -rf /var/lib/apt/lists/*

# Delete the existing 'node' user so we can reuse UID 1000 for 'codex'
RUN userdel -r node \
  && useradd --uid 1000 --create-home --shell /bin/bash codex

WORKDIR /app

# Ensure we create this directory and set permissions so codex can write to it later
RUN mkdir -p /work/repos && chown -R codex:codex /work

COPY --chown=codex:codex package.json ./
RUN npm install

COPY --chown=codex:codex src ./src
COPY docker-entrypoint.sh /usr/local/bin/codex-worker-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/codex-worker-entrypoint \
  && chmod +x /usr/local/bin/codex-worker-entrypoint

ENV NODE_ENV=production
ENV WORKER_PORT=3000
ENV CODEX_HOME=/home/codex/.codex
ENV REPOS_DIR=/work/repos
ENV MONGO_URL=mongodb://job-db:27017/codex-worker

EXPOSE 3000

ENTRYPOINT ["codex-worker-entrypoint"]
CMD ["npm", "start"]
