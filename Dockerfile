# Use a slimmer Node base to reduce image size
FROM --platform=$TARGETPLATFORM node:18-slim

# Install all needed packages for Puppeteer, Docker CLI, git, and curl
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    git \
    docker.io \
    curl \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    wget \
    xdg-utils \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Docker Compose from GitHub releases
RUN curl -L "https://github.com/docker/compose/releases/download/1.29.2/docker-compose-$(uname -s)-$(uname -m)" \
    -o /usr/local/bin/docker-compose && \
    chmod +x /usr/local/bin/docker-compose

# Set the working directory
WORKDIR /usr/src/app

# Copy only package.json/package-lock.json first so Docker can cache npm install
COPY package*.json ./

# Skip Puppeteer browser download during install
ENV PUPPETEER_SKIP_DOWNLOAD=1
# Install Node dependencies
RUN npm install

# (Optional) Install Playwright + browsers if needed:
# RUN npx playwright install --with-deps

# Copy the rest of your code
COPY . .
# Add startup helper
COPY start.sh ./start.sh
RUN chmod +x start.sh

# Build TypeScript (if you have a build script)
RUN npm run build || echo "No build script found"

# Expose the ports
EXPOSE 52784
EXPOSE 60123

# Start the application through the helper script
CMD ["./start.sh"]
