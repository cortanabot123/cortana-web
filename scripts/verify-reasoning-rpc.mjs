/**
 * Live smoke for the reasoning picker RPC surface, against the running Cortana + Hermes gateway.
 * Read-only for the global config: it only writes a SESSION-scoped level, then reads it back and
 * restores the original. Prints statuses only — never the credentials.
 *
 *   set -a; . /opt/data/.env; set +a; node scripts/verify-reasoning-rpc.mjs
 */
const base = process.env.CORTANA_BASE_URL || "http://127.0.0.1:3000";
const username = process.env.CORTANA_ACCESS_USERNAME;
const password = process.env.CORTANA_ACCESS_PASSWORD;

const { WebSocket } = await import("ws");

if (!username || !password) {
  console.error("missing CORTANA_ACCESS_USERNAME/PASSWORD");
  process.exit(2);
}

const auth = () => `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

const status = await fetch(`${base}/api/gateway/status`, { headers: { authorization: auth() } });
console.log("gateway/status", status.status, JSON.stringify(await status.json()));

const socket = new WebSocket(`${base.replace(/^http/, "ws")}/api/gateway`, {
  headers: { authorization: auth(), origin: base },
});

const pending = new Map();
let nextId = 0;
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 20000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });

socket.on("message", (raw) => {
  const frame = JSON.parse(typeof raw === "string" ? raw : raw.toString());
  if (frame.method === "event" && frame.params?.type === "gateway.ready") {
    console.log("handshake", "gateway.ready received");
    void run();
    return;
  }
  if (frame.id === undefined) return;
  const state = pending.get(frame.id);
  if (!state) return;
  pending.delete(frame.id);
  clearTimeout(state.timer);
  if (frame.error) state.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
  else state.resolve(frame.result);
});

socket.on("error", (error) => {
  console.error("socket error", error?.message ?? error);
  process.exit(1);
});

async function run() {
  let code = 0;
  try {
    await call("client.capabilities", { server_requests: true });

    const created = await call("session.create");
    const sessionId = created.session_id;
    console.log("session.create", sessionId ? "ok" : "FAILED");

    // 1. Effective level as the picker loads it.
    const before = await call("config.get", { key: "reasoning", session_id: sessionId });
    console.log("config.get reasoning", JSON.stringify(before));

    // 2. Session-scoped write (must NOT touch config.yaml).
    const set = await call("config.set", { key: "reasoning", value: "high", scope: "session", session_id: sessionId });
    console.log("config.set session high", JSON.stringify(set));

    // 3. Read back through the same session: the picker must reflect the new level.
    const after = await call("config.get", { key: "reasoning", session_id: sessionId });
    console.log("config.get after", JSON.stringify(after));
    if (String(after.value).toLowerCase() !== "high") {
      console.error(`FAILED: expected high, got ${JSON.stringify(after.value)}`);
      code = 1;
    }

    // 4. Restore the original session level so the smoke is idempotent.
    const original = String(before.value || "none");
    await call("config.set", { key: "reasoning", value: original, scope: "session", session_id: sessionId });
    const restored = await call("config.get", { key: "reasoning", session_id: sessionId });
    console.log("restored session level", JSON.stringify(restored));
  } catch (error) {
    console.error("FAILED:", error.message);
    code = 1;
  } finally {
    socket.close();
    process.exit(code);
  }
}
