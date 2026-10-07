# Build em duas etapas: a imagem final leva só o código compilado e as dependências de produção.
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm ci --workspace @otilc/api --workspace @otilc/shared --include-workspace-root
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w @otilc/shared && npm run build -w @otilc/api \
  && npm prune --omit=dev --workspace @otilc/api --workspace @otilc/shared

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/packages/shared/package.json packages/shared/
COPY --from=build /repo/packages/shared/dist packages/shared/dist
COPY --from=build /repo/apps/api/package.json apps/api/
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/apps/api/drizzle apps/api/drizzle
WORKDIR /repo/apps/api
USER node
EXPOSE 3333
# Aplica as migrations e sobe a API.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/main.js"]
