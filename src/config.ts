import os from "os";

export const PATH_SAVE = "./output";
export const NUM_CPUS = os.cpus().length;
export const CONCURRENCY = Math.max(1, NUM_CPUS);