# Cloud Run Job that refreshes the fuel price files and publishes them to GitHub Pages.
# Runs in London (europe-west2): the Fuel Finder API only answers UK addresses.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY scripts ./scripts
CMD ["sh", "scripts/publish.sh"]
