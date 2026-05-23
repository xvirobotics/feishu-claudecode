### MetaBot cloud — multi-stage build
###
### Stage 1 installs deps + builds shared/, cloud/ workspaces AND the
### transcript SPA (web/), then syncs the SPA output into cloud/static/ via
### the build:spa script. Stage 2 ships only the runtime bits. Build context
### must be the metabot repo root so the npm workspaces resolve correctly.
###
###   docker build -f cloud/Dockerfile -t metabot-cloud .

ARG NODE_VERSION=20-alpine

FROM node:${NODE_VERSION} AS build
WORKDIR /workspace

COPY package.json package-lock.json* ./
COPY shared/package.json shared/
COPY cloud/package.json cloud/

RUN npm install --include=dev --no-audit --fund=false

COPY shared/ shared/
COPY cloud/ cloud/

RUN npm -w @metabot/shared run build \
 && npm -w @metabot/cloud run build

# Transcript SPA — web/ is not part of the npm workspaces, so install + build
# it on its own and let `npm -w @metabot/cloud run build:spa` copy the output
# (dist/web → cloud/static/transcript-spa) before pruning dev deps.
COPY web/package.json web/package-lock.json* web/
RUN cd web && npm install --include=dev --no-audit --fund=false
COPY web/ web/
RUN cd web && ./node_modules/.bin/vite build \
 && cd .. \
 && npm -w @metabot/cloud run build:spa

RUN npm prune --omit=dev


FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /workspace/package.json /app/package.json
COPY --from=build /workspace/node_modules /app/node_modules
COPY --from=build /workspace/shared/package.json /app/shared/package.json
COPY --from=build /workspace/shared/dist /app/shared/dist
COPY --from=build /workspace/cloud/package.json /app/cloud/package.json
COPY --from=build /workspace/cloud/dist /app/cloud/dist
COPY --from=build /workspace/cloud/static /app/cloud/static

ENV METABOT_CLOUD_PORT=18443
EXPOSE 18443

USER node
CMD ["node", "cloud/dist/server.js"]
