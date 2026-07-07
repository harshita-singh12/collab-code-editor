import express from "express";
import cors from "cors";
import { createServer, type Server as HttpServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { env } from "./util/env";
import { optionalAuth } from "./auth/middleware";
import { authRouter } from "./routes/auth";
import { documentsRouter } from "./routes/documents";
import { versionsRouter } from "./routes/versions";
import { usersRouter } from "./routes/users";
import { registerSocketHandlers } from "./socket";
import { attachWebrtcSignaling } from "./webrtc/signalingServer";

export function createApp(): { app: express.Express; httpServer: HttpServer; io: SocketIOServer } {
  const app = express();
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
  app.use(express.json());
  app.use(optionalAuth);

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.use("/api/auth", authRouter);
  app.use("/api/documents", documentsRouter);
  app.use("/api/documents", versionsRouter);
  app.use("/api/users", usersRouter);

  const httpServer = createServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: { origin: env.CORS_ORIGIN, credentials: true },
    maxHttpBufferSize: 10 * 1024 * 1024,
  });
  registerSocketHandlers(io);
  attachWebrtcSignaling(httpServer);

  return { app, httpServer, io };
}
