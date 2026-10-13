import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// .env 파일이 있으면 읽습니다(이미 설정된 환경 변수가 우선).
const envFile = path.join(APP_ROOT, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export const config = {
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || "127.0.0.1",
  dataDir: path.resolve(APP_ROOT, process.env.DATA_DIR || "data"),
  projectName: process.env.PROJECT_NAME || "콜드체인 프로젝트",
  model: process.env.ASSISTANT_MODEL || "claude-opus-5-5",
  effort: EFFORTS.includes(process.env.ASSISTANT_EFFORT) ? process.env.ASSISTANT_EFFORT : "high",
  // 비워 두면 인증 없이 열립니다. 팀에 공유하는 서버라면 꼭 설정하세요.
  appPassword: process.env.APP_PASSWORD || "",
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB) || 50,
};
