(function () {
  "use strict";

  function createReplyContext({ metro, log, notify }) {
    const toast = typeof notify === "function" ? notify : function () {};
    const MessageStore =
      metro.findByProps("getMessage", "getMessages") ||
      (metro.findByStoreName ? metro.findByStoreName("MessageStore") : null) ||
      null;
    const UserStore =
      (metro.findByStoreName ? metro.findByStoreName("UserStore") : null) ||
      metro.findByProps("getCurrentUser") ||
      null;

    const ChannelStore =
      (metro.findByStoreName ? metro.findByStoreName("ChannelStore") : null) ||
      metro.findByProps("getChannel", "getDMFromUserId") ||
      null;
    const GuildMemberStore =
      (metro.findByStoreName ? metro.findByStoreName("GuildMemberStore") : null) ||
      metro.findByProps("getMember", "getNick") ||
      null;

    const pendingByChannel = new Map();
    let PendingReplyStore = null;
    let fluxUnsub = null;
    let fluxRef = null;

    function rememberPending(channelId, message) {
      if (!channelId || !message) return;
      pendingByChannel.set(String(channelId), { message, at: Date.now() });
    }

    function forgetPending(channelId) {
      if (channelId) pendingByChannel.delete(String(channelId));
    }

    function cachedPending(channelId) {
      if (!channelId) return null;
      const hit = pendingByChannel.get(String(channelId));
      if (!hit) return null;
      if (Date.now() - hit.at > 10 * 60 * 1000) {
        pendingByChannel.delete(String(channelId));
        return null;
      }
      return hit.message;
    }

    function onFluxAction(action) {
      if (!action || typeof action !== "object") return;
      const type = action.type;
      if (type !== "CREATE_PENDING_REPLY" && type !== "SET_PENDING_REPLY" &&
          type !== "DELETE_PENDING_REPLY" && type !== "CLEAR_PENDING_REPLY") return;
      const channelId = action.channelId || action.channel_id || (action.channel && action.channel.id);
      if (type === "DELETE_PENDING_REPLY" || type === "CLEAR_PENDING_REPLY") {
        return;
      }
      const message = action.message || action.referencedMessage || action.referenced_message;
      if (message && !message.id && (action.messageId || action.message_id)) {
        message.id = action.messageId || action.message_id;
      }
      rememberPending(channelId, message);
      if (message) log("cached swipe reply", channelId, message.id, textOfMessage(message).slice(0, 80));
    }

    function start() {
      if (fluxUnsub) return;
      const Flux =
        metro.findByProps("subscribe", "dispatch") ||
        metro.findByProps("_dispatch", "subscribe") ||
        null;
      if (!Flux || typeof Flux.subscribe !== "function") {
        log("FluxDispatcher not found; swipe reply cache disabled");
        return;
      }
      fluxRef = Flux;
      try {
        Flux.subscribe("CREATE_PENDING_REPLY", onFluxAction);
        Flux.subscribe("SET_PENDING_REPLY", onFluxAction);
        fluxUnsub = function () {
          try { Flux.unsubscribe("CREATE_PENDING_REPLY", onFluxAction); } catch (e) {}
          try { Flux.unsubscribe("SET_PENDING_REPLY", onFluxAction); } catch (e) {}
        };
      } catch (e) {
        try {
          Flux.subscribe(onFluxAction);
          fluxUnsub = function () { try { Flux.unsubscribe(onFluxAction); } catch (e2) {} };
        } catch (e2) {
          log("could not subscribe to pending reply", e2 && e2.message);
        }
      }
    }

    function stop() {
      if (fluxUnsub) {
        try { fluxUnsub(); } catch (e) {}
        fluxUnsub = null;
      }
    }

    function clipReply(content) {
      const text = typeof content === "string" ? content.trim() : "";
      if (!text) return "";
      return text.length > 900 ? text.slice(0, 900) + "…" : text;
    }

    function pushPart(parts, value) {
      const text = typeof value === "string" ? value.trim() : "";
      if (text) parts.push(text);
    }

    function embedText(embed, parts) {
      if (!embed || typeof embed !== "object") return;
      pushPart(parts, embed.title || embed.rawTitle);
      pushPart(parts, embed.description || embed.rawDescription);
      const author = embed.author;
      if (author) pushPart(parts, typeof author === "string" ? author : author.name);
      const fields = Array.isArray(embed.fields) ? embed.fields : [];
      for (let i = 0; i < fields.length && i < 12; i++) {
        const field = fields[i];
        if (!field) continue;
        const name = String(field.name || field.rawName || "").trim();
        const value = String(field.value || field.rawValue || "").trim();
        if (name && value) parts.push(name + ": " + value);
        else pushPart(parts, name || value);
      }
      const footer = embed.footer;
      if (footer) pushPart(parts, typeof footer === "string" ? footer : footer.text);
    }

    function componentLabels(components, parts, depth) {
      if (!Array.isArray(components) || depth > 3) return;
      for (let i = 0; i < components.length && i < 16; i++) {
        const c = components[i];
        if (!c || typeof c !== "object") continue;
        pushPart(parts, c.label || c.placeholder);
        if (Array.isArray(c.components)) componentLabels(c.components, parts, depth + 1);
        if (Array.isArray(c.options)) {
          for (let j = 0; j < c.options.length && j < 8; j++) {
            pushPart(parts, c.options[j] && c.options[j].label);
          }
        }
      }
    }

    function snapshotMessages(msg) {
      const snaps = msg && (msg.messageSnapshots || msg.message_snapshots || msg.snapshots);
      if (!Array.isArray(snaps)) return [];
      const out = [];
      for (let i = 0; i < snaps.length && i < 3; i++) {
        const snap = snaps[i];
        if (snap && typeof snap === "object") out.push(snap.message || snap);
      }
      return out;
    }

    function isForwardedMessage(msg) {
      if (!msg || typeof msg !== "object") return false;
      if (msg.messageSnapshots || msg.message_snapshots) return true;
      const ref = msg.messageReference || msg.message_reference;
      return !!(ref && (ref.type === 1 || ref.type === "FORWARD"));
    }

    function isBotMessage(msg) {
      if (!msg || typeof msg !== "object") return false;
      const author = msg.author || msg.user || {};
      return !!(author.bot || author.isBot || msg.bot || msg.webhookId || msg.webhook_id);
    }

    function textOfMessage(msg, depth) {
      if (!msg || typeof msg !== "object") return "";
      const level = depth || 0;
      if (level > 2) return "";
      const parts = [];
      const content = typeof msg.content === "string" ? msg.content : typeof msg.text === "string" ? msg.text : "";
      pushPart(parts, content);
      const embeds = Array.isArray(msg.embeds) ? msg.embeds : msg.embed ? [msg.embed] : [];
      for (let i = 0; i < embeds.length && i < 3; i++) embedText(embeds[i], parts);
      componentLabels(msg.components, parts, 0);
      const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
      if (attachments.length) {
        const names = [];
        for (let i = 0; i < attachments.length && i < 4; i++) {
          const name = attachments[i] && (attachments[i].filename || attachments[i].name);
          if (name) names.push(name);
        }
        if (names.length) parts.push("attachments: " + names.join(", "));
      }
      const snaps = snapshotMessages(msg);
      for (let i = 0; i < snaps.length; i++) {
        const inner = textOfMessage(snaps[i], level + 1);
        if (inner) parts.push("forwarded: " + inner);
      }
      return clipReply(parts.join(" | "));
    }

    function identityOf(user) {
      if (!user || typeof user !== "object") return { id: "", username: "", globalName: "" };
      const id = user.id || user.userId || user.user_id || "";
      const username = user.username || user.tag || "";
      const globalName = user.globalName || user.global_name || user.displayName || "";
      return {
        id: id ? String(id) : "",
        username: username ? String(username) : "",
        globalName: globalName ? String(globalName) : "",
      };
    }

    function authorOf(msg) {
      if (!msg || typeof msg !== "object") return { id: "", username: "", globalName: "" };
      const who = identityOf(msg.author || msg.user || msg.member || msg);
      if (!who.id) who.id = String(msg.authorId || msg.author_id || msg.userId || msg.user_id || "");
      return who;
    }

    function getSelfIdentity() {
      try {
        const user = UserStore && typeof UserStore.getCurrentUser === "function"
          ? UserStore.getCurrentUser()
          : null;
        return identityOf(user);
      } catch (e) {
        return { id: "", username: "", globalName: "" };
      }
    }

    function looksLikeMessage(v) {
      if (!v || typeof v !== "object" || Array.isArray(v)) return false;
      if (typeof v.content === "string") return true;
      if (v.embeds || v.embed || v.messageSnapshots || v.message_snapshots) return true;
      const author = v.author || v.user;
      if (author && (author.id || author.username || author.bot)) return true;
      if (v.id && (v.channel_id || v.channelId || v.timestamp || v.components || v.message_id)) return true;
      return false;
    }

    function findReplyRef(args) {
      for (const a of args || []) {
        if (!a || typeof a !== "object") continue;
        const ref = a.messageReference || (a.message && a.message.messageReference);
        if (ref && typeof ref === "object") return ref;
      }
      return null;
    }

    function messageFromStore(channelId, ref) {
      try {
        const messageId = ref && (ref.message_id || ref.messageId);
        if (!messageId || !MessageStore || typeof MessageStore.getMessage !== "function") return null;
        return MessageStore.getMessage(channelId, messageId) || null;
      } catch (e) {
        return null;
      }
    }

    function extractReplyMessage(args) {
      const seen = new Set();
      function walk(v, depth) {
        try {
          if (!v || typeof v !== "object" || depth > 5 || seen.has(v)) return null;
          seen.add(v);
          const direct = [
            v.referencedMessage,
            v.referenced_message,
            v.replyingTo,
            v.replyTo,
            v.messageReply,
          ];
          if (v.message && typeof v.message === "object") {
            direct.push(v.message.referencedMessage, v.message.referenced_message);
          }
          const snaps = snapshotMessages(v);
          for (let i = 0; i < snaps.length; i++) direct.push(snaps[i]);
          for (let i = 0; i < direct.length; i++) {
            if (looksLikeMessage(direct[i])) return direct[i];
          }
          const keys = Object.keys(v).slice(0, 40);
          for (let i = 0; i < keys.length; i++) {
            const child = v[keys[i]];
            if (child && typeof child === "object") {
              const hit = walk(child, depth + 1);
              if (hit) return hit;
            }
          }
        } catch (e) {}
        return null;
      }
      try {
        for (const a of args || []) {
          const hit = walk(a, 0);
          if (hit) return hit;
        }
      } catch (e) {
        log("Gagal mengekstrak pesan reply:", e);
      }
      return null;
    }

    function getPendingReplyMessage(channelId) {
      try {
        if (!PendingReplyStore) {
          PendingReplyStore =
            (metro.findByStoreName && (
              metro.findByStoreName("PendingReplyStore") ||
              metro.findByStoreName("ReplyStore") ||
              metro.findByStoreName("MessageReplyStore")
            )) ||
            metro.findByProps("getPendingReply") ||
            metro.findByProps("createPendingReply", "deletePendingReply") ||
            null;
        }
        if (!PendingReplyStore) return null;
        let reply = null;
        if (typeof PendingReplyStore.getPendingReply === "function") {
          reply = PendingReplyStore.getPendingReply(channelId);
        } else if (typeof PendingReplyStore.getPendingReplies === "function") {
          const all = PendingReplyStore.getPendingReplies();
          reply = all && (all[channelId] || all.get && all.get(channelId));
        }
        if (!reply) return null;
        return reply.message || reply.referencedMessage || reply.referenced_message || reply;
      } catch (e) {
        return null;
      }
    }

    // 🌸 Snowflake anchor: the replied-to message's ID pins a slice of the channel history,
    // so the AI sees the exact conversation around what is being replied to.
    const DISCORD_EPOCH = 1420070400000;
    const WINDOW_BEFORE = 4; // messages before the anchor
    const WINDOW_AFTER = 6;  // messages after the anchor
    const WINDOW_LINE_MAX = 200;

    function snowflakeToMs(id) {
      const n = Number(String(id || ""));
      if (!Number.isFinite(n) || n <= 0) return null;
      return Math.floor(n / 4194304) + DISCORD_EPOCH;
    }

    // Snowflakes compared as strings (same length -> lexicographic) to avoid precision loss.
    function compareSnowflake(a, b) {
      const x = String(a || ""), y = String(b || "");
      if (x.length !== y.length) return x.length - y.length;
      return x < y ? -1 : x > y ? 1 : 0;
    }

    function getChannelMessages(channelId) {
      try {
        if (!channelId || !MessageStore || typeof MessageStore.getMessages !== "function") return [];
        const col = MessageStore.getMessages(channelId);
        if (!col) return [];
        let arr = null;
        if (typeof col.toArray === "function") arr = col.toArray();
        else if (Array.isArray(col._array)) arr = col._array;
        else if (Array.isArray(col)) arr = col;
        if (!Array.isArray(arr)) return [];
        return arr.filter((m) => m && m.id).sort((a, b) => compareSnowflake(a.id, b.id));
      } catch (e) {
        return [];
      }
    }

    function sliceAnchorWindow(channelId, anchorId) {
      if (!channelId || !anchorId) return null;
      const all = getChannelMessages(channelId);
      const idx = all.findIndex((m) => String(m.id) === String(anchorId));
      if (idx === -1) return null;
      const start = Math.max(0, idx - WINDOW_BEFORE);
      const end = Math.min(all.length, idx + 1 + WINDOW_AFTER);
      return { items: all.slice(start, end), anchorId: String(anchorId), hiddenBefore: start, hiddenAfter: all.length - end };
    }

    function windowLines(win) {
      if (!win || !win.items.length) return [];
      const selfId = getSelfIdentity().id;
      const out = [];
      if (win.hiddenBefore > 0) out.push("... (" + win.hiddenBefore + " earlier messages not shown)");
      for (let i = 0; i < win.items.length; i++) {
        const m = win.items[i];
        const isAnchor = String(m.id) === win.anchorId;
        const text = textOfMessage(m).replace(/\s+/g, " ").trim().slice(0, WINDOW_LINE_MAX);
        if (!text && !isAnchor) continue;
        const who = authorOf(m);
        const name = who.globalName || who.username || who.id || "unknown";
        const ms = snowflakeToMs(m.id);
        const when = ms ? new Date(ms).toISOString().slice(11, 16) + "Z" : "";
        const flags = [];
        if (isAnchor) flags.push(">>> REPLY TARGET");
        if (selfId && who.id === selfId) flags.push("speaker");
        if (isBotMessage(m)) flags.push("bot");
        out.push("- " + (flags.length ? "[" + flags.join(", ") + "] " : "") + (when ? when + " " : "") + name + ": " + (text || "(no text)"));
      }
      if (win.hiddenAfter > 0) out.push("... (" + win.hiddenAfter + " newer messages not shown)");
      return out;
    }

    // Last N messages from one user, parsed into datetime / snowflake / username / nickname / server name.
    const HISTORY_COUNT = 10;

    function guildIdOf(channelId, msg) {
      try {
        const ch = ChannelStore && typeof ChannelStore.getChannel === "function" ? ChannelStore.getChannel(channelId) : null;
        const gid = (ch && (ch.guild_id || ch.guildId)) || (msg && (msg.guild_id || msg.guildId)) || "";
        return gid ? String(gid) : "";
      } catch (e) {
        return "";
      }
    }

    // Per-server nickname, empty string when the user has none (or in DMs).
    function serverNickOf(guildId, userId, msg) {
      try {
        const direct = msg && (msg.nick || (msg.member && msg.member.nick));
        if (typeof direct === "string" && direct.trim()) return direct.trim();
        if (!guildId || !userId || !GuildMemberStore) return "";
        if (typeof GuildMemberStore.getNick === "function") {
          const n = GuildMemberStore.getNick(guildId, userId);
          if (typeof n === "string" && n.trim()) return n.trim();
        }
        if (typeof GuildMemberStore.getMember === "function") {
          const m = GuildMemberStore.getMember(guildId, userId);
          if (m && typeof m.nick === "string" && m.nick.trim()) return m.nick.trim();
        }
      } catch (e) {}
      return "";
    }

    function formatStamp(id) {
      const ms = snowflakeToMs(id);
      return ms ? new Date(ms).toISOString().slice(0, 19).replace("T", " ") + "Z" : "";
    }

    function userHistoryLines(channelId, userId) {
      if (!channelId || !userId) return [];
      const guildId = guildIdOf(channelId, null);
      const mine = getChannelMessages(channelId)
        .filter((m) => authorOf(m).id === String(userId) && textOfMessage(m))
        .slice(-HISTORY_COUNT);
      return mine.map((m) => {
        const who = authorOf(m);
        const row = { datetime: formatStamp(m.id), message_id: String(m.id), user_id: who.id };
        if (who.username) row.username = who.username;
        if (who.globalName) row.nickname = who.globalName;
        const server = serverNickOf(guildId, who.id, m);
        if (server) row.server_name = server;
        row.message = textOfMessage(m).replace(/\s+/g, " ").trim().slice(0, WINDOW_LINE_MAX);
        return JSON.stringify(row);
      });
    }

    function resolveReplyInfo(channelId, args, explicitRef) {
      const fromArgs = extractReplyMessage(args);
      const fromStore = messageFromStore(channelId, explicitRef || findReplyRef(args));
      const fromPending = getPendingReplyMessage(channelId);
      const fromCache = cachedPending(channelId);
      const msg = fromArgs || fromPending || fromStore || fromCache;
      if (!msg) {
        log("no reply target", channelId, explicitRef && (explicitRef.message_id || explicitRef.messageId));
        toast("info", "No reply target found (normal message, or reply not loaded)");
        return null;
      }
      const source = fromArgs ? "args" : fromPending ? "pending" : fromStore ? "store" : "cache";
      log("reply target from", source);
      const who = authorOf(msg);
      const snaps = snapshotMessages(msg);
      const forwardAuthor = snaps.length ? authorOf(snaps[0]) : { id: "", username: "", globalName: "" };
      const ref = explicitRef || findReplyRef(args);
      const anchorId = String(msg.id || (ref && (ref.message_id || ref.messageId)) || "");
      const anchorMs = snowflakeToMs(anchorId);
      const chId = channelId || msg.channel_id || msg.channelId;
      const win = sliceAnchorWindow(chId, anchorId);
      const replyUserId = who.id || forwardAuthor.id;
      const historyLines = userHistoryLines(chId, replyUserId);
      const serverName = serverNickOf(guildIdOf(chId, msg), replyUserId, msg);
      log("snowflake anchor", anchorId || "none", win ? "window " + win.items.length : "no window", "history " + historyLines.length, "server_name " + (serverName ? "yes" : "no"));
      const shortId = anchorId ? "…" + anchorId.slice(-6) : "none";
      if (win) toast("ok", "Anchor " + shortId + " · window " + win.items.length + " · history " + historyLines.length);
      else toast("warn", "Anchor " + shortId + ": not in loaded messages, no window · history " + historyLines.length);
      return {
        messageId: anchorId,
        sentAt: anchorMs ? new Date(anchorMs).toISOString() : "",
        windowLines: windowLines(win),
        historyLines: historyLines,
        serverName: serverName,
        text: textOfMessage(msg),
        id: who.id || forwardAuthor.id,
        username: who.username || forwardAuthor.username,
        globalName: who.globalName || forwardAuthor.globalName,
        isBot: isBotMessage(msg) || isBotMessage(snaps[0]),
        isForward: isForwardedMessage(msg),
      };
    }

    function formatContext(reply) {
      const self = getSelfIdentity();
      const lines = [
        "This is Discord. You are writing the outgoing Discord chat message for this speaker:",
        "- discord_user_id: " + (self.id || "unknown"),
        "- discord_username: " + (self.username || "unknown"),
        "- discord_global_name: " + (self.globalName || "unknown"),
      ];
      if (reply && (reply.text || reply.id || reply.messageId || reply.username || reply.globalName || reply.isBot || reply.isForward)) {
        lines.push(reply.isForward
          ? "The speaker is replying to this forwarded Discord message:"
          : reply.isBot
            ? "The speaker is replying to this Discord bot message:"
            : "The speaker is replying to this Discord message:");
        lines.push("- reply_discord_user_id: " + (reply.id || "unknown"));
        lines.push("- reply_discord_username: " + (reply.username || "unknown"));
        lines.push("- reply_discord_global_name: " + (reply.globalName || "unknown"));
        if (reply.serverName) lines.push("- reply_discord_server_name: " + reply.serverName);
        if (reply.isBot) lines.push("- reply_is_bot: true");
        if (reply.isForward) lines.push("- reply_is_forward: true");
        if (reply.messageId) lines.push("- reply_message_id: " + reply.messageId);
        if (reply.sentAt) lines.push("- reply_sent_at: " + reply.sentAt);
        if (reply.text) lines.push("- reply_message: \"" + reply.text.replace(/"/g, "'") + "\"");
        if (reply.windowLines && reply.windowLines.length) {
          lines.push("Channel messages around the reply target (oldest first, UTC times). The line flagged >>> REPLY TARGET is the exact message being replied to; \"speaker\" marks the person you are writing for:");
          for (let i = 0; i < reply.windowLines.length; i++) lines.push(reply.windowLines[i]);
        }
      }
      if (reply && reply.historyLines && reply.historyLines.length) {
        lines.push("Last " + reply.historyLines.length + " messages from the person being replied to (oldest first, one JSON object per line; datetime is UTC, user_id is their snowflake, nickname is their global display name, server_name is their nickname in this server and only present when set):");
        for (let i = 0; i < reply.historyLines.length; i++) lines.push(reply.historyLines[i]);
      }
      lines.push("These are Discord IDs, usernames, global names, and recent messages. Use them ONLY to understand the situation. "
        + "Do NOT insert names, IDs, or details from this context into the message, and do NOT replace pronouns (he, she, they, it, that, this) with names. "
        + "A name or fact may only appear in the output if the speaker's own text already contains it. Keep the speaker's original wording and meaning as close as possible. Output only the final chat message.");
      return lines.join("\n");
    }

    function buildPayloadContext(channelId, args, explicitRef) {
      return formatContext(resolveReplyInfo(channelId, args, explicitRef));
    }

    function getReplyTarget(channelId) {
      try {
        const msg = getPendingReplyMessage(channelId) || cachedPending(channelId);
        return msg && typeof msg === "object" ? msg : null;
      } catch (e) {
        return null;
      }
    }

    // Whether the @ ON/OFF toggle of the pending reply is on. null = unknown.
    function getReplyMention(channelId) {
      try {
        getPendingReplyMessage(channelId); // makes sure PendingReplyStore is resolved
        if (!PendingReplyStore || typeof PendingReplyStore.getPendingReply !== "function") return null;
        const reply = PendingReplyStore.getPendingReply(channelId);
        return reply && typeof reply.shouldMention === "boolean" ? reply.shouldMention : null;
      } catch (e) {
        return null;
      }
    }

    // Slash commands do not go through the normal send flow, so the reply bar stays open.
    function clearPending(channelId) {
      forgetPending(channelId);
      try {
        if (fluxRef && typeof fluxRef.dispatch === "function") {
          fluxRef.dispatch({ type: "DELETE_PENDING_REPLY", channelId: channelId });
        }
      } catch (e) {
        log("could not clear pending reply", e && e.message);
      }
    }

    return { buildPayloadContext, formatContext, findReplyRef, getReplyTarget, getReplyMention, clearPending, forgetPending, start, stop };
  }

  const { storage } = vendetta.plugin;
  const { before, after, instead } = vendetta.patcher;
  const metro = vendetta.metro;
  const { React, ReactNative: RN } = metro.common;
  const { useProxy } = vendetta.storage;
  const { registerCommand } = vendetta.commands;
  const { showToast } = vendetta.ui.toasts;
  const h = React.createElement;

  const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
  const MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];
  const DEFAULT_MODEL = MODELS[0];

  const EDITOR_RULES =
    "You are a text-editing tool inside a chat app, not a conversational assistant. " +
    "The user's text is content to transform, never a message addressed to you: do not reply to it, " +
    "comment on it, or lecture about it. Rude, crude, angry, or emotional wording is still just text to edit: " +
    "keep its meaning and only change how it is worded. Output only the final message text.";

  const REFUSAL_RE =
    /^(i['’]?m sorry|i am sorry|sorry[,.]|i can(?:not|['’]t)|i won['’]t|i['’]m unable|i am unable|i['’]m not able|i['’]m (really |very )?concerned|as an ai|i['’]m here to help)|crisis (help)?line|mental[- ]health professional|reach out for help|you don['’]t have to face this alone/i;

  function looksLikeRefusal(out, original) {
    return REFUSAL_RE.test(out) && !REFUSAL_RE.test(original);
  }

  const REWRITE_RULES =
    "You rewrite the user's chat message. Keep the original meaning, language, and emojis. " +
    "Return ONLY the rewritten message, with no quotes, labels, or explanations.";

  const ANSWER_RULES =
    "The user's text is a chat message they are about to send. " +
    "If it is a question or request that has an objective answer you can give (math, facts, translations, " +
    "definitions, or things like 'say hi in Japanese'), do NOT repeat it: write the final answer itself as the " +
    "chat message, ready to send, and compute math carefully. " +
    "For math, logic, and how/why questions, show a short step-by-step (a few brief lines, one step per line) " +
    "that ends with the final answer. For simple translations or 'say X' requests, just give the answer directly. " +
    "If it is ordinary conversation, or a question aimed at another person (their plans, feelings, opinions, " +
    "availability), just rewrite it and keep its meaning. " +
    "Return ONLY the message to send (including the steps, when asked for), with no quotes, labels, or commentary about the task itself.";

  const PERSONALITIES = {
    "Casual/Slang":
      "Style: relaxed, friendly, natural slang, like a real person texting a friend. Keep it short and lively.",
    Professional:
      "Style: polite, clear, concise and professional. Correct grammar, no slang, no unnecessary emojis.",
  };
  const PERSONALITY_OPTIONS = ["Casual/Slang", "Professional", "Custom"];

  function buildSystemPrompt() {
    const p = PERSONALITY_OPTIONS.includes(storage.personality) ? storage.personality : "Casual/Slang";
    let baseline = PERSONALITIES[p];
    if (p === "Custom") {
      const custom = typeof storage.customPrompt === "string" ? storage.customPrompt.trim() : "";
      baseline = custom || PERSONALITIES["Casual/Slang"];
    }
    const rules = storage.answerQuestions !== false ? ANSWER_RULES : REWRITE_RULES;
    return EDITOR_RULES + "\n\n" + rules + "\n\n" + baseline;
  }

  function Chips(options, selected, onSelect, C, labelFn) {
    const { View, Text, TouchableOpacity } = RN;
    return h(
      View,
      { style: { flexDirection: "row", flexWrap: "wrap" } },
      options.map((opt) =>
        h(
          TouchableOpacity,
          {
            key: "chip-" + opt,
            onPress: () => onSelect(opt),
            style: {
              backgroundColor: opt === selected ? C.accent : C.input,
              borderRadius: 16,
              paddingHorizontal: 14,
              paddingVertical: 8,
              marginRight: 8,
              marginBottom: 8,
            },
          },
          h(Text, { style: { color: opt === selected ? "#fff" : C.muted, fontWeight: "600" } }, labelFn ? labelFn(opt) : opt)
        )
      )
    );
  }

  const unpatches = [];
  let unregisterCommand = null;
  let bypass = false;
  let inFlight = false;
  let queue = Promise.resolve();
  const marks = new Map();

  function markOutput(text) {
    marks.set(text, Date.now());
  }
  function consumeMark(text) {
    const ts = marks.get(text);
    marks.forEach((t, k) => { if (Date.now() - t > 30000) marks.delete(k); });
    if (ts && Date.now() - ts <= 30000) {
      marks.delete(text);
      return true;
    }
    return false;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const log = (...a) => {
    try { console.log("[GroqAI]", ...a); } catch (e) {}
    try { pushLog(a); } catch (e) {}
  };

  // In-memory log buffer (last LOG_MAX lines). Can be written to a file or shared from settings.
  const LOG_MAX = 500;
  const LOG_FILE = "groq-ai-control.log";
  const logBuffer = [];
  let logFlushTimer = null;

  function logPart(v) {
    if (typeof v === "string") return v;
    if (v && typeof v === "object" && v.message) return String(v.message);
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }

  function pushLog(parts) {
    logBuffer.push(new Date().toISOString() + " " + parts.map(logPart).join(" "));
    if (logBuffer.length > LOG_MAX) logBuffer.splice(0, logBuffer.length - LOG_MAX);
    if (storage.logToFile === true) scheduleLogFlush();
  }

  function getFileManager() {
    const names = ["DCDFileManager", "NativeFileModule", "RTNFileManager"];
    const sources = [];
    try { if (typeof nativeModuleProxy !== "undefined" && nativeModuleProxy) sources.push(nativeModuleProxy); } catch (e) {}
    try { if (globalThis.nativeModuleProxy) sources.push(globalThis.nativeModuleProxy); } catch (e) {}
    try { if (RN.NativeModules) sources.push(RN.NativeModules); } catch (e) {}
    for (let i = 0; i < sources.length; i++) {
      for (let j = 0; j < names.length; j++) {
        try {
          const m = sources[i][names[j]];
          if (m && typeof m.writeFile === "function") return m;
        } catch (e) {}
      }
    }
    return null;
  }

  // Writes the whole in-memory log to LOG_FILE. Resolves with the file location, rejects on failure.
  async function writeLogFile() {
    const fm = getFileManager();
    if (!fm) throw new Error("file manager not available");
    await fm.writeFile("documents", LOG_FILE, logBuffer.join("\n") + "\n", "utf8");
    let where = "documents/" + LOG_FILE;
    try {
      const c = typeof fm.getConstants === "function" ? fm.getConstants() : null;
      if (c && c.DocumentsDirPath) where = c.DocumentsDirPath + "/" + LOG_FILE;
    } catch (e) {}
    return where;
  }

  // Debounced auto-write. Must not call log() (that would retrigger itself).
  function scheduleLogFlush() {
    if (logFlushTimer) return;
    logFlushTimer = setTimeout(() => {
      logFlushTimer = null;
      writeLogFile().catch((e) => debugToast("err", "Log write failed: " + ((e && e.message) || "unknown")));
    }, 3000);
  }

  async function uiWriteLog() {
    try {
      showToast("Log written: " + (await writeLogFile()));
    } catch (e) {
      showToast("Couldn't write log: " + ((e && e.message) || "unknown"));
    }
  }

  // The file lives in the app's private storage, so sharing (or copying) is the way to get it out.
  async function uiShareLog() {
    const text = logBuffer.slice(-300).join("\n") || "(log is empty)";
    try {
      if (RN.Share && typeof RN.Share.share === "function") {
        await RN.Share.share({ message: text, title: "Groq AI Control log" });
        return;
      }
    } catch (e) {}
    showToast(copyText(text) ? "Log copied to clipboard" : "Couldn't share or copy log");
  }

  function uiClearLog() {
    logBuffer.length = 0;
    showToast("Log cleared");
  }

  // Debug toasts: shown only when the "Debug toasts" setting is on.
  function debugToast(kind, text) {
    if (storage.debugToasts !== true) return;
    const icon = kind === "ok" ? "✅ " : kind === "warn" ? "⚠️ " : kind === "info" ? "ℹ️ " : "❌ ";
    try { showToast(icon + text); } catch (e) {}
  }

  function getKeys() {
    const list = Array.isArray(storage.apiKeys) ? storage.apiKeys : [];
    return list.map((k) => (k && typeof k.key === "string" ? k.key.trim() : "")).filter(Boolean);
  }

  function getTypingMs() {
    const s = parseFloat(storage.typingDuration);
    return Number.isFinite(s) && s > 0 ? s * 1000 : 0;
  }

  const ChatInputModule =
    metro.findByProps("handleSendMessage", "changeText") ||
    metro.findByProps("handleSendMessage") ||
    metro.find(m => m?.default?.render?.name === "ChatInput" || m?.ChatInput) ||
    null;

  const TextSetters = [
    ["changeText", ChatInputModule],
    ["setText", ChatInputModule],
    ["insertText", ChatInputModule],
    ["changeText", metro.findByProps("changeText")],
    ["setText", metro.findByProps("setText", "clearText")],
    ["setValue", metro.findByProps("setValue", "clearValue")]
  ].filter(
    ([method, module]) =>
      module && typeof module[method] === "function"
  );

  const TypingModule = metro.findByProps("sendTyping", "startTyping");
  const MessageModules = metro.findByProps("sendMessage", "receiveMessage");
  const SelectedChannelStore = metro.findByStoreName ? metro.findByStoreName("SelectedChannelStore") : null;

  const ClipboardModule =
    metro.findByProps("setString", "getString") ||
    (metro.common && metro.common.clipboard) ||
    RN.Clipboard ||
    null;
  const ActionSheetModule = metro.findByProps("openLazy", "hideActionSheet");
  const ASComponents = metro.findByProps("ActionSheet");
  const ActionSheetComp = ASComponents && ASComponents.ActionSheet;

  const NavModule = metro.findByProps("Navigation");
  const Navigation = (NavModule && NavModule.Navigation) || NavModule;
  const FormRowModule = metro.findByProps("FormRow");
  const FormRow = (FormRowModule && FormRowModule.FormRow) || FormRowModule;

  function userContent(text, replyContext) {
    if (!replyContext || replyContext.indexOf("reply_message:") === -1) return text;
    return "The speaker is replying on Discord. Use the referenced message below. Do not ignore it and do not invent a different topic.\n\n" +
      replyContext +
      "\n\nTyped text to turn into the reply. Output only the chat message:\n" + text;
  }

  // ---- Advanced generation settings (unlocked from the settings page) ----
  const REASONING_OPTIONS = ["low", "medium", "high"];
  const ADV_SPEC = {
    temperature: { key: "advTemperature", label: "Temperature", min: 0, max: 2, int: false, def: 0.7,
      hint: "0 to 2. Higher is more creative, lower is more focused. Default 0.7" },
    maxTokens: { key: "advMaxTokens", label: "Max tokens", min: 64, max: 16384, int: true, def: 2048,
      hint: "64 to 16384. Includes reasoning tokens, so a very low value can give empty replies. Default 2048" },
    topP: { key: "advTopP", label: "Top P", min: 0.01, max: 1, int: false, def: 1,
      hint: "0.01 to 1. Lower narrows word choice. Default 1" },
    timeout: { key: "advTimeout", label: "Request timeout (seconds)", min: 5, max: 120, int: true, def: 20,
      hint: "5 to 120. How long to wait for Groq before trying the next key. Default 20" },
  };

  function readAdv(spec) {
    const n = parseFloat(storage[spec.key]);
    if (!Number.isFinite(n)) return spec.def;
    const c = Math.min(spec.max, Math.max(spec.min, n));
    return spec.int ? Math.round(c) : c;
  }

  function getGenParams() {
    const defaultEffort = storage.answerQuestions !== false ? "medium" : "low";
    if (storage.advancedEnabled !== true) {
      return { temperature: 0.7, maxTokens: 2048, topP: null, effort: defaultEffort, timeoutMs: 20000 };
    }
    return {
      temperature: readAdv(ADV_SPEC.temperature),
      maxTokens: readAdv(ADV_SPEC.maxTokens),
      topP: readAdv(ADV_SPEC.topP),
      effort: REASONING_OPTIONS.includes(storage.advReasoning) ? storage.advReasoning : defaultEffort,
      timeoutMs: readAdv(ADV_SPEC.timeout) * 1000,
    };
  }

  // Discord-style confirmation popup (Vendetta alert), with a native Alert fallback.
  // If neither can be shown, nothing is confirmed.
  function confirmDialog(opts) {
    const cancelText = opts.cancelText || "Cancel";
    const cancel = () => { try { if (typeof opts.onCancel === "function") opts.onCancel(); } catch (e) {} };
    try {
      const alerts = vendetta.ui && vendetta.ui.alerts;
      if (alerts && typeof alerts.showConfirmationAlert === "function") {
        log("confirm via Discord alert");
        alerts.showConfirmationAlert({
          title: opts.title,
          content: opts.body,
          confirmText: opts.confirmText,
          confirmColor: opts.confirmColor || "brand",
          cancelText: cancelText,
          onConfirm: opts.onConfirm,
          onCancel: cancel,
        });
        return true;
      }
    } catch (e) {
      log("showConfirmationAlert failed:", e && e.message);
    }
    try {
      log("confirm via native Alert");
      RN.Alert.alert(opts.title, opts.body, [
        { text: cancelText, style: "cancel", onPress: cancel },
        { text: opts.confirmText, style: opts.confirmColor === "red" ? "destructive" : "default", onPress: opts.onConfirm },
      ], { cancelable: true, onDismiss: cancel });
      return true;
    } catch (e) {
      showToast("Groq: couldn't open the confirmation dialog");
      cancel();
      return false;
    }
  }

  async function callGroq(apiKey, text, replyContext = "") {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const gen = getGenParams();
    const timer = controller ? setTimeout(() => controller.abort(), gen.timeoutMs) : null;
    const systemPrompt = buildSystemPrompt() + (replyContext ? "\n\n" + replyContext : "");
    try {
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
        },
        body: JSON.stringify({
          model: MODELS.includes(storage.model) ? storage.model : DEFAULT_MODEL,
          temperature: gen.temperature,
          top_p: gen.topP == null ? undefined : gen.topP,
          reasoning_effort: gen.effort,
          include_reasoning: false,
          max_completion_tokens: gen.maxTokens,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent(text, replyContext) },
          ],
        }),
        signal: controller ? controller.signal : undefined,
      });
      if (!res.ok) {
        const err = new Error("HTTP " + res.status);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      let out = data && data.choices && data.choices[0] && data.choices[0].message
        ? String(data.choices[0].message.content || "").trim()
        : "";
      if (out.length > 1 && out[0] === '"' && out[out.length - 1] === '"') out = out.slice(1, -1).trim();
      if (!out) throw new Error("Empty response");
      if (looksLikeRefusal(out, text)) {
        const err = new Error("Model declined");
        err.refused = true;
        throw err;
      }
      return out;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function rewriteText(text, replyContext = "") {
    const keys = getKeys();
    for (let i = 0; i < keys.length; i++) {
      try {
        const out = await callGroq(keys[i], text, replyContext);
        debugToast("ok", "Groq rewrite ok (key #" + (i + 1) + ")");
        return out;
      } catch (e) {
        log("key #" + (i + 1) + " failed:", e && (e.status || e.message));
        if (e && e.refused) { // other keys would decline too; keep the user's own text
          debugToast("warn", "Groq refused, kept your text");
          return text;
        }
        debugToast("err", "Key #" + (i + 1) + " failed: " + ((e && (e.status || e.message)) || "unknown"));
      }
    }
    debugToast("err", "All keys failed, using your original text");
    return text;
  }

  function startTypingLoop(channelId) {
    if (!channelId || !TypingModule || typeof TypingModule.sendTyping !== "function") return () => {};
    const ping = () => { try { TypingModule.sendTyping(channelId); } catch (e) {} };
    ping();
    const id = setInterval(ping, 8000);
    return () => clearInterval(id);
  }

  const CMD_KEYS = [
    "applicationCommand", "applicationCommandData", "applicationCommandType", "applicationCommandOptions",
    "application_command", "application_command_data", "application_command_type",
    "command", "commandName", "commandId", "command_name", "command_id",
    "interactionData", "interactionType", "interaction",
    "interaction_data", "interaction_type",
    "activeCommand", "commandOptions", "commandPayload",
    "localCommand", "isLocalCommand",
    "selectedCommand", "pendingCommand", "slashCommand",
  ];
  const CMD_KEY_SET = {};
  for (let i = 0; i < CMD_KEYS.length; i++) CMD_KEY_SET[CMD_KEYS[i].toLowerCase()] = true;

  function isCommandKey(key) {
    if (!key) return false;
    const k = String(key);
    if (CMD_KEY_SET[k] || CMD_KEY_SET[k.toLowerCase()]) return true;
    return /^(application_?command|active_?command|local_?command|selected_?command|pending_?command|slash_?command|command_?(name|id|options|payload)?|interaction(_?data|_?type)?)$/i.test(k);
  }

  function hasCommandMarker(v, depth, seen) {
    try {
      if (v == null || typeof v !== "object" || depth > 6 || seen.has(v)) return false;
      seen.add(v);
      if (Array.isArray(v)) {
        const n = Math.min(v.length, 12);
        for (let i = 0; i < n; i++) {
          if (hasCommandMarker(v[i], depth + 1, seen)) return true;
        }
        return false;
      }
      if (v.type === 20 || v.type === 23) return true;
      if (v.interactionType === 2 || v.interaction_type === 2) return true;
      if (v.applicationCommandType === 1 || v.applicationCommandType === 2 || v.applicationCommandType === 3) return true;
      if (v.application_command_type === 1 || v.application_command_type === 2 || v.application_command_type === 3) return true;
      if (v.localCommand === true || v.isLocalCommand === true) return true;
      if (v.applicationId && v.name && (v.type === 1 || v.type === 2 || v.type === 3 || v.options || v.commandOptions)) return true;
      // Slash command option payloads look like [{ type, name, value }]
      if (Array.isArray(v.options) && v.options.some((o) => o && typeof o === "object" && o.name && o.value !== undefined)) return true;
      const keys = Object.keys(v).slice(0, 80);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (isCommandKey(k) && v[k]) return true;
      }
      for (let i = 0; i < keys.length; i++) {
        const c = v[keys[i]];
        if (c && typeof c === "object" && hasCommandMarker(c, depth + 1, seen)) return true;
      }
    } catch (e) {}
    return false;
  }

  function startsWithSlash(text) {
    return typeof text === "string" && /^[\s\u00a0\u1680\u2000-\u200d\u202f\u205f\u2060\u3000\ufeff]*\//.test(text);
  }

  function hasActiveInputCommand() {
    try {
      if (!ChatInputModule) return false;
      if (ChatInputModule.activeCommand || ChatInputModule.applicationCommand || ChatInputModule.localCommand) return true;
      if (typeof ChatInputModule.getActiveCommand === "function" && ChatInputModule.getActiveCommand()) return true;
    } catch (e) {}
    return false;
  }

  function isSlashCommand(text, args) {
    if (startsWithSlash(text)) return true;
    if (hasActiveInputCommand()) return true;
    const seen = new Set();
    for (const a of args || []) {
      if (startsWithSlash(a)) return true;
      if (hasCommandMarker(a, 0, seen)) return true;
    }
    return false;
  }

  // Messages auto-rewrite should leave alone. Each category can be turned off in settings.
  const MENTION_RE = /<@[!&]?\d+>|@everyone|@here/i;
  const LINK_RE = /(?:https?:\/\/|www\.)\S+|\b(?:discord\.gg|discord(?:app)?\.com\/invite)\/\S+/i;
  const PREFIX_CMD_RE = /^\s*[!$%;.?+~][a-z]/i;

  function skipReason(text) {
    if (typeof text !== "string" || !text) return null;
    if (storage.skipMentions !== false && MENTION_RE.test(text)) return "ping";
    if (storage.skipLinks !== false && LINK_RE.test(text)) return "link";
    if (storage.skipBotCommands !== false && PREFIX_CMD_RE.test(text)) return "bot command";
    return null;
  }

  function bypassIfCommand(text, args, where) {
    if (!isSlashCommand(text, args)) return false;
    log("bypass:", where, "application/local command");
    return true;
  }

  function findTextSlot(args) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (typeof a === "string" && !/^\d{15,}$/.test(a)) {
        return { get: () => args[i], set: (v) => { args[i] = v; } };
      }
      if (a && typeof a === "object") {
        for (const k of ["content", "text", "value"]) {
          if (typeof a[k] === "string") {
            return { get: () => args[i][k], set: (v) => { args[i] = Object.assign({}, args[i], { [k]: v }); } };
          }
        }
        if (a.message && typeof a.message.content === "string") {
          return {
            get: () => args[i].message.content,
            set: (v) => { args[i] = Object.assign({}, args[i], { message: Object.assign({}, args[i].message, { content: v }) }); },
          };
        }
      }
    }
    return null;
  }

  function findChannelId(args) {
    for (const a of args) {
      if (a && typeof a === "object" && a.channelId) return a.channelId;
      if (typeof a === "string" && /^\d{15,}$/.test(a)) return a;
    }
    try { return SelectedChannelStore ? SelectedChannelStore.getChannelId() : undefined; } catch (e) { return undefined; }
  }

  const { buildPayloadContext, formatContext, findReplyRef, getReplyTarget, getReplyMention, clearPending, start: startReplyWatch, stop: stopReplyWatch } = createReplyContext({ metro, log, notify: debugToast });

  // Light/dark detection: Discord's own theme first, system scheme as fallback.
  function isLightTheme() {
    try {
      const store = metro.findByStoreName ? metro.findByStoreName("ThemeStore") : null;
      const t = store && typeof store.theme === "string" ? store.theme : null;
      if (t) return t === "light";
    } catch (e) {}
    try {
      const scheme = RN.Appearance && typeof RN.Appearance.getColorScheme === "function" ? RN.Appearance.getColorScheme() : null;
      if (scheme) return scheme === "light";
    } catch (e) {}
    return false;
  }

  function getPalette() {
    return isLightTheme()
      ? { rowBg: "#ffffff", border: "#d4d7dc", text: "#060607", title: "#313338", muted: "#4e5058", placeholder: "#80848e", card: "#f2f3f5" }
      : { rowBg: "#151517", border: "#303136", text: "#f2f3f5", title: "#dbdee1", muted: "#b5bac1", placeholder: "#80848e", card: "#2b2d31" };
  }

  function PreviewSheet(props) {
    const { View, Text, TextInput, TouchableOpacity, ScrollView } = RN;
    const { original, finalText, finish, startEditing, onShown } = props;
    const P = getPalette();
    const C = { text: P.text, muted: P.muted, card: P.card, accent: "#5865f2", danger: "#da373c", neutral: "#4e5058" };

    React.useEffect(() => () => finish({ action: "cancel", text: original }), []);
    React.useEffect(() => { if (typeof onShown === "function") onShown(); }, []);

    const [text, setText] = React.useState(finalText);
    const [editing, setEditing] = React.useState(!!startEditing);
    const [kb, setKb] = React.useState(0);

    React.useEffect(() => {
      const K = RN.Keyboard;
      if (!K || typeof K.addListener !== "function") return undefined;
      const a = K.addListener("keyboardDidShow", (e) => setKb((e && e.endCoordinates && e.endCoordinates.height) || 0));
      const b = K.addListener("keyboardDidHide", () => setKb(0));
      return () => { try { a.remove(); b.remove(); } catch (e) {} };
    }, []);

    const close = () => { try { ActionSheetModule.hideActionSheet(); } catch (e) {} };
    const act = (action, t) => () => { finish({ action, text: t }); close(); };
    const btn = (label, bg, onPress, key) =>
      h(
        TouchableOpacity,
        { key, onPress, style: { backgroundColor: bg, borderRadius: 10, paddingVertical: 12, alignItems: "center", marginTop: 8 } },
        h(Text, { style: { color: "#fff", fontWeight: "700", fontSize: 15 } }, label)
      );

    const body = h(
      View,
      { style: { padding: 16, paddingBottom: 28 + kb } },
      h(Text, { style: { color: C.muted, fontSize: 12, fontWeight: "700", textTransform: "uppercase", marginBottom: 8 } }, "Preview"),
      h(
        View,
        { style: { backgroundColor: C.card, borderRadius: 10, padding: 12, maxHeight: 240 } },
        editing
          ? h(TextInput, {
              value: text,
              onChangeText: setText,
              multiline: true,
              autoFocus: true,
              style: { color: C.text, fontSize: 15, padding: 0, maxHeight: 216, textAlignVertical: "top" },
            })
          : h(ScrollView, null, h(Text, { selectable: true, style: { color: C.text, fontSize: 15 } }, text))
      ),
      btn("Send", C.accent, () => { if (!text.trim()) return; act("send", text)(); }, "send"),
      editing ? null : btn("Edit", C.neutral, () => setEditing(true), "edit"),
      btn("Copy prompt", C.neutral, () => { showToast(copyText(original) ? "Prompt copied to clipboard" : "Couldn't copy to clipboard"); }, "copy"),
      btn("Cancel", C.danger, act("cancel", original), "cancel")
    );
    return ActionSheetComp ? h(ActionSheetComp, null, body) : body;
  }

  function showPreview(original, finalText, startEditing) {
    if (ActionSheetModule && typeof ActionSheetModule.openLazy === "function") {
      return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        // If the sheet never mounts (slash UI still open), fall back to Alert.
        // The timer is cleared by onShown as soon as the sheet is on screen.
        const timer = setTimeout(() => {
          if (done) return;
          log("action sheet did not open, using alert");
          showAlertPreview(original, finalText, startEditing).then(finish);
        }, 2500);
        try {
          ActionSheetModule.openLazy(
            Promise.resolve({ default: PreviewSheet }),
            "GroqPreview",
            {
              original,
              finalText,
              startEditing,
              onShown: () => clearTimeout(timer),
              finish: (v) => { clearTimeout(timer); finish(v); },
            }
          );
        } catch (e) {
          clearTimeout(timer);
          log("action sheet failed, using alert:", e && e.message);
          showAlertPreview(original, finalText, startEditing).then(finish);
        }
      });
    }
    return showAlertPreview(original, finalText, startEditing);
  }

  function showAlertPreview(original, finalText, noEdit) {
    return new Promise((resolve) => {
      const Alert = RN.Alert;
      if (!Alert || typeof Alert.alert !== "function") return resolve({ action: "send", text: finalText });
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const middle = noEdit
        ? { text: "Copy prompt", onPress: () => { showToast(copyText(original) ? "Prompt copied to clipboard" : "Couldn't copy to clipboard"); finish({ action: "cancel", text: original }); } }
        : { text: "Edit", onPress: () => finish({ action: "edit", text: finalText }) };
      try {
        Alert.alert(
          "Preview",
          finalText,
          [
            { text: "Send", onPress: () => finish({ action: "send", text: finalText }) },
            middle,
            { text: "Cancel", style: "cancel", onPress: () => finish({ action: "cancel", text: original }) },
          ],
          { cancelable: true, onDismiss: () => finish({ action: "cancel", text: original }) }
        );
      } catch (e) {
        finish({ action: "send", text: finalText });
      }
    });
  }

  function copyText(text) {
    try {
      if (ClipboardModule && typeof ClipboardModule.setString === "function") {
        ClipboardModule.setString(text);
        return true;
      }
    } catch (e) {}
    return false;
  }

  // Rewrites/answers `original`, shows the typing indicator, (optionally) shows a preview,
  // then waits the typing delay. Resolves with the text to send, or null if the user cancelled.
  async function produceFinalText(original, channelId, textStaysInBox, replyContext = "") {
    const preview = storage.previewBeforeSend !== false;
    const stopTyping = startTypingLoop(channelId);
    let finalText = original;
    try {
      finalText = await rewriteText(original, replyContext);
      if (!preview) {
        const delay = getTypingMs();
        if (delay > 0) await sleep(delay);
      }
    } catch (e) {
      finalText = original;
    } finally {
      stopTyping();
    }

    if (preview) {
      let r = await showPreview(original, finalText);
      // Alert fallback "Edit": reopen the sheet straight in edit mode
      if (r.action === "edit") r = await showPreview(original, r.text || finalText, true);
      if (r.action === "cancel") return null; // Cancel just exits the preview
      finalText = r.text || finalText;
      const stop2 = startTypingLoop(channelId);
      try {
        const delay = getTypingMs();
        if (delay > 0) await sleep(delay);
      } finally {
        stop2();
      }
    }
    markOutput(finalText);
    return finalText;
  }


  let sendShapeReported = false;
  function patchSendMessage() {
    if (!MessageModules || typeof MessageModules.sendMessage !== "function") {
      log("MessageModules.sendMessage not found");
      return false;
    }
    unpatches.push(
      instead("sendMessage", MessageModules, function (args, orig) {
        try {
          if (!sendShapeReported) { sendShapeReported = true; log("sendMessage args:", describeArgs(args)); }
          if (bypass || !storage.autoRewrite) return orig(...args);
          const msg = args[1];
          const content = msg && typeof msg.content === "string" ? msg.content : "";

          if (bypassIfCommand(content, args, "sendMessage")) return orig(...args);
          const skipWhy = skipReason(content);
          if (skipWhy) { log("skip auto-rewrite (" + skipWhy + ")"); return orig(...args); }

          if (!content.trim() || getKeys().length === 0 || consumeMark(content)) {
            return orig(...args);
          }

          const channelId = args[0];
          const replyContext = buildPayloadContext(channelId, args, msg && msg.messageReference);
          log("payload context:", replyContext.replace(/\n/g, " | ").slice(0, 180));
          const job = async () => {
            const finalText = await produceFinalText(content, channelId, false, replyContext);
            if (finalText === null) return;
            const next = args.slice();
            next[1] = Object.assign({}, msg, { content: finalText });
            return orig(...next);
          };
          const p = queue.then(job);
          queue = p.catch(() => {});
          return p;
        } catch (e) {
          return orig(...args);
        }
      })
    );
    return true;
  }

  let shapeReported = false;
  function describeArgs(args) {
    try {
      return args
        .map((a) => {
          if (a === null) return "null";
          if (typeof a !== "object") return typeof a;
          return "{" + Object.keys(a).slice(0, 8).join(",") + "}";
        })
        .join(" | ")
        .slice(0, 160);
    } catch (e) {
      return "?";
    }
  }

  function patchChatInput() {
    if (!ChatInputModule || typeof ChatInputModule.handleSendMessage !== "function") {
      log("ChatInputModule.handleSendMessage not found");
      return;
    }
    unpatches.push(
      instead("handleSendMessage", ChatInputModule, function (args, orig) {
        if (bypass || !storage.autoRewrite || inFlight) {
          if (inFlight && !bypass) return;
          return orig(...args);
        }

        const slot = findTextSlot(args);
        const original = slot ? String(slot.get() || "") : "";

        if (bypassIfCommand(original, args, "handleSendMessage")) return orig(...args);
        const skipWhy = skipReason(original);
        if (skipWhy) { log("skip auto-rewrite (" + skipWhy + ")"); return orig(...args); }
        if (!shapeReported) { shapeReported = true; log("handleSendMessage args:", describeArgs(args)); }

        if (!slot || !original.trim() || getKeys().length === 0) {
          return orig(...args);
        }

        const channelId = findChannelId(args);
        const replyContext = buildPayloadContext(channelId, args, findReplyRef(args));
        log("payload context:", replyContext.replace(/\n/g, " | ").slice(0, 180));
        inFlight = true;

        (async () => {
          const finalText = await produceFinalText(original, channelId, true, replyContext);
          if (finalText === null) { inFlight = false; return; }

          try {
            if (typeof ChatInputModule.changeText === "function") ChatInputModule.changeText(finalText);
          } catch (e) {}

          try {
            slot.set(finalText);
            bypass = true;
            orig(...args);
          } catch (e) {
            try { slot.set(original); orig(...args); } catch (e2) {}
          } finally {
            bypass = false;
            inFlight = false;
          }
        })();
      })
    );
  }

  function registerGroqCommand() {
    unregisterCommand = registerCommand({
      name: "groq",
      displayName: "groq",
      description: "Rewrite your message with Groq AI and send it",
      displayDescription: "Rewrite your message with Groq AI and send it",
      applicationId: "-1",
      inputType: 1,
      type: 1,
      options: [
        {
          name: "text",
          displayName: "text",
          description: "Message to rewrite",
          displayDescription: "Message to rewrite",
          required: true,
          type: 3,
        },
      ],
      execute: async function (args, ctx) {
        const opt = (args || []).find((a) => a.name === "text");
        const original = opt && opt.value ? String(opt.value) : "";
        const channelId = ctx && ctx.channel ? ctx.channel.id : undefined;
        if (!original.trim()) return;

        // Capture the reply target NOW, before the API call. Slash UI clears the pending reply.
        let replyTarget = null;
        let replyMention = null;
        let replyContext = "";
        try {
          replyTarget = getReplyTarget(channelId);
          replyMention = getReplyMention(channelId);
          replyContext = buildPayloadContext(channelId, [], null);
        } catch (e) {
          log("reply capture failed:", e && e.message);
          try { replyContext = formatContext(null); } catch (e2) {}
        }
        log("payload context (/groq):", replyContext.replace(/\n/g, " | ").slice(0, 180));
        log("slash target:", replyTarget && replyTarget.id);

        try {
          // Let the slash UI close before the preview opens.
          if (RN.Keyboard && typeof RN.Keyboard.dismiss === "function") RN.Keyboard.dismiss();
          await sleep(300);
          const finalText = await produceFinalText(original, channelId, false, replyContext);
          if (finalText === null) return;

          const payload = {
            content: finalText,
            tts: false,
            invalidEmojis: [],
            validNonShortcutEmojis: [],
          };
          // Discord's sendMessage is (channelId, message, waitForChannel, extra);
          // the reply reference lives in `extra`, not in the message itself.
          const extra = {};
          if (replyTarget && replyTarget.id) {
            extra.messageReference = {
              guild_id: replyTarget.guild_id || replyTarget.guildId || undefined,
              channel_id: String(replyTarget.channel_id || replyTarget.channelId || channelId),
              message_id: String(replyTarget.id),
            };
            if (replyMention !== null) {
              extra.allowedMentions = { parse: ["users", "roles", "everyone"], replied_user: replyMention };
            }
            log("slash reply ref", extra.messageReference.message_id, "mention:", replyMention);
          } else {
            log("slash: no reply target for", channelId);
          }
          MessageModules.sendMessage(channelId, payload, undefined, extra);
          clearPending(channelId);
        } catch (e) {
          log("/groq failed:", e && e.message);
          showToast("Groq: " + ((e && e.message) || "failed to send message"));
        }
      },
    });
  }

  function GroqSettingsPage() {
    useProxy(storage);
    const { ScrollView, Text, View, TextInput, TouchableOpacity } = RN;
    const Table = metro.findByProps("TableRowGroup", "TableSwitchRow", "TableRow") || {};
    const TableRowGroup = Table.TableRowGroup;
    const TableSwitchRow = Table.TableSwitchRow;
    const TableRow = Table.TableRow;
    const Stack = Table.Stack;
    const SliderMod = metro.findByProps("Slider");
    const Slider = (SliderMod && typeof SliderMod.Slider === "function") ? SliderMod.Slider
      : (typeof RN.Slider === "function" ? RN.Slider : null);
    const CardMod = metro.findByProps("Card");
    const Card = CardMod && CardMod.Card;
    const native = !!(TableRowGroup && TableSwitchRow && TableRow);

    const [newKey, setNewKey] = React.useState("");
    const [duration, setDuration] = React.useState(Number(storage.typingDuration != null ? storage.typingDuration : 3));
    const [durationText, setDurationText] = React.useState(String(storage.typingDuration != null ? storage.typingDuration : 3));
    const [customPrompt, setCustomPrompt] = React.useState(
      typeof storage.customPrompt === "string" ? storage.customPrompt : ""
    );
    const customPromptTimer = React.useRef(null);
    const [, forceRender] = React.useReducer((x) => x + 1, 0);
    const [advText, setAdvText] = React.useState(() => {
      const o = {};
      Object.keys(ADV_SPEC).forEach((k) => { o[k] = String(readAdv(ADV_SPEC[k])); });
      return o;
    });

    React.useEffect(() => {
      return () => {
        if (customPromptTimer.current) clearTimeout(customPromptTimer.current);
      };
    }, []);

    const onCustomPromptChange = (t) => {
      setCustomPrompt(t);
      if (customPromptTimer.current) clearTimeout(customPromptTimer.current);
      customPromptTimer.current = setTimeout(() => { storage.customPrompt = t; }, 250);
    };

    const addKey = () => {
      const k = newKey.trim();
      if (!k.startsWith("gsk_")) return showToast("API key must start with gsk_ 😊");
      const list = Array.isArray(storage.apiKeys) ? storage.apiKeys : [];
      if (list.some((x) => x && x.key === k)) return showToast("Key already added");
      const nextId = list.reduce((m, x) => Math.max(m, (x && x.id) || 0), 0) + 1;
      storage.apiKeys = list.concat([{ id: nextId, key: k }]);
      setNewKey("");
    };
    const removeKey = (id) => {
      storage.apiKeys = (storage.apiKeys || []).filter((x) => x && x.id !== id);
    };
    const confirmRemoveKey = (k) => {
      confirmDialog({
        title: "Delete API key?",
        body: "Key #" + k.id + " (" + mask(k.key) + ") will be removed. This can't be undone.",
        confirmText: "Delete",
        confirmColor: "red",
        onConfirm: () => removeKey(k.id),
      });
    };
    const onAdvancedToggle = (v) => {
      if (!v) { storage.advancedEnabled = false; return; }
      confirmDialog({
        title: "Unlock advanced settings?",
        body:
          "Changing these values can break the AI. For example:\n" +
          "- Max tokens that is too low can cut replies off or return nothing\n" +
          "- A high temperature can produce messy or off-topic text\n" +
          "- A very short timeout makes requests fail before Groq answers\n" +
          "- High reasoning effort makes every reply slower\n\n" +
          "Your custom values are used for every rewrite once unlocked. You can use Reset to defaults or turn this off to go back to the normal values.",
        confirmText: "Unlock",
        confirmColor: "red",
        onConfirm: () => { storage.advancedEnabled = true; },
        onCancel: () => forceRender(),
      });
      // The switch flipped visually; re-render so it snaps back until confirmed.
      setTimeout(forceRender, 0);
    };
    const onAutoRewriteToggle = (v) => {
      if (!v) { storage.autoRewrite = false; return; }
      const previewOff = storage.previewBeforeSend === false;
      const skipped = [];
      const notSkipped = [];
      (storage.skipMentions !== false ? skipped : notSkipped).push("pings");
      (storage.skipLinks !== false ? skipped : notSkipped).push("links");
      (storage.skipBotCommands !== false ? skipped : notSkipped).push("bot commands like !help");
      confirmDialog({
        title: "Enable auto-rewrite?",
        body:
          "Every message you send, in any channel, will be rewritten by Groq AI before it is posted, not only messages sent with /groq. " +
          "Your message text is sent to Groq's API, and sending will be slower." +
          "\n\nSlash commands are never rewritten." +
          (skipped.length ? "\nAlso left alone: messages with " + skipped.join(", ") + "." : "") +
          (notSkipped.length ? "\nWill be rewritten (skipping is off): " + notSkipped.join(", ") + ". Rewriting can break them." : "") +
          (previewOff
            ? "\n\nPreview before sending is OFF, so rewritten messages will be posted without you reviewing them."
            : "\n\nKeep Preview before sending on if you want to review each rewrite first."),
        confirmText: "Enable",
        confirmColor: "red",
        onConfirm: () => { storage.autoRewrite = true; },
        onCancel: () => forceRender(),
      });
      // The switch flipped visually; re-render so it snaps back until confirmed.
      setTimeout(forceRender, 0);
    };
    const mask = (k) => (k.length > 12 ? k.slice(0, 8) + "…" + k.slice(-4) : k);
    const keys = Array.isArray(storage.apiKeys) ? storage.apiKeys : [];
    const model = MODELS.includes(storage.model) ? storage.model : DEFAULT_MODEL;
    const personality = PERSONALITY_OPTIONS.includes(storage.personality) ? storage.personality : "Casual/Slang";

    if (!native) {
      return h(ScrollView, { style: { flex: 1, padding: 16 } },
        h(Text, null, "Discord table settings components were not found.")
      );
    }

    const group = (title, rows) => h(TableRowGroup, { title: title }, rows.filter(Boolean));

    // Discord-style filled button (green = success, red = danger).
    const GREEN = "#248046";
    const RED = "#da373c";
    const button = (label, bg, onPress, small) =>
      h(TouchableOpacity, {
        onPress: onPress,
        activeOpacity: 0.8,
        style: {
          backgroundColor: bg,
          borderRadius: 8,
          paddingVertical: small ? 8 : 12,
          paddingHorizontal: small ? 16 : 20,
          alignItems: "center",
          justifyContent: "center",
        },
      }, h(Text, { style: { color: "#ffffff", fontWeight: "700", fontSize: small ? 14 : 15 } }, label));

    // Labelled text field drawn as a real input box (own column/row), not bare text.
    const P = getPalette();
    const ROW_BG = P.rowBg; // same fill as the option rows (TableRow)
    const BOX = {
      backgroundColor: ROW_BG,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: P.border,
      paddingHorizontal: 12,
      paddingVertical: 8,
    };
    const inputField = (label, props, boxStyle) =>
      h(View, null,
        label
          ? h(Text, { style: { color: P.muted, fontSize: 12, fontWeight: "700", textTransform: "uppercase", marginBottom: 6 } }, label)
          : null,
        h(View, { style: Object.assign({}, BOX, boxStyle || {}) },
          h(TextInput, Object.assign(
            { placeholderTextColor: P.placeholder },
            props,
            { style: Object.assign({ color: P.text, fontSize: 15, padding: 0 }, props.style || {}) }
          ))
        )
      );
    const sw = (label, value, onValueChange, subLabel) =>
      h(TableSwitchRow, { label: label, subLabel: subLabel, value: !!value, onValueChange: onValueChange });

    const pick = (label, selected, onPress) =>
      h(TableRow, {
        label: label,
        trailing: selected ? h(Text, { style: { color: "#5865f2", fontWeight: "700", fontSize: 18 } }, "✓") : undefined,
        onPress: onPress,
      });

    const durationContent = h(View, { style: { padding: 0, gap: 12 } },
      h(View, { style: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" } },
        h(Text, { variant: "heading-md/semibold", style: { color: P.title, flexShrink: 1 } }, "Typing duration (seconds)"),
        inputField(null, {
          placeholder: "0",
          value: durationText,
          keyboardType: "numeric",
          style: { textAlign: "center", fontSize: 14 },
          onChangeText: (t) => {
            setDurationText(t);
            if (t === "" || t.endsWith(".")) return;
            const n = parseFloat(t);
            if (Number.isFinite(n) && n >= 0 && n <= 15) {
              setDuration(n);
              storage.typingDuration = n;
            }
          },
        }, { width: 80, paddingVertical: 6 })
      ),
      Slider
        ? h(Slider, {
            value: Math.min(15, Math.max(0, duration)),
            minimumValue: 0,
            maximumValue: 15,
            step: 0.5,
            onValueChange: (v) => {
              const n = Math.round(Number(v) * 2) / 2;
              setDuration(n);
              setDurationText(String(n));
              storage.typingDuration = n;
            },
          })
        : null
    );
    const durationRow = Card
      ? h(Card, null, durationContent)
      : h(View, { style: { backgroundColor: P.card, borderRadius: 16, overflow: "hidden", padding: 12 } }, durationContent);

    const customField = personality === "Custom"
      ? h(View, { style: { paddingHorizontal: 16, paddingVertical: 12, backgroundColor: ROW_BG } },
          inputField("Custom prompt", {
            value: customPrompt,
            multiline: true,
            placeholder: "Custom prompt guidelines...",
            style: { minHeight: 120, textAlignVertical: "top" },
            onChangeText: onCustomPromptChange,
          })
        )
      : null;

    const advField = (id) => {
      const spec = ADV_SPEC[id];
      const commit = (t) => {
        setAdvText((prev) => Object.assign({}, prev, { [id]: t }));
        const n = parseFloat(t);
        if (Number.isFinite(n) && n >= spec.min && n <= spec.max) storage[spec.key] = spec.int ? Math.round(n) : n;
      };
      return h(View, { key: "adv-" + id, style: { marginBottom: 14 } },
        inputField(spec.label, {
          value: advText[id],
          keyboardType: spec.int ? "number-pad" : "decimal-pad",
          onChangeText: commit,
          onBlur: () => {
            const v = readAdv(spec);
            storage[spec.key] = v;
            setAdvText((prev) => Object.assign({}, prev, { [id]: String(v) }));
          },
        }),
        h(Text, { style: { color: P.muted, fontSize: 12, marginTop: 6 } }, spec.hint)
      );
    };
    const resetAdvanced = () => {
      confirmDialog({
        title: "Reset advanced settings?",
        body: "Temperature, max tokens, top P, reasoning effort and timeout go back to their defaults.",
        confirmText: "Reset",
        confirmColor: "red",
        onConfirm: () => {
          Object.keys(ADV_SPEC).forEach((k) => { storage[ADV_SPEC[k].key] = ADV_SPEC[k].def; });
          storage.advReasoning = "";
          const o = {};
          Object.keys(ADV_SPEC).forEach((k) => { o[k] = String(ADV_SPEC[k].def); });
          setAdvText(o);
        },
      });
    };
    const effort = getGenParams().effort;
    const chipColors = { accent: "#5865f2", input: isLightTheme() ? "#e3e5e8" : "#2b2d31", muted: P.muted };
    const advancedOn = storage.advancedEnabled === true;
    const advancedPanel = advancedOn
      ? h(View, { style: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6, backgroundColor: ROW_BG } },
          advField("temperature"),
          advField("maxTokens"),
          advField("topP"),
          h(View, { style: { marginBottom: 14 } },
            h(Text, { style: { color: P.muted, fontSize: 12, fontWeight: "700", textTransform: "uppercase", marginBottom: 8 } }, "Reasoning effort"),
            Chips(REASONING_OPTIONS, effort, (opt) => { storage.advReasoning = opt; }, chipColors, (o) => o.charAt(0).toUpperCase() + o.slice(1)),
            h(Text, { style: { color: P.muted, fontSize: 12, marginTop: 2 } }, "Higher thinks longer before answering and is slower.")
          ),
          advField("timeout"),
          h(View, { style: { marginBottom: 10 } }, button("Reset to defaults", "#4e5058", resetAdvanced, false))
        )
      : null;

    const body = [
      group("General ⚙️", [
        sw("Auto-rewrite all messages", storage.autoRewrite, onAutoRewriteToggle, "No /groq needed"),
        sw("Auto-answer questions", storage.answerQuestions !== false, (v) => { storage.answerQuestions = v; }, "Math, translations, and other answers"),
        sw("Preview before sending", storage.previewBeforeSend !== false, (v) => { storage.previewBeforeSend = v; }, "Send / Edit / Copy prompt / Cancel"),
      ]),
      group("Skip auto-rewrite for 🚫", [
        sw("Pings", storage.skipMentions !== false, (v) => { storage.skipMentions = v; }, "@user, @role, @everyone, @here"),
        sw("Links", storage.skipLinks !== false, (v) => { storage.skipLinks = v; }, "http(s) links, www., Discord invites"),
        sw("Bot commands", storage.skipBotCommands !== false, (v) => { storage.skipBotCommands = v; }, "Prefix commands like !help, .play, $work"),
      ]),
      group("Timing ⏱️", [durationRow]),
      group("AI Model 🧠", MODELS.map((m) => pick(m.replace("openai/", ""), m === model, () => { storage.model = m; }))),
      group("AI Personality 🎨", [
        ...PERSONALITY_OPTIONS.map((opt) => pick(opt, opt === personality, () => { storage.personality = opt; })),
        customField,
      ]),
      group("Advanced 🛠️", [
        sw("Advanced settings", advancedOn, onAdvancedToggle,
          advancedOn ? "Custom values are in use" : "Unlock temperature, max tokens, and more"),
        advancedPanel,
      ]),
      group("Debug 🐞", [
        sw("Debug toasts", storage.debugToasts === true, (v) => { storage.debugToasts = v; }, "Show success / error toasts for reply context and Groq calls"),
        sw("Save log to file", storage.logToFile === true, (v) => { storage.logToFile = v; if (v) scheduleLogFlush(); }, "Auto-write the in-memory log to " + LOG_FILE),
        h(View, { style: { flexDirection: "row", paddingHorizontal: 16, paddingVertical: 12, backgroundColor: ROW_BG } },
          h(View, { style: { flex: 1, marginRight: 8 } }, button("Write log", GREEN, uiWriteLog, true)),
          h(View, { style: { flex: 1, marginRight: 8 } }, button("Share log", "#4e5058", uiShareLog, true)),
          h(View, { style: { flex: 1 } }, button("Clear log", RED, uiClearLog, true))
        ),
      ]),
      group("Groq API Keys 🔑", [
        keys.length === 0 ? h(TableRow, { label: "No API keys yet" }) : null,
        ...keys.map((k) => h(TableRow, {
          label: "#" + k.id + "  " + mask(k.key),
          trailing: button("Delete", RED, () => confirmRemoveKey(k), true),
        })),
        h(View, { style: { paddingHorizontal: 16, paddingVertical: 12, backgroundColor: ROW_BG } },
          inputField("New API key", {
            value: newKey,
            placeholder: "gsk_...",
            autoCapitalize: "none",
            autoCorrect: false,
            onChangeText: setNewKey,
            onSubmitEditing: addKey,
          })
        ),
        h(View, { style: { paddingHorizontal: 16, paddingBottom: 16, paddingTop: 4, backgroundColor: ROW_BG } },
          button("Add API key", GREEN, addKey, false)
        ),
      ]),
    ];

    const content = Stack
      ? h(Stack, { spacing: 12 }, body)
      : h(View, { style: { gap: 12 } }, body);

    return h(ScrollView, { style: { flex: 1 }, contentContainerStyle: { padding: 12, paddingBottom: 48 } }, content);
  }

  function openGroqPage() {
    const payload = { title: "Groq AI Control", render: GroqSettingsPage };
    try {
      if (Navigation && typeof Navigation.push === "function") {
        Navigation.push("VendettaCustomPage", payload);
        return;
      }
    } catch (e) {}
    try {
      const navMod = metro.findByProps("getRootNavigationRef");
      const ref = navMod && navMod.getRootNavigationRef && navMod.getRootNavigationRef();
      if (ref && typeof ref.navigate === "function") {
        ref.navigate("VendettaCustomPage", payload);
        return;
      }
    } catch (e) {}
    showToast("Groq: unable to open settings page");
  }

  const ROW_KEY = "groq-ai-control-row";
  const ANCHORS = ["Account Switcher", "Commands", "Plugins"];

  function labelOf(node) {
    const p = node && node.props;
    if (!p) return undefined;
    return [p.label, p.title, p.text].find((v) => typeof v === "string");
  }

  function locate(node, anchor) {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const el = node[i];
        if (el && typeof el === "object" && !Array.isArray(el) && labelOf(el) === anchor) {
          return { arr: node, idx: i };
        }
      }
      for (let i = 0; i < node.length; i++) {
        const r = locate(node[i], anchor);
        if (r) return r;
      }
      return null;
    }
    if (node.props && node.props.children) return locate(node.props.children, anchor);
    return null;
  }

  function injectRow(res) {
    if (!res || !res.props || !FormRow) return;
    for (const anchor of ANCHORS) {
      const hit = locate(res.props.children, anchor);
      if (!hit) continue;
      if (hit.arr.some((el) => el && el.key === ROW_KEY)) return;
      hit.arr.splice(
        hit.idx + 1,
        0,
        h(FormRow, {
          key: ROW_KEY,
          label: "Groq AI Control",
          trailing: FormRow.Arrow ? h(FormRow.Arrow) : undefined,
          onPress: openGroqPage,
        })
      );
      return;
    }
  }

  function patchSettingsScreen() {
    const mod = metro.find((m) => m && ((m.default && m.default.name === "SettingsScreen") || m.SettingsScreen));
    if (!mod) {
      log("SettingsScreen not found");
      return;
    }
    const cb = (args, res) => { try { injectRow(res); } catch (e) { log("inject failed", e && e.message); } return res; };

    const comp = mod.default && mod.default.name === "SettingsScreen" ? mod.default : mod.SettingsScreen;
    if (comp && typeof comp.render === "function") {
      unpatches.push(after("render", comp, cb));
    } else if (mod.default && mod.default.name === "SettingsScreen") {
      unpatches.push(after("default", mod, cb));
    } else if (typeof mod.SettingsScreen === "function") {
      unpatches.push(after("SettingsScreen", mod, cb));
    }
  }

  function onLoad() {
    if (!Array.isArray(storage.apiKeys)) storage.apiKeys = [];
    if (typeof storage.autoRewrite !== "boolean") storage.autoRewrite = false;
    if (typeof storage.answerQuestions !== "boolean") storage.answerQuestions = true;
    if (typeof storage.previewBeforeSend !== "boolean") storage.previewBeforeSend = true;
    if (storage.typingDuration == null) storage.typingDuration = 3;
    if (!PERSONALITY_OPTIONS.includes(storage.personality)) storage.personality = "Casual/Slang";
    if (typeof storage.customPrompt !== "string") storage.customPrompt = "";
    if (typeof storage.advancedEnabled !== "boolean") storage.advancedEnabled = false;
    if (typeof storage.skipMentions !== "boolean") storage.skipMentions = true;
    if (typeof storage.skipLinks !== "boolean") storage.skipLinks = true;
    if (typeof storage.skipBotCommands !== "boolean") storage.skipBotCommands = true;
    if (typeof storage.debugToasts !== "boolean") storage.debugToasts = false;
    if (typeof storage.logToFile !== "boolean") storage.logToFile = false;
    Object.keys(ADV_SPEC).forEach((k) => {
      if (!Number.isFinite(parseFloat(storage[ADV_SPEC[k].key]))) storage[ADV_SPEC[k].key] = ADV_SPEC[k].def;
    });
    if (!MODELS.includes(storage.model)) storage.model = DEFAULT_MODEL;

    try { patchSettingsScreen(); } catch (e) { log("settings patch error", e && e.message); }
    try { startReplyWatch(); } catch (e) { log("reply watch error", e && e.message); }
    try {
      patchChatInput();
      patchSendMessage();
    } catch (e) { log("input patch error", e && e.message); }
    try { registerGroqCommand(); } catch (e) { log("command error", e && e.message); }
  }

  function onUnload() {
    try { stopReplyWatch(); } catch (e) {}
    if (logFlushTimer) { clearTimeout(logFlushTimer); logFlushTimer = null; }
    while (unpatches.length) {
      try { unpatches.pop()(); } catch (e) {}
    }
    if (unregisterCommand) {
      try { unregisterCommand(); } catch (e) {}
      unregisterCommand = null;
    }
    bypass = false;
    inFlight = false;
  }

  return { onLoad, onUnload, settings: GroqSettingsPage };

})();
