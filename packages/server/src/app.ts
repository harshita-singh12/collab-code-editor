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

  // Catch-all error handler: every route above is wrapped in asyncHandler
  // (see util/asyncHandler.ts) so a rejected promise ends up here via
  // `next(err)` instead of becoming an unhandled rejection that would take
  // the whole process down (e.g. a malformed UUID in a path param makes
  // Postgres reject the query). Must be registered last and take exactly
  // four params for Express to recognize it as an error handler.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[server] unhandled request error", err);
    if (res.headersSent) return;
    res.status(500).json({ error: "internal server error" });
  });

  const httpServer = createServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: { origin: env.CORS_ORIGIN, credentials: true },
    maxHttpBufferSize: 10 * 1024 * 1024,
  });
  registerSocketHandlers(io);
  attachWebrtcSignaling(httpServer);

  return { app, httpServer, io };
}
