FROM node:20-slim

# Install dependencies
RUN apt-get update && apt-get install -y curl ffmpeg unzip && rm -rf /var/lib/apt/lists/*

# Install Deno (JS runtime for yt-dlp)
RUN curl -fsSL https://deno.land/install.sh | sh
ENV DENO_INSTALL="/root/.deno"
ENV PATH="$DENO_INSTALL/bin:$PATH"

# Download yt-dlp binary
RUN mkdir -p /app/bin && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /app/bin/yt-dlp && \
    chmod +x /app/bin/yt-dlp

WORKDIR /app
COPY package.json ./
RUN npm install
COPY server.js ./

EXPOSE 3001
CMD ["node", "server.js"]
