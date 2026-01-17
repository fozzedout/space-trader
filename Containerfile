FROM node:25-bookworm-slim
WORKDIR /app

# If better-sqlite3 needs compiling, install build deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install deps first (better layer caching)
COPY package*.json ./
RUN npm install

# Copy app
COPY . .

# Verify type checking passes before building
RUN npm run type-check

# Build for production
RUN npm run local:build

# Set default port
ENV PORT=3001

EXPOSE 3001

# Run production build by default, but allow override
CMD ["node", "dist/local-server.js"]

