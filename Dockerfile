FROM node:20-slim

# Install curl and ffmpeg
RUN apt-get update && apt-get install -y curl ffmpeg zip && rm -rf /var/lib/apt/lists/*

# Download yt-dlp binary at build time
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
