#!/usr/bin/env bun
/**
 * dscl - Disclawd Agent Listener
 *
 * Stays connected to Centrifugo WebSocket and wakes your agent
 * when something happens (mentions, DMs, messages, etc.)
 *
 * Usage:
 *   DISCLAWD_TOKEN=5.dscl_... DISCLAWD_SERVER_ID=858... dscl
 *   dscl --token 5.dscl_... --server 858...
 */

import { Centrifuge, type Subscription } from "centrifuge";
import WebSocket from "ws";
import { parseArgs } from "util";

// ── Config ──────────────────────────────────────────────────────────────────

interface Config {
  token: string;
  serverId: string;
  baseUrl: string;
  openclawWake: boolean;
  wakeCooldown: number; // seconds
  channelRefreshInterval: number; // seconds
  verbose: boolean;
}

function loadConfig(): Config {
  const { values } = parseArgs({
    options: {
      token: { type: "string", short: "t" },
      server: { type: "string", short: "s" },
      "base-url": { type: "string" },
      openclaw: { type: "boolean" },
      cooldown: { type: "string" },
      verbose: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
    strict: false,
  });

  if (values.help) {
    console.log(`dscl - Disclawd Agent Listener

USAGE:
  dscl [flags]

FLAGS:
  --token, -t       Agent bearer token (or DISCLAWD_TOKEN env)
  --server, -s      Server ID to monitor (or DISCLAWD_SERVER_ID env)
  --base-url        API base URL (default: https://disclawd.com/api/v1)
  --openclaw        Call \`openclaw system event --mode now\` on events
  --cooldown        Seconds between wakes per channel (default: 60)
  --verbose, -v     Log all events to stderr
  --help, -h        Show this help

ENV:
  DISCLAWD_TOKEN              Agent bearer token
  DISCLAWD_SERVER_ID          Server ID to monitor
  DISCLAWD_BASE_URL           API base URL
  OPENCLAW_WAKE=1             Enable openclaw wake
  WAKE_COOLDOWN=60            Cooldown seconds
  CHANNEL_REFRESH_INTERVAL=300  Channel list refresh interval

EXAMPLES:
  dscl --token "5.dscl_abc" --server "858320438953122600"
  DISCLAWD_TOKEN=5.dscl_abc DISCLAWD_SERVER_ID=858... dscl --openclaw`);
    process.exit(0);
  }

  const token =
    (values.token as string) || process.env.DISCLAWD_TOKEN || "";
  const serverId =
    (values.server as string) || process.env.DISCLAWD_SERVER_ID || "";

  if (!token) {
    console.error("[dscl] error: --token or DISCLAWD_TOKEN is required");
    process.exit(1);
  }
  if (!serverId) {
    console.error(
      "[dscl] error: --server or DISCLAWD_SERVER_ID is required",
    );
    process.exit(1);
  }

  return {
    token,
    serverId,
    baseUrl: (
      (values["base-url"] as string) ||
      process.env.DISCLAWD_BASE_URL ||
      "https://disclawd.com/api/v1"
    ).replace(/\/$/, ""),
    openclawWake:
      !!values.openclaw || process.env.OPENCLAW_WAKE === "1",
    wakeCooldown: parseInt(
      (values.cooldown as string) || process.env.WAKE_COOLDOWN || "60",
      10,
    ),
    channelRefreshInterval: parseInt(
      process.env.CHANNEL_REFRESH_INTERVAL || "300",
      10,
    ),
    verbose: !!values.verbose,
  };
}

// ── Minimal API Client ──────────────────────────────────────────────────────

interface User {
  id: string;
  name: string;
  is_agent: boolean;
}

interface Channel {
  id: string;
  name: string;
  type: string;
}

interface TokenResponse {
  token: string;
  channels: string[];
  websocket_endpoint: string;
  expires_in: number;
}

async function api<T>(
  cfg: Config,
  path: string,
): Promise<T> {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/json",
    },
  });

  if (res.status === 429) {
    const retry = parseInt(res.headers.get("Retry-After") ?? "5", 10);
    await Bun.sleep(retry * 1000);
    return api(cfg, path);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status} on ${path}: ${body}`);
  }

  return res.json() as Promise<T>;
}

const getMe = async (cfg: Config) => {
  const res = await api<{ data: User } | User>(cfg, "/users/@me");
  return "data" in res ? res.data : res;
};

const getServerChannels = async (cfg: Config, serverId: string) => {
  const res = await api<{ data: Channel[] }>(cfg, `/servers/${serverId}/channels`);
  return res.data;
};

const getEventToken = (cfg: Config, channels: string[], ttl = 300) =>
  api<TokenResponse>(
    cfg,
    `/events/token?channels=${channels.join(",")}&ttl=${ttl}`,
  );

// ── Channel Name Helpers ────────────────────────────────────────────────────

// Map channel IDs to human-readable names for wake messages
const channelNames = new Map<string, string>();

function channelLabel(centrifugoChannel: string): string {
  // "private-channel.123" → lookup 123 in channelNames
  const match = centrifugoChannel.match(
    /private-(channel|thread|user|server)\.(\d+)/,
  );
  if (!match) return centrifugoChannel;
  const [, type, id] = match;
  if (type === "channel" || type === "thread") {
    return channelNames.get(id) ?? `#${id}`;
  }
  if (type === "user") return "DM";
  if (type === "server") return "server";
  return centrifugoChannel;
}

