import { Router } from "express";
import { downloadAudio, convertToAudio, playlistToAudio } from "../controllers/audio.controller.js";

const router = Router();

router.post("/download", downloadAudio);
router.post("/convert", convertToAudio);
router.post("/playlist", playlistToAudio);

export { router }