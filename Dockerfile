# QAmcp in a box: nothing to install.
#
#   docker build -t qamcp .
#   docker run --rm qamcp https://mcp.example.com/mcp
#   docker run --rm -v "$PWD:/work" qamcp https://mcp.example.com/mcp --junit report.xml --fail-under 80

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --no-audit --no-fund --loglevel=error
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Reports land in /work, which you mount from your own folder.
RUN mkdir -p /work && chown node:node /work
USER node
WORKDIR /work
ENV NODE_ENV=production
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["--help"]