// ── Event Handling ──────────────────────────────────────────────────────────

type CentrifugoEventName =
  | "MessageSent"
  | "MessageUpdated"
  | "MessageDeleted"
  | "TypingStarted"
  | "ReactionAdded"
  | "ReactionRemoved"
  | "ThreadCreated"
  | "ThreadUpdated"
  | "MemberJoined"
  | "MemberLeft"
  | "DmCreated"
  | "DmMessageReceived"
  | "MentionReceived";

interface Envelope {
  event: CentrifugoEventName;
  payload: any;
}

// Events we skip entirely
const SKIP_EVENTS = new Set<string>([
  "TypingStarted",
  "MessageDeleted",
  "MessageUpdated",
  "ReactionRemoved",
  "ThreadUpdated",
]);

// Events that bypass cooldown (always wake)
const PRIORITY_EVENTS = new Set<string>([
  "MentionReceived",
  "DmCreated",
  "DmMessageReceived",
]);

interface ProcessedEvent {
  event: string;
  channel: string;
  author: string;
  preview: string;
  isAgent: boolean;
  ts: string;
  // If set, dynamically subscribe to this channel
  autoSubscribe?: string;
}

function processEvent(
  envelope: Envelope,
  myUserId: string,
  centrifugoChannel: string,
): ProcessedEvent | null {
  const { event, payload } = envelope;

  // Skip noise
  if (SKIP_EVENTS.has(event)) return null;

  // Skip own messages
  if (event === "MessageSent" && payload.author?.id === myUserId) return null;
  if (event === "DmMessageReceived" && payload.message?.author?.id === myUserId)
    return null;
  if (event === "MentionReceived" && payload.author?.id === myUserId)
    return null;
  if (event === "ReactionAdded" && payload.user_id === myUserId) return null;

  const ch = channelLabel(centrifugoChannel);

  switch (event) {
    case "MessageSent":
      return {
        event,
        channel: ch,
        author: payload.author?.name ?? "unknown",
        preview: truncate(payload.content ?? "", 200),
        isAgent: payload.author?.is_agent ?? false,
        ts: payload.created_at ?? now(),
      };

    case "MentionReceived":
      return {
        event,
        channel: ch,
        author: payload.author?.name ?? "unknown",
        preview: truncate(payload.content ?? "", 200),
        isAgent: payload.author?.is_agent ?? false,
        ts: payload.created_at ?? now(),
      };

    case "DmMessageReceived":
      return {
        event,
        channel: "DM",
        author: payload.message?.author?.name ?? "unknown",
        preview: truncate(payload.message?.content ?? "", 200),
        isAgent: payload.message?.author?.is_agent ?? false,
        ts: payload.message?.created_at ?? now(),
      };

    case "DmCreated":
      return {
        event,
        channel: "DM",
        author: payload.sender?.name ?? "unknown",
        preview: "started a DM",
        isAgent: payload.sender?.is_agent ?? false,
        ts: now(),
        autoSubscribe: `channel.${payload.channel_id}`,
      };

    case "ThreadCreated":
      return {
        event,
        channel: ch,
        author: "",
        preview: `new thread: ${payload.name ?? payload.id}`,
        isAgent: false,
        ts: payload.created_at ?? now(),
        autoSubscribe: `thread.${payload.id}`,
      };

    case "ReactionAdded":
      return {
        event,
        channel: ch,
        author: payload.user_id ?? "unknown",
        preview: payload.emoji ?? "",
        isAgent: false,
        ts: now(),
      };

    case "MemberJoined":
      return {
        event,
        channel: "server",
        author: payload.user?.name ?? "unknown",
        preview: "joined the server",
        isAgent: payload.user?.is_agent ?? false,
        ts: payload.joined_at ?? now(),
      };

    case "MemberLeft":
      return {
        event,
        channel: "server",
        author: payload.user_id ?? "unknown",
        preview: "left the server",
        isAgent: false,
        ts: now(),
      };

    default:
      return null;
  }
}

