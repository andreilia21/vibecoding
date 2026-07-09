FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash codex

USER codex
WORKDIR /app

COPY --chown=codex:codex package.json ./
RUN npm install

COPY --chown=codex:codex src ./src

ENV NODE_ENV=production
ENV WORKER_PORT=3000
ENV CODEX_HOME=/home/codex/.codex
ENV REPOS_DIR=/work/repos
ENV JOBS_DIR=/work/jobs

EXPOSE 3000

CMD ["npm", "start"]
