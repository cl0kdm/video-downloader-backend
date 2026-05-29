const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const archiver = require("archiver");

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST"], allowedHeaders: ["Content-Type"] }));
app.use(express.json());

const DOWNLOAD_DIR = path.join(os.tmpdir(), "yt-dlp-downloads");
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

const YTDLP_PATH = "/app/bin/yt-dlp";
const YT_ARGS = [
  "--extractor-args", `youtube:player_client=web,default`,
  "--cookies", "/app/cookies.txt",
  "--sleep-requests", "2",
  "--sleep-interval", "3"
];

const QUALITY_MAP = {
  "Best available":   "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
  "1080p":            "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]",
  "720p":             "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]",
  "480p":             "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480]",
  "360p":             "bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360]",
  "Audio only (MP3)": "bestaudio/best",
};

function runYtdlp(args) {
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "";
    const p = spawn(YTDLP_PATH, args);
    p.stdout.on("data", c => stdout += c);
    p.stderr.on("data", c => stderr += c);
    p.on("close", code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  });
}

function spawnYtdlpWithProgress(args, onProgress) {
  return new Promise((resolve) => {
    const p = spawn(YTDLP_PATH, args);
    p.stdout.on("data", chunk => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const m = line.match(/(\d+(?:\.\d+)?)%/);
        if (m) onProgress(parseFloat(m[1]), line.trim());
      }
    });
    p.on("close", () => resolve());
  });
}

function createZip(sourceDir, zipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 6 } });
    output.on("close", () => {
      console.log("ZIP created, size:", archive.pointer(), "bytes");
      resolve();
    });
    archive.on("error", reject);
    archive.pipe(output);
    // Add files individually to ensure they're all included
    const files = fs.readdirSync(sourceDir);
    console.log("Files to zip:", files);
    for (const file of files) {
      archive.file(path.join(sourceDir, file), { name: file });
    }
    archive.finalize();
  });
}

app.post("/api/info", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });
  try {
    const stdout = await runYtdlp(["--dump-json", "--no-playlist", ...YT_ARGS, url]);
    const info = JSON.parse(stdout);
    res.json({
      title:      info.title,
      uploader:   info.uploader || info.channel || "Unknown",
      thumbnail:  info.thumbnail,
      duration:   formatDuration(info.duration),
      view_count: info.view_count,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/playlist-info", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });
  try {
    const stdout = await runYtdlp(["--dump-json", "--flat-playlist", "--yes-playlist", ...YT_ARGS, url]);
    const videos = stdout.trim().split("\n").filter(Boolean).map((line, i) => {
      const v = JSON.parse(line);
      return {
        index: i, id: v.id,
        title: v.title || `Video ${i + 1}`,
        duration: formatDuration(v.duration),
        thumbnail: v.thumbnail || v.thumbnails?.[0]?.url || null,
        url: v.url || v.webpage_url || `https://www.youtube.com/watch?v=${v.id}`,
        uploader: v.uploader || v.channel || ""
      };
    });
    res.json({ videos, total: videos.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/download", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const { url, quality = "Best available" } = req.query;
  if (!url) { send({ type:"error", text:"URL required" }); return res.end(); }
  const format = QUALITY_MAP[quality] || QUALITY_MAP["Best available"];
  const isAudio = quality === "Audio only (MP3)";
  const timestamp = Date.now();
  const outputTemplate = path.join(DOWNLOAD_DIR, `${timestamp}_%(title)s.%(ext)s`);
  const args = [
    "--no-playlist", "--format", format,
    "--output", outputTemplate, "--newline",
    "--progress-template", "%(progress._percent_str)s %(progress._speed_str)s %(progress._eta_str)s",
    ...YT_ARGS
  ];
  if (isAudio) args.push("--extract-audio", "--audio-format", "mp3", "--audio-quality", "0");
  else args.push("--merge-output-format", "mp4");
  args.push(url);
  const ytdlp = spawn(YTDLP_PATH, args);
  ytdlp.stdout.on("data", chunk => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      const m = line.match(/(\d+(?:\.\d+)?)%/);
      if (m) send({ type:"progress", percent:Math.round(parseFloat(m[1])), text:line.trim() });
    }
  });
  ytdlp.stderr.on("data", chunk => {
    if (chunk.toString().toLowerCase().includes("error"))
      send({ type:"error", text:chunk.toString().trim() });
  });
  ytdlp.on("close", code => {
    if (code !== 0) { send({ type:"error", text:"Download failed." }); return res.end(); }
    const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(String(timestamp)));
    if (!files.length) send({ type:"error", text:"File not found after download." });
    else send({ type:"done", filename:files[0] });
    res.end();
  });
  req.on("close", () => ytdlp.kill("SIGTERM"));
});

app.get("/api/download-playlist", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const { urls, quality = "Best available" } = req.query;
  if (!urls) { send({ type:"error", text:"No URLs provided" }); return res.end(); }

  const videoUrls = JSON.parse(decodeURIComponent(urls));
  const format = QUALITY_MAP[quality] || QUALITY_MAP["Best available"];
  const isAudio = quality === "Audio only (MP3)";
  const timestamp = Date.now();
  const sessionDir = path.join(DOWNLOAD_DIR, `playlist_${timestamp}`);
  fs.mkdirSync(sessionDir, { recursive: true });
  const total = videoUrls.length;

  for (let i = 0; i < total; i++) {
    const url = videoUrls[i];
    const outputTemplate = path.join(sessionDir, `${i+1}_%(title)s.%(ext)s`);
    const args = [
      "--format", format, "--output", outputTemplate, "--newline",
      "--progress-template", "%(progress._percent_str)s %(progress._speed_str)s",
      "--no-playlist", ...YT_ARGS
    ];
    if (isAudio) args.push("--extract-audio", "--audio-format", "mp3", "--audio-quality", "0");
    else args.push("--merge-output-format", "mp4");
    args.push(url);

    send({ type:"progress", percent:Math.round((i/total)*95), text:`Downloading video ${i+1} of ${total}…` });

    // Await each download fully before moving to next
    await spawnYtdlpWithProgress(args, (pct, text) => {
      const overall = Math.round((i/total)*95 + (pct/100)*(95/total));
      send({ type:"progress", percent:overall, text:`Video ${i+1}/${total}: ${text}` });
    });
  }

  send({ type:"progress", percent:98, text:"All videos downloaded, creating ZIP…" });

  // Wait a moment to ensure all file handles are released
  await new Promise(r => setTimeout(r, 2000));

  const zipPath = path.join(DOWNLOAD_DIR, `playlist_${timestamp}.zip`);
  try {
    await createZip(sessionDir, zipPath);
    fs.rmSync(sessionDir, { recursive:true, force:true });
    send({ type:"done", filename:`playlist_${timestamp}.zip` });
  } catch(e) {
    send({ type:"error", text:"Failed to create ZIP: " + e.message });
  }
  res.end();
});

app.get("/api/file/:filename", (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(DOWNLOAD_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });
  res.download(filePath, filename, err => { if (!err) fs.unlink(filePath, () => {}); });
});

function formatDuration(s) {
  if (!s) return "";
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  return h > 0 ? `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}` : `${m}:${String(sec).padStart(2,"0")}`;
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