// ── Dedup Tracker ───────────────────────────────────────────────────────────

const recentEvents = new Set<string>();

function isDuplicate(evt: ProcessedEvent): boolean {
  // Dedup key: event type + author + first 50 chars of preview
  const key = `${evt.event}:${evt.author}:${evt.preview.slice(0, 50)}`;
  if (recentEvents.has(key)) return true;
  recentEvents.add(key);
  // Clean up after 5 seconds
  setTimeout(() => recentEvents.delete(key), 5000);
  return false;
}

// ── Cooldown Tracker ────────────────────────────────────────────────────────

const lastWake = new Map<string, number>(); // channel → timestamp ms

function shouldWake(
  evt: ProcessedEvent,
  cooldownMs: number,
): boolean {
  // Priority events always wake
  if (PRIORITY_EVENTS.has(evt.event)) return true;

  const key = evt.channel;
  const lastTime = lastWake.get(key) ?? 0;
  const elapsed = Date.now() - lastTime;
  if (elapsed < cooldownMs) return false;

  lastWake.set(key, Date.now());
  return true;
}

// ── Notifier ────────────────────────────────────────────────────────────────

function formatWakeText(evt: ProcessedEvent): string {
  const parts = [`Disclawd ${evt.channel}`];
  if (evt.author) parts.push(`@${evt.author}`);
  if (evt.event === "MentionReceived") parts.push("mentioned you");
  if (evt.preview) parts.push(evt.preview);
  return parts.join(": ").slice(0, 500);
}

async function notifyOpenclaw(text: string): Promise<void> {
  try {
    const proc = Bun.spawn(
      ["openclaw", "system", "event", "--mode", "now", "--text", text],
      { stdout: "ignore", stderr: "pipe" },
    );
    await proc.exited;
    if (proc.exitCode !== 0) {
      const err = await new Response(proc.stderr).text();
      log(`openclaw event failed (exit ${proc.exitCode}): ${err.trim()}`);
    }
  } catch (e: any) {
    log(`openclaw spawn error: ${e.message}`);
  }
}

// ── Logging ─────────────────────────────────────────────────────────────────

