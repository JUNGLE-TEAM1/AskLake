import crypto from "node:crypto";
import pg from "pg";
import { databaseUrl } from "./metadataStore.mjs";

const { Pool } = pg;

const SESSION_COOKIE_NAME = "asklake_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const DEMO_USERS = [
  {
    displayName: "Admin User",
    email: "admin.user@asklake.local",
    groups: ["data-platform", "analytics", "ops"],
    id: "admin-user",
    password: "asklake-admin",
    role: "admin",
    title: "Platform Admin",
  },
  {
    displayName: "Demo User",
    email: "demo.user@asklake.local",
    groups: ["analytics"],
    id: "demo-user",
    password: "asklake-demo",
    role: "viewer",
    title: "Data Viewer",
  },
];

const pool = new Pool({
  connectionString: databaseUrl,
  connectionTimeoutMillis: Number(process.env.ASKLAKE_DB_CONNECT_TIMEOUT_MS || 10000),
});

let authSchemaReady;
let useMemoryAuth = false;
const memoryAuth = {
  sessions: new Map(),
  usersByEmail: new Map(),
  usersById: new Map(),
};

export async function handleAuthRoute(request, response, url, readJson, sendJson) {
  if (request.method === "GET" && url.pathname === "/api/users/me") {
    const actor = await actorForRequest(request);
    if (!actor) {
      sendJson(response, 401, { error: { code: "AUTH_REQUIRED", message: "Authentication is required." } });
      return true;
    }
    sendJson(response, 200, toCurrentUser(actor));
    return true;
  }

  if (!url.pathname.startsWith("/api/auth/")) return false;

  if (request.method === "GET" && url.pathname === "/api/auth/session") {
    const actor = await actorForRequest(request);
    sendJson(response, 200, { authenticated: Boolean(actor), user: actor ? toCurrentUser(actor) : null });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJson(request);
    const session = await login(body);
    setSessionCookie(response, session.token);
    sendJson(response, 200, { user: toCurrentUser(session.actor) });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/signup") {
    const body = await readJson(request);
    const session = await signup(body);
    setSessionCookie(response, session.token);
    sendJson(response, 201, { user: toCurrentUser(session.actor) });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    const token = sessionTokenFromRequest(request);
    if (token) {
      await ensureAuthSchema();
      if (useMemoryAuth) {
        memoryAuth.sessions.delete(token);
      } else {
        await pool.query("DELETE FROM auth_sessions WHERE token = $1", [token]);
      }
    }
    clearSessionCookie(response);
    sendJson(response, 200, { ok: true });
    return true;
  }

  return false;
}

