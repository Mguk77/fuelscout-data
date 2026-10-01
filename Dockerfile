# One image, two entry points (both run in London, europe-west2; the Fuel Finder API only answers UK addresses):
#   Cloud Run job      fuelscout-updater: node scripts/update.mjs  (default)
#   Cloud Run service  fuelscout-api:     node scripts/server.mjs
FROM node:22-slim
WORKDIR /app
COPY scripts ./scripts
CMD ["node", "scripts/update.mjs"]