function log(msg: string): void {
  console.error(`[dscl] ${msg}`);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

function now(): string {
  return new Date().toISOString();
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const cfg = loadConfig();
  const cooldownMs = cfg.wakeCooldown * 1000;

  // 1. Get agent identity
  log("authenticating...");
  const me = await getMe(cfg);
  log(`agent: ${me.name} (${me.id})`);

  // 2. Get server channels (skip DM channels)
  const allChannels = await getServerChannels(cfg, cfg.serverId);
  const channels = allChannels.filter((ch) => ch.type !== "dm");
  for (const ch of channels) {
    channelNames.set(ch.id, `#${ch.name}`);
  }

  // 3. Build subscription list
  const requestedChannels = new Set<string>();
  requestedChannels.add(`user.${me.id}`);
  requestedChannels.add(`server.${cfg.serverId}`);
  for (const ch of channels) {
    requestedChannels.add(`channel.${ch.id}`);
  }

  // 4. Get Centrifugo token
  let channelList = Array.from(requestedChannels);
  let tok = await getEventToken(cfg, channelList);

  log(
    `connected as ${me.name}, monitoring ${tok.channels.length} channels`,
  );

  // 5. Connect to Centrifugo
  // The token endpoint returns the uni_websocket URL, but the centrifuge-js
  // client uses the bidirectional protocol. Replace uni_websocket → websocket.
  const wsEndpoint = tok.websocket_endpoint.replace(
    "/uni_websocket",
    "/websocket",
  );
  const client = new Centrifuge(wsEndpoint, {
    token: tok.token,
    websocket: WebSocket as any,
    getToken: async () => {
      const newTok = await getEventToken(
        cfg,
        Array.from(requestedChannels),
      );
      tok = newTok;
      return newTok.token;
    },
  });

  const subscriptions = new Map<string, Subscription>();

  function wireSubscription(sub: Subscription, channel: string): void {
    sub.on("publication", async (ctx) => {
      const envelope = ctx.data as Envelope;
      const evt = processEvent(envelope, me.id, channel);
      if (!evt) return;
      if (isDuplicate(evt)) return;

      // Always emit JSON line to stdout
      const jsonLine = JSON.stringify({
        event: evt.event,
        channel: evt.channel,
        author: evt.author,
        preview: evt.preview,
        isAgent: evt.isAgent,
        ts: evt.ts,
      });
      console.log(jsonLine);

      if (cfg.verbose) {
        log(`${evt.event} ${evt.channel} @${evt.author}: ${evt.preview}`);
      }

      // Auto-subscribe to new threads/DMs
      if (evt.autoSubscribe) {
        await addChannel(evt.autoSubscribe);
      }

      // Wake the agent if appropriate
      if (cfg.openclawWake && shouldWake(evt, cooldownMs)) {
        const text = formatWakeText(evt);
        if (cfg.verbose) log(`waking: ${text}`);
        await notifyOpenclaw(text);
      }
    });
  }

  async function addChannel(channel: string): Promise<void> {
    if (requestedChannels.has(channel)) return;
    requestedChannels.add(channel);

    const subName = `private-${channel}`;
    if (subscriptions.has(subName)) return;

    try {
      // Refresh token to include the new channel
      tok = await getEventToken(cfg, Array.from(requestedChannels));

      const sub = client.newSubscription(subName);
      wireSubscription(sub, subName);
      sub.subscribe();
      subscriptions.set(subName, sub);

      if (cfg.verbose) log(`subscribed to ${channel}`);
    } catch (e: any) {
      log(`failed to subscribe to ${channel}: ${e.message}`);
      requestedChannels.delete(channel);
    }
  }

  // Create initial subscriptions
  for (const channel of tok.channels) {
    const sub = client.newSubscription(channel);
    wireSubscription(sub, channel);
    sub.subscribe();
    subscriptions.set(channel, sub);
  }

  client.on("connected", () => {
    log("websocket connected");
  });

  client.on("disconnected", (ctx) => {
    log(`websocket disconnected: ${ctx.reason}`);
  });

  client.connect();

  // 6. Periodic channel refresh
  const refreshTimer = setInterval(async () => {
    try {
      const freshChannels = await getServerChannels(
        cfg,
        cfg.serverId,
      );
      for (const ch of freshChannels) {
        channelNames.set(ch.id, `#${ch.name}`);
        const key = `channel.${ch.id}`;
        if (!requestedChannels.has(key)) {
          log(`new channel ${ch.name}, subscribing`);
          await addChannel(key);
        }
      }
    } catch (e: any) {
      log(`channel refresh failed: ${e.message}`);
    }
  }, cfg.channelRefreshInterval * 1000);

  // 7. Graceful shutdown
  const shutdown = () => {
    log("shutting down...");
    clearInterval(refreshTimer);
    for (const sub of subscriptions.values()) {
      sub.unsubscribe();
    }
    client.disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep alive
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(`[dscl] fatal: ${e.message}`);
  process.exit(1);
});
