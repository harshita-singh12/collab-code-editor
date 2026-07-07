import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { resetDb, closeDb } from "./testDb";
import { createApp } from "../src/app";
import { findUserByEmail, verifyPassword } from "../src/db/usersRepo";
import { redisBus } from "../src/redis/pubsub";

/**
 * Real email/password authentication: signup hashes the password with
 * argon2id (never stores or returns it in plaintext), login verifies
 * against that hash, and both issue the same JWT used everywhere else in
 * this app for REST/Socket.io/WebRTC-signaling auth.
 */
describe("authentication", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await closeDb();
    await redisBus.close();
  });

  describe("POST /api/auth/signup", () => {
    it("creates a new account and returns a usable bearer token", async () => {
      const { app } = createApp();
      const res = await request(app)
        .post("/api/auth/signup")
        .send({ email: "alice@example.com", password: "correct-horse-battery", displayName: "Alice" })
        .expect(201);

      expect(res.body.token).toEqual(expect.any(String));
      expect(res.body.user.displayName).toBe("Alice");
      expect(res.body.user.color).toEqual(expect.any(String));

      // The token actually authenticates against a protected route.
      await request(app)
        .get("/api/documents")
        .set("Authorization", `Bearer ${res.body.token}`)
        .expect(200);
    });

    it("stores the password hashed with argon2id, never in plaintext", async () => {
      const { app } = createApp();
      await request(app)
        .post("/api/auth/signup")
        .send({ email: "bob@example.com", password: "hunter2-hunter2", displayName: "Bob" })
        .expect(201);

      const user = await findUserByEmail("bob@example.com");
      expect(user).not.toBeNull();
      expect(user!.password_hash).not.toBe("hunter2-hunter2");
      expect(user!.password_hash.startsWith("$argon2id$")).toBe(true);
      expect(await verifyPassword(user!, "hunter2-hunter2")).toBe(true);
      expect(await verifyPassword(user!, "wrong-password")).toBe(false);
    });

    it("rejects signing up with an email that's already registered", async () => {
      const { app } = createApp();
      await request(app)
        .post("/api/auth/signup")
        .send({ email: "dup@example.com", password: "password-one", displayName: "One" })
        .expect(201);

      await request(app)
        .post("/api/auth/signup")
        .send({ email: "dup@example.com", password: "password-two", displayName: "Two" })
        .expect(409);
    });

    it("rejects an invalid email", async () => {
      const { app } = createApp();
      await request(app)
        .post("/api/auth/signup")
        .send({ email: "not-an-email", password: "password123", displayName: "X" })
        .expect(400);
    });

    it("rejects a password shorter than 8 characters", async () => {
      const { app } = createApp();
      await request(app)
        .post("/api/auth/signup")
        .send({ email: "short@example.com", password: "short1", displayName: "X" })
        .expect(400);
    });

    it("rejects a missing display name", async () => {
      const { app } = createApp();
      await request(app)
        .post("/api/auth/signup")
        .send({ email: "noname@example.com", password: "password123", displayName: "" })
        .expect(400);
    });
  });

  describe("POST /api/auth/login", () => {
    it("logs in with correct credentials", async () => {
      const { app } = createApp();
      await request(app)
        .post("/api/auth/signup")
        .send({ email: "carol@example.com", password: "correct-password", displayName: "Carol" })
        .expect(201);

      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "carol@example.com", password: "correct-password" })
        .expect(200);

      expect(res.body.token).toEqual(expect.any(String));
      expect(res.body.user.displayName).toBe("Carol");
    });

    it("is case-insensitive on email", async () => {
      const { app } = createApp();
      await request(app)
        .post("/api/auth/signup")
        .send({ email: "Eve@Example.com", password: "password123", displayName: "Eve" })
        .expect(201);

      await request(app)
        .post("/api/auth/login")
        .send({ email: "eve@example.com", password: "password123" })
        .expect(200);
    });

    it("rejects an unknown email", async () => {
      const { app } = createApp();
      await request(app)
        .post("/api/auth/login")
        .send({ email: "nobody@example.com", password: "whatever123" })
        .expect(401);
    });

    it("rejects an incorrect password with the same generic error as an unknown email", async () => {
      const { app } = createApp();
      await request(app)
        .post("/api/auth/signup")
        .send({ email: "dave@example.com", password: "right-password", displayName: "Dave" })
        .expect(201);

      const wrongPassRes = await request(app)
        .post("/api/auth/login")
        .send({ email: "dave@example.com", password: "wrong-password" })
        .expect(401);
      const unknownEmailRes = await request(app)
        .post("/api/auth/login")
        .send({ email: "nobody-else@example.com", password: "right-password" })
        .expect(401);

      expect(wrongPassRes.body.error).toBe(unknownEmailRes.body.error);
    });
  });

  describe("access control resolved against real signed-up/logged-in accounts", () => {
    it("an owner can create a document and grant a second real account editor access", async () => {
      const { app } = createApp();
      const owner = await request(app)
        .post("/api/auth/signup")
        .send({ email: "owner@example.com", password: "owner-password", displayName: "Owner" })
        .expect(201);
      const other = await request(app)
        .post("/api/auth/signup")
        .send({ email: "other@example.com", password: "other-password", displayName: "Other" })
        .expect(201);

      const doc = await request(app)
        .post("/api/documents")
        .set("Authorization", `Bearer ${owner.body.token}`)
        .send({ title: "Shared Doc" })
        .expect(201);

      await request(app)
        .put(`/api/documents/${doc.body.id}/permissions`)
        .set("Authorization", `Bearer ${owner.body.token}`)
        .send({ userId: other.body.user.id, role: "editor" })
        .expect(200);

      const res = await request(app)
        .get(`/api/documents/${doc.body.id}`)
        .set("Authorization", `Bearer ${other.body.token}`)
        .expect(200);
      expect(res.body.role).toBe("editor");
    });

    it("denies a real account that was never granted access to a link-access=none document", async () => {
      const { app } = createApp();
      const owner = await request(app)
        .post("/api/auth/signup")
        .send({ email: "priv-owner@example.com", password: "owner-password", displayName: "Owner" })
        .expect(201);
      const stranger = await request(app)
        .post("/api/auth/signup")
        .send({ email: "priv-stranger@example.com", password: "stranger-password", displayName: "Stranger" })
        .expect(201);

      const doc = await request(app)
        .post("/api/documents")
        .set("Authorization", `Bearer ${owner.body.token}`)
        .send({ title: "Private Doc" })
        .expect(201);
      await request(app)
        .patch(`/api/documents/${doc.body.id}/link-access`)
        .set("Authorization", `Bearer ${owner.body.token}`)
        .send({ linkAccess: "none" })
        .expect(200);

      await request(app)
        .get(`/api/documents/${doc.body.id}`)
        .set("Authorization", `Bearer ${stranger.body.token}`)
        .expect(403);
    });

    it("logging back in later still resolves to the same owner identity", async () => {
      const { app } = createApp();
      await request(app)
        .post("/api/auth/signup")
        .send({ email: "persist@example.com", password: "persist-password", displayName: "Persist" })
        .expect(201);
      const login1 = await request(app)
        .post("/api/auth/login")
        .send({ email: "persist@example.com", password: "persist-password" })
        .expect(200);

      const doc = await request(app)
        .post("/api/documents")
        .set("Authorization", `Bearer ${login1.body.token}`)
        .send({ title: "Doc" })
        .expect(201);

      const login2 = await request(app)
        .post("/api/auth/login")
        .send({ email: "persist@example.com", password: "persist-password" })
        .expect(200);
      const res = await request(app)
        .get(`/api/documents/${doc.body.id}`)
        .set("Authorization", `Bearer ${login2.body.token}`)
        .expect(200);
      expect(res.body.role).toBe("owner");
    });
  });
});