async function ensureAuthSchema() {
  if (!authSchemaReady) {
    authSchemaReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS auth_users (
          id text PRIMARY KEY,
          email text UNIQUE NOT NULL,
          display_name text NOT NULL,
          role text NOT NULL DEFAULT 'viewer',
          groups jsonb NOT NULL DEFAULT '[]'::jsonb,
          password_hash text NOT NULL,
          password_salt text NOT NULL,
          status text NOT NULL DEFAULT 'active',
          title text,
          last_active_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS auth_sessions (
          token text PRIMARY KEY,
          user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
          expires_at timestamptz NOT NULL,
          user_snapshot jsonb,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE INDEX IF NOT EXISTS auth_users_email_idx ON auth_users (email);
        CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx ON auth_sessions (user_id);
        CREATE INDEX IF NOT EXISTS auth_sessions_expires_at_idx ON auth_sessions (expires_at);
      `);
      await ensureDemoUsers();
    })().catch((error) => {
      if (process.env.ASKLAKE_AUTH_MEMORY_FALLBACK === "false") throw error;
      useMemoryAuth = true;
      seedMemoryDemoUsers();
      console.warn(`AskLake auth DB unavailable; using in-memory auth store. ${error.message}`);
    });
  }
  return authSchemaReady;
}

async function ensureDemoUsers() {
  if (useMemoryAuth) {
    seedMemoryDemoUsers();
    return;
  }
  for (const user of DEMO_USERS) {
    const existing = await pool.query("SELECT id FROM auth_users WHERE id = $1 OR email = $2 LIMIT 1", [user.id, normalizeEmail(user.email)]);
    if (existing.rowCount > 0) continue;
    const salt = crypto.randomBytes(16).toString("hex");
    await pool.query(
      `
        INSERT INTO auth_users (id, email, display_name, role, groups, password_hash, password_salt, status, title)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, 'active', $8)
      `,
      [user.id, normalizeEmail(user.email), user.displayName, user.role, JSON.stringify(user.groups), hashPassword(user.password, salt), salt, user.title],
    );
  }
}

async function signup(body) {
  await ensureAuthSchema();
  const email = normalizeEmail(requiredString(body.email, "Email is required."));
  const password = requiredString(body.password, "Password is required.");
  const displayName = requiredString(body.displayName || body.display_name || email.split("@")[0], "Display name is required.").trim();
  if (!email.includes("@") || !email.split("@")[1]?.includes(".")) {
    throw apiError("AUTH_INVALID_EMAIL", "올바른 이메일 형식으로 입력해 주세요.", 400);
  }
  if (password.length < 8) {
    throw apiError("AUTH_WEAK_PASSWORD", "비밀번호는 8자 이상이어야 합니다.", 400);
  }
  if (useMemoryAuth) {
    if (memoryAuth.usersByEmail.has(email)) {
      throw apiError("AUTH_EMAIL_EXISTS", "이미 가입된 이메일입니다.", 409);
    }
    const salt = crypto.randomBytes(16).toString("hex");
    const user = {
      display_name: displayName,
      email,
      groups: ["analytics"],
      id: uniqueUserId(displayName),
      password_hash: hashPassword(password, salt),
      password_salt: salt,
      role: "viewer",
      status: "active",
      title: "AskLake User",
    };
    writeMemoryUser(user);
    return createSession(user);
  }
  const duplicate = await pool.query("SELECT id FROM auth_users WHERE email = $1", [email]);
  if (duplicate.rowCount > 0) {
    throw apiError("AUTH_EMAIL_EXISTS", "이미 가입된 이메일입니다.", 409);
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const id = uniqueUserId(displayName);
  await pool.query(
    `
      INSERT INTO auth_users (id, email, display_name, role, groups, password_hash, password_salt, status, title)
      VALUES ($1, $2, $3, 'viewer', $4::jsonb, $5, $6, 'active', 'AskLake User')
    `,
    [id, email, displayName, JSON.stringify(["analytics"]), hashPassword(password, salt), salt],
  );
  const user = await findUserByEmail(email);
  return createSession(user);
}

async function login(body) {
  await ensureAuthSchema();
  const email = normalizeEmail(requiredString(body.email, "Email is required."));
  const password = requiredString(body.password, "Password is required.");
  const user = await findUserByEmail(email);
  if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
    throw apiError("AUTH_INVALID_CREDENTIALS", "이메일 또는 비밀번호를 확인해 주세요.", 401);
  }
  if (user.status !== "active") {
    throw apiError("AUTH_INACTIVE_USER", "비활성화된 계정입니다.", 403);
  }
  if (useMemoryAuth) {
    user.last_active_at = new Date();
  } else {
    await pool.query("UPDATE auth_users SET last_active_at = now(), updated_at = now() WHERE id = $1", [user.id]);
  }
  return createSession(user);
}

async function actorForRequest(request) {
  await ensureAuthSchema();
  const token = sessionTokenFromRequest(request);
  if (!token) return null;
  if (useMemoryAuth) {
    const session = memoryAuth.sessions.get(token);
    if (!session || session.expires_at <= new Date()) {
      memoryAuth.sessions.delete(token);
      return null;
    }
    const user = memoryAuth.usersById.get(session.user_id);
    if (!user || user.status !== "active") return null;
    return toActor(user);
  }
  const result = await pool.query(
    `
      SELECT u.*
      FROM auth_sessions s
      JOIN auth_users u ON u.id = s.user_id
      WHERE s.token = $1
        AND s.expires_at > now()
        AND u.status = 'active'
      LIMIT 1
    `,
    [token],
  );
  if (!result.rows[0]) {
    await pool.query("DELETE FROM auth_sessions WHERE token = $1 OR expires_at <= now()", [token]);
    return null;
  }
  return toActor(result.rows[0]);
}

async function findUserByEmail(email) {
  if (useMemoryAuth) return memoryAuth.usersByEmail.get(email) ?? null;
  const result = await pool.query("SELECT * FROM auth_users WHERE email = $1 LIMIT 1", [email]);
  return result.rows[0] ?? null;
}

async function createSession(user) {
  const token = crypto.randomBytes(48).toString("base64url");
  const actor = toActor(user);
  if (useMemoryAuth) {
    memoryAuth.sessions.set(token, {
      expires_at: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
      token,
      user_id: user.id,
      user_snapshot: actor,
    });
    return { actor, token };
  }
  await pool.query(
    `
      INSERT INTO auth_sessions (token, user_id, expires_at, user_snapshot)
      VALUES ($1, $2, now() + ($3 || ' seconds')::interval, $4::jsonb)
    `,
    [token, user.id, SESSION_TTL_SECONDS, JSON.stringify(actor)],
  );
  return { actor, token };
}

function toActor(user) {
  return {
    email: user.email,
    groups: Array.isArray(user.groups) ? user.groups : [],
    id: user.id,
    name: user.display_name,
    role: user.role,
    title: user.title || "",
  };
}

function toCurrentUser(actor) {
  const groups = (Array.isArray(actor.groups) ? actor.groups : []).map((group) => ({
    description: `${group} group`,
    id: group,
    memberCount: 1,
    name: titleCase(group),
  }));
  const role = actor.role || "viewer";
  return {
    displayName: actor.name,
    email: actor.email,
    groups,
    id: actor.id,
    permissionsSummary: role === "admin"
      ? { canDelete: 10, canManage: 10, canQuery: 10, canRun: 10, canShare: 10, canView: 10 }
      : { canDelete: 0, canManage: 0, canQuery: 10, canRun: 10, canShare: 0, canView: 10 },
    profile: {
      avatarInitials: initials(actor.name),
      displayName: actor.name,
      email: actor.email,
      role,
      title: actor.title || (role === "admin" ? "Platform Admin" : "Data Viewer"),
    },
    role,
  };
}

function seedMemoryDemoUsers() {
  for (const user of DEMO_USERS) {
    const email = normalizeEmail(user.email);
    if (memoryAuth.usersByEmail.has(email)) continue;
    const salt = crypto.randomBytes(16).toString("hex");
    writeMemoryUser({
      display_name: user.displayName,
      email,
      groups: user.groups,
      id: user.id,
      password_hash: hashPassword(user.password, salt),
      password_salt: salt,
      role: user.role,
      status: "active",
      title: user.title,
    });
  }
}

function writeMemoryUser(user) {
  memoryAuth.usersByEmail.set(user.email, user);
  memoryAuth.usersById.set(user.id, user);
}

function setSessionCookie(response, token) {
  response.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`);
}

function clearSessionCookie(response) {
  response.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

function sessionTokenFromRequest(request) {
  const cookies = parseCookies(request.headers.cookie || "");
  return cookies[SESSION_COOKIE_NAME] || "";
}

function parseCookies(cookieHeader) {
  return cookieHeader.split(";").reduce((cookies, part) => {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (!rawKey) return cookies;
    cookies[rawKey] = decodeURIComponent(rawValue.join("=") || "");
    return cookies;
  }, {});
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 120_000, 32, "sha256").toString("hex");
}

function verifyPassword(password, salt, expectedHash) {
  return crypto.timingSafeEqual(Buffer.from(hashPassword(password, salt), "hex"), Buffer.from(expectedHash, "hex"));
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function requiredString(value, message) {
  if (typeof value !== "string" || !value.trim()) throw apiError("VALIDATION_ERROR", message, 400);
  return value;
}

function uniqueUserId(displayName) {
  const base = displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "user";
  return `${base}-${crypto.randomBytes(4).toString("hex")}`;
}

function initials(displayName) {
  const letters = String(displayName || "")
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return letters || "AU";
}

function titleCase(value) {
  return String(value || "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() || ""}${part.slice(1)}`)
    .join(" ");
}

function apiError(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}
