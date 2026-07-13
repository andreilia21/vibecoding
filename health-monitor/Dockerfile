FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY index.html postcss.config.js tailwind.config.js vite.config.js ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim

WORKDIR /app
COPY server.js ./
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
ENV MONITOR_PORT=3001
EXPOSE 3001

CMD ["node", "server.js"]
