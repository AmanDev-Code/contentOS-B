FROM node:22-bookworm-slim AS builder

WORKDIR /app

ENV NODE_ENV=development

# Install build tools for native modules (canvas, sharp)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    libcairo2-dev \
    libjpeg-dev \
    libpango1.0-dev \
    libgif-dev \
    librsvg2-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN npm run build

# Production deps only (reuses same build tools)
RUN rm -rf node_modules && npm ci --omit=dev

FROM node:22-bookworm-slim

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Layer 1: System deps for Playwright + FFmpeg + canvas runtime libs
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    ffmpeg \
    fontconfig \
    fonts-dejavu \
    fonts-freefont-ttf \
    fonts-ipafont-gothic \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-tlwg-loma-otf \
    fonts-unifont \
    fonts-wqy-zenhei \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libjpeg62-turbo \
    libgif7 \
    librsvg2-2 \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

# Copy pre-built production node_modules from builder (avoids needing build tools here)
COPY --from=builder /app/node_modules ./node_modules
COPY package.json package-lock.json ./

# Layer 2: Playwright Chromium binary only (no --with-deps since deps already installed above)
RUN npx playwright install chromium

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/assets ./assets

EXPOSE 3000

CMD ["node", "dist/src/main.js"]
