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

EXPOSE 3000
CMD ["npm", "run", "dev"]

