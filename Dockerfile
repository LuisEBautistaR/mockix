# Mockix CLI image: serves the mocks of the workspace mounted on /mocks.
#
#   npm run docker            (bundles the CLI into packages/cli/npm, then builds)
#   docker run --rm --read-only -v ./MiProyecto:/mocks -p 3000:3000 mockix:dev
#
# The runtime has no shell and no package manager, runs as a non-root user and
# only needs /mocks/.mockix to be writable (TLS certificates, recordings).

FROM node:24-alpine AS deps
WORKDIR /app
COPY packages/cli/npm/package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY packages/cli/npm/dist ./dist
COPY packages/cli/npm/README.md ./

FROM gcr.io/distroless/nodejs24-debian12:nonroot
LABEL org.opencontainers.image.title="Mockix" \
      org.opencontainers.image.description="Simulador de APIs: HTTP, WebSocket, Socket.IO y gRPC" \
      org.opencontainers.image.source="https://github.com/LuisEBautistaR/mockix" \
      org.opencontainers.image.vendor="protohub.digital"
ENV NODE_ENV=production \
    MOCKIX_HEALTH_PORT=3000
WORKDIR /app
COPY --from=deps --chown=nonroot:nonroot /app /app
USER nonroot
EXPOSE 3000
# /__mockix/health always answers, without the control token.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+process.env.MOCKIX_HEALTH_PORT+'/__mockix/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/nodejs/bin/node", "/app/dist/bin.js"]
CMD ["serve", "/mocks", "--host", "0.0.0.0", "--no-watch"]
