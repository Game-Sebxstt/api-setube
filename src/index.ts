import "dotenv/config";
import express from "express";
import cors from "cors";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import { config } from "dotenv";
import fs from "fs";
import { ClientsManager } from "./managers/clients.manager.js"
import { PATH_SAVE } from "./config.js";
import { router as audioRouter } from "./routes/audio.route.js";
import { router as videoRouter } from "./routes/video.route.js";
import { eventsController } from "./controllers/events.controller.js";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import hpp from "hpp";

config();
ffmpeg.setFfmpegPath(ffmpegStatic as unknown as string);

const PORT = process.env.PORT || 4001;
const ORIGINS = process.env.ORIGIN?.split(",") || [];

if (!fs.existsSync(PATH_SAVE)) fs.mkdirSync(PATH_SAVE, { recursive: true });

const app = express();

const limiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutes
	max: 100, // Limit each IP to 100 requests per windowMs
	standardHeaders: true,
	legacyHeaders: false,
});

const corsOptions = { 
    origin: ORIGINS, 
    credentials: true, 
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"] 
};

app.use(helmet());
app.use(limiter);
app.use(hpp());

app.use(cors(corsOptions));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ limit: '100kb', extended: true }));

app.get("/events", (req, res) => {
    const clientsManager = ClientsManager.getInstance();
    eventsController(req, res, clientsManager);
});

app.get("/", (req, res) => {
    res.json({ message: "Bienvenido al servidor", author: "Sebxstt", version: "1.0.0" });
});

app.use("/audio", audioRouter);
app.use("/video", videoRouter);

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  console.log(`MP3s guardados en ${PATH_SAVE}`);
});
