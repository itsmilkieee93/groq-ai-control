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

    // 🖼️ Image links in a message: attachments, embeds (image / thumbnail of image + gif embeds), plain image links, forwarded snapshots.
    const IMG_EXT_RE = /\.(?:png|jpe?g|webp|gif)(?:$|[?#])/i;
    function imageUrlsOf(msg, depth) {
      const found = [];
      const seen = {};
      const add = (u) => {
        if (typeof u !== "string") return;
        const url = u.trim().replace(/[.,;:!?)\]>]+$/, "");
        if (!/^https?:\/\//i.test(url) || url.length > 2000) return;
        const key = url.split("?")[0];
        if (seen[key]) return;
        seen[key] = true;
        found.push(url);
      };
      const pick = (o) => (o && typeof o === "object" ? (o.url || o.proxyURL || o.proxy_url || o.proxyUrl || "") : "");
      const level = depth || 0;
      if (!msg || typeof msg !== "object" || level > 1) return found;
      const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
      for (let i = 0; i < attachments.length; i++) {
        const a = attachments[i];
        if (!a || typeof a !== "object") continue;
        const ct = String(a.content_type || a.contentType || "");
        const name = String(a.filename || a.name || "");
        const url = a.url || a.proxy_url || a.proxyURL || a.proxyUrl || "";
        const isImg = /^image\//i.test(ct) ? !/svg/i.test(ct) : IMG_EXT_RE.test(name) || IMG_EXT_RE.test(String(url));
        if (isImg) add(url);
      }
      const embeds = Array.isArray(msg.embeds) ? msg.embeds : msg.embed ? [msg.embed] : [];
      for (let i = 0; i < embeds.length && i < 4; i++) {
        const e = embeds[i];
        if (!e || typeof e !== "object") continue;
        add(pick(e.image));
        if (e.type === "image" || e.type === "gifv") {
          add(pick(e.thumbnail));
          if (e.type === "image" && IMG_EXT_RE.test(String(e.url || ""))) add(e.url);
        }
      }
      const content = typeof msg.content === "string" ? msg.content : typeof msg.text === "string" ? msg.text : "";
      const links = content.match(/https?:\/\/[^\s<>"']+/g) || [];
      for (let i = 0; i < links.length && i < 10; i++) {
        const link = links[i].replace(/[.,;:!?)\]>*_~|]+$/, ""); // "pic.png." or "(pic.png)" at the end of a sentence
        if (IMG_EXT_RE.test(link)) add(link);
      }
      const snaps = snapshotMessages(msg);
      for (let i = 0; i < snaps.length; i++) {
        const inner = imageUrlsOf(snaps[i], level + 1);
        for (let j = 0; j < inner.length; j++) add(inner[j]);
      }
      return found.slice(0, MAX_VISION_IMAGES);
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
    // Window size, on/off and "include other people" are all user settings (Reply Context group).
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

    function sliceAnchorWindow(channelId, anchorId, targetUserId) {
      if (!channelId || !anchorId) return null;
      if (storage.ctxWindow === false) return null;
      let all = getChannelMessages(channelId);
      // "Include other people" off: keep only the reply target's messages (the anchor itself always stays).
      if (storage.ctxIncludeOthers === false && targetUserId) {
        all = all.filter((m) => String(m.id) === String(anchorId) || authorOf(m).id === String(targetUserId));
      }
      const idx = all.findIndex((m) => String(m.id) === String(anchorId));
      if (idx === -1) return null;
      const before = ctxSize("ctxBefore", CTX_BEFORE_DEF);
      const after = ctxSize("ctxAfter", CTX_AFTER_DEF);
      const start = Math.max(0, idx - before);
      const end = Math.min(all.length, idx + 1 + after);
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
      const replyUserId = who.id || forwardAuthor.id;
      const win = sliceAnchorWindow(chId, anchorId, replyUserId);
      const historyLines = userHistoryLines(chId, replyUserId);
      const serverName = serverNickOf(guildIdOf(chId, msg), replyUserId, msg);
      log("snowflake anchor", anchorId || "none", win ? "window " + win.items.length : "no window", "history " + historyLines.length, "server_name " + (serverName ? "yes" : "no"));
      const shortId = anchorId ? "…" + anchorId.slice(-6) : "none";
      if (win) toast("ok", "Anchor " + shortId + " · window " + win.items.length + (storage.ctxIncludeOthers === false ? " (target only)" : "") + " · history " + historyLines.length);
      else if (storage.ctxWindow === false) toast("info", "Anchor " + shortId + ": window is off in settings · history " + historyLines.length);
      else toast("warn", "Anchor " + shortId + ": not in loaded messages, no window · history " + historyLines.length);
      return {
        messageId: anchorId,
        sentAt: anchorMs ? new Date(anchorMs).toISOString() : "",
        windowLines: windowLines(win),
        historyLines: historyLines,
        serverName: serverName,
        text: textOfMessage(msg),
        imageUrls: storage.readImages === false ? [] : imageUrlsOf(msg),
        id: who.id || forwardAuthor.id,
        username: who.username || forwardAuthor.username,
        globalName: who.globalName || forwardAuthor.globalName,
        isBot: isBotMessage(msg) || isBotMessage(snaps[0]),
        isForward: isForwardedMessage(msg),
      };
    }

    let lastReplyImages = [];
    function getReplyImages() {
      return lastReplyImages;
    }

    function formatContext(reply, forceAnswer, selfServerName) {
      lastReplyImages = reply && Array.isArray(reply.imageUrls) ? reply.imageUrls : [];
      const self = getSelfIdentity();
      const lines = [
        "This is Discord. You are writing the outgoing Discord chat message for this speaker. In the speaker's own text, 'me', 'my', 'mine', 'myself' and 'I' mean THIS person:",
        "- discord_user_id: " + (self.id || "unknown"),
        "- discord_username: " + (self.username || "unknown"),
        "- discord_global_name: " + (self.globalName || "unknown"),
      ];
      if (selfServerName) lines.push("- discord_server_name: " + selfServerName);
      const replyWho = " (words like he, she, they, him, her in the speaker's text usually mean this person, never the speaker):";
      if (reply && (reply.text || reply.id || reply.messageId || reply.username || reply.globalName || reply.isBot || reply.isForward)) {
        lines.push(reply.isForward
          ? "The speaker is replying to this forwarded Discord message" + replyWho
          : reply.isBot
            ? "The speaker is replying to this Discord bot message" + replyWho
            : "The speaker is replying to this Discord message" + replyWho);
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
      const strict = "Do NOT insert names, IDs, or details from this context into the message, and do NOT replace pronouns (he, she, they, it, that, this) with names. "
        + "A name or fact may only appear in the output if the speaker's own text already contains it. Keep the speaker's original wording and meaning as close as possible, but still fix typos and misspellings. ";
      const footer = forceAnswer === true
        ? "Use this context to answer the speaker's typed text. If it asks about the speaker themselves (who am I, who's me, my name, my id, my nickname), answer directly from the speaker facts above, addressed to the speaker. " +
          "Quote or name people from the context freely when that makes the answer clearer, but state only what the context actually shows. "
        : storage.answerQuestions !== false
        ? "If the speaker's text is an instruction about the reply itself (for example 'reply to Quater', 'answer him', 'say yes', 'tell her no'), do not rewrite or repeat it: write the actual reply to the reply target from this context, in the speaker's own voice, ready to send. " +
          "If the speaker asks about themselves (who am I, who's me, my name, my id, my nickname), answer directly from the speaker facts above, addressed to the speaker (for example 'You're <global name> (@<username>)'), and do not describe the reply target or add anything that is not listed. " +
          "If the speaker's text is a question about this conversation (what someone means, said, or is talking about, who someone is, what happened), answer it from this context in the speaker's own voice, ready to send; if the context cannot answer it, just rewrite the question without guessing. For any other message: " + strict
        : "Use them ONLY to understand the situation. " + strict;
      lines.push("These are Discord IDs, usernames, global names, and recent messages. " + footer + "Output only the final chat message.");
      return lines.join("\n");
    }

    function buildPayloadContext(channelId, args, explicitRef, forceAnswer) {
      let selfServerName = "";
      try {
        const me = getSelfIdentity();
        selfServerName = serverNickOf(guildIdOf(channelId, null), me.id, null);
      } catch (e) {}
      return formatContext(resolveReplyInfo(channelId, args, explicitRef), forceAnswer, selfServerName);
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

    return { buildPayloadContext, formatContext, getReplyImages, findReplyRef, getReplyTarget, getReplyMention, clearPending, forgetPending, start, stop };
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
  // 🌸 Qwen 3.8 27B on Groq is multimodal (text + images), so it also reads images from replied messages.
  const VISION_MODEL = "qwen/qwen3.8-27b";
  const MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", VISION_MODEL];
  const DEFAULT_MODEL = MODELS[0];
  const MAX_VISION_IMAGES = 3; // Groq allows at most 3 images per request
  const modelLabel = (m) => String(m).replace(/^[^/]+\//, "");

  const EDITOR_RULES =
    "You are a text-editing tool inside a chat app, not a conversational assistant. " +
    "The user's text is content to transform, never a message addressed to you: do not reply to it, " +
    "comment on it, or lecture about it. Rude, crude, angry, or emotional wording is still just text to edit: " +
    "keep its meaning and only change how it is worded. " +
    "Always fix typos and misspellings (for example 'inflatixon' becomes 'inflation', 'teh' becomes 'the', 'recieve' becomes 'receive'), " +
    "including when the whole text is one misspelled word. Keep deliberate slang and abbreviations (gonna, ngl, lol), " +
    "usernames, @mentions, links, code, names and emojis exactly as written. Output only the final message text.";

  const REFUSAL_RE =
    /^(i['’]?m sorry|i am sorry|sorry[,.]|i can(?:not|['’]t)|i won['’]t|i['’]m unable|i am unable|i['’]m not able|i['’]m (really |very )?concerned|as an ai|i['’]m here to help)|crisis (help)?line|mental[- ]health professional|reach out for help|you don['’]t have to face this alone/i;

  function looksLikeRefusal(out, original) {
    return REFUSAL_RE.test(out) && !REFUSAL_RE.test(original);
  }

  const REWRITE_RULES =
    "You rewrite the user's chat message. Keep the original meaning, language, and emojis. " +
    "Fix typos and misspellings (for example 'inflatixon' becomes 'inflation'), even when the text is a single misspelled word, " +
    "but keep deliberate slang, usernames, @mentions, links and names as written. " +
    "Return ONLY the rewritten message, with no quotes, labels, or explanations.";

  const ANSWER_RULES =
    "The user's text is either a chat message they are about to send, or a short instruction about what to reply (see INSTRUCTIONS below). " +
    "If it is a question or request that has an objective answer you can give (math, facts, translations, " +
    "definitions, or things like 'say hi in Japanese'), do NOT repeat it: write the final answer itself as the " +
    "chat message, ready to send, and compute math carefully. " +
    "For math, logic, and how/why questions, show a short step-by-step (a few brief lines, one step per line) " +
    "that ends with the final answer. For simple translations or 'say X' requests, just give the answer directly. " +
    "When Discord context is provided (the reply target, surrounding channel messages, recent messages from the person " +
    "being replied to) and the message asks about what was said or what someone means (for example 'what is he talking " +
    "about', 'what does that mean', 'who is that', 'what happened'), answer it yourself from that context as the chat " +
    "message, ready to send; if the context does not contain the answer, just rewrite the question instead of guessing. " +
    "If it is ordinary conversation, or a question aimed at another person (their plans, feelings, opinions, " +
    "availability), just rewrite it and keep its meaning. " +
    "IDENTITY: in the speaker's text, 'me', 'my', 'mine', 'myself' and 'I' mean the SPEAKER (the discord_* fields in the context), " +
    "and 'he', 'she', 'they', 'him', 'her' or 'that person' usually mean the REPLY TARGET (the reply_discord_* fields) unless the text names someone else. " +
    "Other names in the channel messages are third parties. Never mix these people up. You are only the writer for the speaker: never talk about being an AI or a model, " +
    "never answer as yourself, and never invent facts (real name, age, location, role, history, relationships) that are not written in the context. " +
    "If the speaker asks about themselves ('who am I', 'who's me', 'what's my name', 'my id', 'my nickname'), answer plainly with only the speaker facts listed in the context. " +
    "INSTRUCTIONS (this overrides the text-editing rule above): if the text is not something to say but an instruction about the reply itself, " +
    "such as 'reply to Quater', 'answer him', 'respond to this', 'say yes', 'tell her no', 'agree', 'reply with a joke', or 'roast him', " +
    "do NOT rewrite, translate, or repeat the instruction. Write the actual message the speaker would send as a reply to the reply target, " +
    "using the reply target's message and the surrounding Discord context, and follow any stance or tone the instruction gives (agree, refuse, joke, and so on). " +
    "A name inside the instruction says who the reply is for; it is not part of the message. " +
    "If there is no reply target or context to answer from, treat the text as an ordinary message and rewrite it. " +
    "Return ONLY the message to send (including the steps, when asked for), with no quotes, labels, or commentary about the task itself.";

  // Used instead of EDITOR_RULES + ANSWER_RULES when the speaker typed an answer tag ([Answer], [ans] or !~{ans}).
  // Those two rule sets lean towards rewriting, which is exactly what the tag is meant to switch off.
  const FORCED_ANSWER_RULES =
    "You write the outgoing Discord chat message for the speaker. The speaker put an answer tag on their typed text, so it is NOT a message to polish or reword. " +
    "It is a question, request or instruction, and your output is the ANSWER or REPLY itself, written as the message they will send, in their own voice. " +
    "Words like 'reply,', 'answer,', 'respond,' or 'say' at the start are instructions, not part of the question. " +
    "Never repeat, restate, or lightly rephrase the typed text, and never answer with the same question back. " +
    "Lead with the answer. Use the Discord context (the reply target, nearby messages, who said what) together with ordinary general knowledge. " +
    "For math or logic show a few short lines ending with the final answer; for translations or 'say X' requests just give the result. " +
    "If the context only partly covers a question about a person or an event, say what the messages actually show, in a natural casual voice " +
    "(for example 'from what i can see...'). Do not refuse and do not echo the question. " +
    "If neither the context nor general knowledge can answer it, say so in one short natural line (for example 'no clue tbh'). " +
    "Never invent facts about real people such as their job, age, location or history. " +
    "IDENTITY: 'me', 'my', 'mine', 'myself' and 'I' in the typed text mean the SPEAKER (the discord_* fields in the context), " +
    "and 'he', 'she', 'they', 'him', 'her' or 'that person' usually mean the REPLY TARGET (the reply_discord_* fields) unless a name is given. " +
    "Never mix these people up, never talk about being an AI or a model, and never answer as yourself. " +
    "If the speaker asks about themselves ('who am I', 'who's me', 'my name', 'my id', 'my nickname'), answer plainly with only the speaker facts in the context. " +
    "Return ONLY the message to send, with no quotes, labels, or commentary about the task.";

  const PERSONALITIES = {
    "Casual/Slang":
      "Style: relaxed, friendly, natural slang, like a real person texting a friend. Keep it short and lively.",
    Professional:
      "Style: polite, clear, concise and professional. Correct grammar, no slang, no unnecessary emojis.",
  };
  const PERSONALITY_OPTIONS = ["Casual/Slang", "Professional", "Custom"];

  function buildSystemPrompt(forceAnswer) {
    const p = PERSONALITY_OPTIONS.includes(storage.personality) ? storage.personality : "Casual/Slang";
    let baseline = PERSONALITIES[p];
    if (p === "Custom") {
      const custom = typeof storage.customPrompt === "string" ? storage.customPrompt.trim() : "";
      baseline = custom || PERSONALITIES["Casual/Slang"];
    }
    if (forceAnswer === true) return FORCED_ANSWER_RULES + "\n\n" + baseline;
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
        await RN.Share.share({ message: text, title: "AI Writer Magic log" });
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

  // Typing one of these at the very start of a message forces "answer" mode for that one message,
  // even when Auto-answer questions is off or Auto-rewrite is off: !~{ans}, [Answer] or [ans] (any capitalisation).
  const ANS_PREFIX_RE = /^[\s\u00a0\u200b-\u200d\ufeff]*(?:!~\{ans\}|\[(?:answer|ans)\]:?)[\s\u00a0]*/i;
  function parseAnsPrefix(text) {
    if (typeof text !== "string") return { forced: false, text: text };
    const m = ANS_PREFIX_RE.exec(text);
    if (!m) return { forced: false, text: text };
    const rest = text.slice(m[0].length);
    // A bare prefix with nothing after it is just a normal message.
    return rest.trim() ? { forced: true, text: rest } : { forced: false, text: text };
  }

  function userContent(text, replyContext, forceAnswer) {
    const answerOn = forceAnswer === true || storage.answerQuestions !== false;
    const tag = forceAnswer === true
      ? "The speaker tagged the typed text below as an instruction or question to ANSWER, not a message to rewrite. " +
        "Carry it out (answer the question, or write the reply it asks for) and output only the resulting chat message. " +
        "If it is a question, answer it from the Discord context and general knowledge; if the context only partly answers it, say what it shows. " +
        "Never repeat, rephrase or echo the typed text. In the typed text, \"me\", \"my\" and \"I\" mean the speaker described in the Discord context, never you.\n\n"
      : "";
    if (!replyContext || replyContext.indexOf("reply_message:") === -1) return tag ? tag + "Typed text:\n" + text : text;
    return tag + "The speaker is replying on Discord. Use the referenced message below. Do not ignore it and do not invent a different topic.\n\n" +
      replyContext +
      (answerOn
        ? "\n\nTyped text (the message to send, or an instruction about what to reply; if it is an instruction, write the actual reply to the message above instead of repeating it). Output only the chat message:\n"
        : "\n\nTyped text to turn into the reply. Output only the chat message:\n") + text;
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

  // ---- Reply context window settings ----
  const CTX_BEFORE_DEF = 4;
  const CTX_AFTER_DEF = 6;
  const CTX_BEFORE_OPTIONS = [0, 2, 4, 6, 10];
  const CTX_AFTER_OPTIONS = [0, 3, 6, 10, 15];

  function ctxSize(key, def) {
    const n = parseInt(storage[key], 10);
    return Number.isFinite(n) ? Math.min(30, Math.max(0, n)) : def;
  }

  function readAdv(spec) {
    const n = parseFloat(storage[spec.key]);
    if (!Number.isFinite(n)) return spec.def;
    const c = Math.min(spec.max, Math.max(spec.min, n));
    return spec.int ? Math.round(c) : c;
  }

  function getGenParams(forceAnswer) {
    const defaultEffort = (forceAnswer === true || storage.answerQuestions !== false) ? "medium" : "low";
    if (storage.advancedEnabled !== true) {
      return { temperature: 0.7, maxTokens: 2048, topP: null, effort: defaultEffort, effortSet: false, timeoutMs: 20000 };
    }
    return {
      temperature: readAdv(ADV_SPEC.temperature),
      maxTokens: readAdv(ADV_SPEC.maxTokens),
      topP: readAdv(ADV_SPEC.topP),
      effort: REASONING_OPTIONS.includes(storage.advReasoning) ? storage.advReasoning : defaultEffort,
      effortSet: REASONING_OPTIONS.includes(storage.advReasoning),
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
      showToast("AI Writer Magic: couldn't open the confirmation dialog");
      cancel();
      return false;
    }
  }

  // True when the model just handed the typed text back (ignoring case, punctuation and emoji).
  function looksLikeEcho(out, typed) {
    const norm = (t) => String(t || "").toLowerCase().replace(/[\ud800-\udfff]/g, "").replace(/[^a-z0-9\u00c0-\u024f\u0400-\u04ff]+/g, "");
    const a = norm(out);
    const b = norm(typed);
    if (a.length < 8 || b.length < 8) return false;
    if (a === b) return true;
    if (a.indexOf(b) !== -1) return a.length - b.length <= 8;
    if (b.indexOf(a) !== -1) return b.length - a.length <= 8;
    return false;
  }

  // 🌸 Web search via Exa (direct) or Composio Exa connector.
  // Used to ground answers when search is enabled and a key is present.
  async function searchWeb(query) {
    const q = String(query || "").trim();
    if (!q || q.length < 3) return null;
    const exaKey = (storage.exaApiKey || "").trim();
    const composioKey = (storage.composioApiKey || "").trim();

    // Prefer direct Exa if key is set.
    if (exaKey) {
      try {
        const res = await fetch("https://api.exa.ai/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + exaKey,
          },
          body: JSON.stringify({
            query: q,
            type: "auto",
            numResults: 5,
            contents: { highlights: true, text: { maxCharacters: 400 } },
          }),
        });
        if (!res.ok) {
          log("Exa search failed", res.status);
          return null;
        }
        const data = await res.json();
        const results = (data && data.results) || [];
        if (!results.length) return null;
        return results.slice(0, 5).map((r, i) => {
          const title = r.title || "Untitled";
          const url = r.url || "";
          const snippet = (r.highlights && r.highlights[0]) || (r.text || "").slice(0, 300);
          return (i + 1) + ". " + title + "\n   " + url + "\n   " + snippet;
        }).join("\n\n");
      } catch (e) {
        log("Exa search error", e && e.message);
        return null;
      }
    }

    // Fallback to Composio Exa connector.
    // Uses COMPOSIO_SEARCH_WEB (which calls Exa under the hood) or EXA_SEARCH.
    if (composioKey) {
      try {
        // Try COMPOSIO_SEARCH_WEB first (simple query param).
        const toolSlug = "COMPOSIO_SEARCH_WEB";
        const res = await fetch("https://backend.composio.dev/api/v3.1/tools/execute/" + toolSlug, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": composioKey,
          },
          body: JSON.stringify({
            arguments: { query: q },
            user_id: "discord-ai-writer",
            version: "latest",
          }),
        });
        if (!res.ok) {
          log("Composio search failed", res.status, await res.text().catch(() => ""));
          return null;
        }
        const data = await res.json();
        if (!data || data.successful === false) {
          log("Composio search unsuccessful", data && data.error);
          return null;
        }
        // Parse various response shapes for search results.
        const d = data.data || data;
        let out = "";
        // COMPOSIO_SEARCH_WEB style
        if (d.answer) out += d.answer + "\n\n";
        if (d.results && d.results.answer) out += d.results.answer + "\n\n";
        const citations = (d.results && d.results.citations) || d.citations || d.results || [];
        if (Array.isArray(citations) && citations.length) {
          out += citations.slice(0, 5).map((c, i) => {
            const title = c.title || c.name || "Result";
            const url = c.url || c.link || "";
            const snippet = c.snippet || c.text || c.highlight || "";
            return (i + 1) + ". " + title + (url ? "\n   " + url : "") + (snippet ? "\n   " + String(snippet).slice(0, 250) : "");
          }).join("\n\n");
        }
        // EXA_SEARCH style (results array)
        if (!out && Array.isArray(d.results)) {
          out = d.results.slice(0, 5).map((r, i) => {
            const title = r.title || "Untitled";
            const url = r.url || "";
            const snippet = (r.highlights && r.highlights[0]) || r.text || "";
            return (i + 1) + ". " + title + "\n   " + url + "\n   " + String(snippet).slice(0, 250);
          }).join("\n\n");
        }
        return out.trim() || null;
      } catch (e) {
        log("Composio search error", e && e.message);
        return null;
      }
    }
    return null;
  }

  // ---- 🧮 Local math engine: pure JavaScript (Math + BigInt). No eval, no Function. ----
  const HAS_BIGINT = typeof BigInt === "function";
  const B = (n) => BigInt(n); // only called when HAS_BIGINT
  const isBig = (v) => typeof v === "bigint";
  const toNum = (v) => (isBig(v) ? Number(v) : v);
  const MATH_CONSTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI, phi: (1 + Math.sqrt(5)) / 2, ln2: Math.LN2, ln10: Math.LN10, sqrt2: Math.SQRT2 };
  const cleanTrig = (r) => (Math.abs(r) < 1e-14 ? 0 : r);
  const MAX_TOOL_ROUNDS = 3;
  const MATH_HINT = /\d|\b(?:sqrt|square root|cube root|percent|plus|minus|times|multiplied|divided|squared|cubed|factorial|power|log|sin|cos|tan|calculate|compute|solve|average|mean)\b|[√π²³]/i;

  const mAdd = (a, b) => (isBig(a) && isBig(b) ? a + b : toNum(a) + toNum(b));
  const mSub = (a, b) => (isBig(a) && isBig(b) ? a - b : toNum(a) - toNum(b));
  const mMul = (a, b) => (isBig(a) && isBig(b) ? a * b : toNum(a) * toNum(b));
  const mNeg = (a) => -a;
  function mDiv(a, b) {
    if (isBig(a) && isBig(b)) {
      if (b === B(0)) throw new Error("division by zero");
      return a % b === B(0) ? a / b : Number(a) / Number(b);
    }
    const d = toNum(b);
    if (d === 0) throw new Error("division by zero");
    return toNum(a) / d;
  }
  function mMod(a, b) {
    if (isBig(a) && isBig(b)) {
      if (b === B(0)) throw new Error("modulo by zero");
      return a % b;
    }
    const y = toNum(b);
    if (y === 0) throw new Error("modulo by zero");
    return toNum(a) % y;
  }
  function mPow(a, b) {
    if (isBig(a) && isBig(b) && b >= B(0)) {
      const e = Number(b);
      const est = e * Math.log10(Math.max(1, Math.abs(Number(a))));
      if (est <= 2000) {
        let result = B(1);
        let base = a;
        let k = e;
        while (k > 0) {
          if (k % 2 === 1) result = result * base;
          k = Math.floor(k / 2);
          if (k > 0) base = base * base;
        }
        return result;
      }
      return Math.pow(Number(a), e);
    }
    return Math.pow(toNum(a), toNum(b));
  }
  function mFact(v) {
    const n = toNum(v);
    if (!Number.isInteger(n) || n < 0) throw new Error("factorial needs a whole number, 0 or higher");
    if (n > 500) throw new Error("factorial is limited to 500");
    if (HAS_BIGINT) {
      let r = B(1);
      for (let i = 2; i <= n; i++) r = r * B(i);
      return r;
    }
    if (n > 170) throw new Error("factorial too large");
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return r;
  }
  function gcdNum(x, y) {
    x = Math.abs(x);
    y = Math.abs(y);
    while (y) { const t = x % y; x = y; y = t; }
    return x;
  }
  function needInts(a, name) {
    for (let i = 0; i < a.length; i++) {
      if (!Number.isInteger(toNum(a[i]))) throw new Error(name + " needs whole numbers");
    }
  }
  // name: [minArgs, maxArgs, fn(argsArray)]
  const MATH_FN = {
    sqrt: [1, 1, (a) => Math.sqrt(toNum(a[0]))],
    cbrt: [1, 1, (a) => Math.cbrt(toNum(a[0]))],
    abs: [1, 1, (a) => (isBig(a[0]) ? (a[0] < B(0) ? -a[0] : a[0]) : Math.abs(a[0]))],
    sign: [1, 1, (a) => Math.sign(toNum(a[0]))],
    floor: [1, 1, (a) => (isBig(a[0]) ? a[0] : Math.floor(a[0]))],
    ceil: [1, 1, (a) => (isBig(a[0]) ? a[0] : Math.ceil(a[0]))],
    trunc: [1, 1, (a) => (isBig(a[0]) ? a[0] : Math.trunc(a[0]))],
    round: [1, 2, (a) => {
      if (isBig(a[0])) return a[0];
      const d = a.length > 1 ? toNum(a[1]) : 0;
      if (!Number.isInteger(d) || d < 0 || d > 12) throw new Error("round digits must be a whole number from 0 to 12");
      return d === 0 ? Math.round(a[0]) : Number(a[0].toFixed(d));
    }],
    sin: [1, 1, (a) => cleanTrig(Math.sin(toNum(a[0])))],
    cos: [1, 1, (a) => cleanTrig(Math.cos(toNum(a[0])))],
    tan: [1, 1, (a) => cleanTrig(Math.tan(toNum(a[0])))],
    asin: [1, 1, (a) => Math.asin(toNum(a[0]))],
    acos: [1, 1, (a) => Math.acos(toNum(a[0]))],
    atan: [1, 1, (a) => Math.atan(toNum(a[0]))],
    atan2: [2, 2, (a) => Math.atan2(toNum(a[0]), toNum(a[1]))],
    sinh: [1, 1, (a) => Math.sinh(toNum(a[0]))],
    cosh: [1, 1, (a) => Math.cosh(toNum(a[0]))],
    tanh: [1, 1, (a) => Math.tanh(toNum(a[0]))],
    sind: [1, 1, (a) => cleanTrig(Math.sin(toNum(a[0]) * Math.PI / 180))],
    cosd: [1, 1, (a) => cleanTrig(Math.cos(toNum(a[0]) * Math.PI / 180))],
    tand: [1, 1, (a) => cleanTrig(Math.tan(toNum(a[0]) * Math.PI / 180))],
    deg: [1, 1, (a) => toNum(a[0]) * 180 / Math.PI],
    rad: [1, 1, (a) => toNum(a[0]) * Math.PI / 180],
    exp: [1, 1, (a) => Math.exp(toNum(a[0]))],
    ln: [1, 1, (a) => Math.log(toNum(a[0]))],
    log: [1, 2, (a) => (a.length > 1 ? Math.log(toNum(a[0])) / Math.log(toNum(a[1])) : Math.log10(toNum(a[0])))],
    log2: [1, 1, (a) => Math.log2(toNum(a[0]))],
    log10: [1, 1, (a) => Math.log10(toNum(a[0]))],
    pow: [2, 2, (a) => mPow(a[0], a[1])],
    min: [1, 20, (a) => a.reduce((m, v) => (toNum(v) < toNum(m) ? v : m))],
    max: [1, 20, (a) => a.reduce((m, v) => (toNum(v) > toNum(m) ? v : m))],
    hypot: [1, 20, (a) => Math.hypot.apply(null, a.map(toNum))],
    gcd: [2, 2, (a) => { needInts(a, "gcd"); return gcdNum(toNum(a[0]), toNum(a[1])); }],
    lcm: [2, 2, (a) => {
      needInts(a, "lcm");
      const x = toNum(a[0]);
      const y = toNum(a[1]);
      return x === 0 || y === 0 ? 0 : Math.abs(x / gcdNum(x, y) * y);
    }],
    mod: [2, 2, (a) => mMod(a[0], a[1])],
    fact: [1, 1, (a) => mFact(a[0])],
    factorial: [1, 1, (a) => mFact(a[0])],
  };

  function mathTokens(raw) {
    const s = String(raw)
      .replace(/[×✕]/g, "*").replace(/÷/g, "/").replace(/[−–]/g, "-")
      .replace(/\*\*/g, "^").replace(/√/g, " sqrt ").replace(/π/g, " pi ")
      .replace(/\u00b2/g, "^2").replace(/\u00b3/g, "^3");
    const toks = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
      const rest = s.slice(i);
      let m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
      if (m) { toks.push({ t: "num", v: m[0] }); i += m[0].length; continue; }
      m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
      if (m) {
        const w = m[0].toLowerCase();
        if (w === "of" || w === "x" || w === "times") toks.push({ t: "op", v: "*" });
        else if (w === "plus") toks.push({ t: "op", v: "+" });
        else if (w === "minus") toks.push({ t: "op", v: "-" });
        else toks.push({ t: "id", v: w });
        i += m[0].length;
        continue;
      }
      if ("+-*/%^!(),".indexOf(c) !== -1) { toks.push({ t: "op", v: c }); i++; continue; }
      throw new Error("unexpected character '" + c + "'");
    }
    if (toks.length > 200) throw new Error("expression too long");
    return toks;
  }

  function fmtMathResult(v) {
    if (isBig(v)) {
      const str = v.toString();
      if (str.length <= 400) return str;
      const neg = str[0] === "-" ? "-" : "";
      const d = neg ? str.slice(1) : str;
      return neg + d[0] + "." + d.slice(1, 15) + "e+" + (d.length - 1) + " (" + d.length + " digits)";
    }
    if (typeof v !== "number" || isNaN(v)) throw new Error("result is not a real number");
    if (!isFinite(v)) throw new Error("result is infinite or too large");
    return String(Number(v.toPrecision(15)));
  }

  // Evaluates a math expression safely. Returns { value, text }. Throws Error with a readable message.
  function evalMath(input) {
    const src = String(input == null ? "" : input).trim();
    if (!src) throw new Error("empty expression");
    if (src.length > 300) throw new Error("expression too long (max 300 characters)");
    const toks = mathTokens(src);
    let p = 0;
    let depth = 0;
    const isOp = (t, v) => !!t && t.t === "op" && t.v === v;
    const startsOperand = (t) => !!t && (t.t === "num" || t.t === "id" || isOp(t, "("));
    const need = (v) => { if (!isOp(toks[p], v)) throw new Error("expected '" + v + "'"); p++; };

    function parseExpr() {
      if (++depth > 60) throw new Error("expression nested too deeply");
      let v = parseTerm();
      for (;;) {
        if (isOp(toks[p], "+")) { p++; v = mAdd(v, parseTerm()); }
        else if (isOp(toks[p], "-")) { p++; v = mSub(v, parseTerm()); }
        else break;
      }
      depth--;
      return v;
    }
    function parseTerm() {
      let v = parseUnary();
      for (;;) {
        const t = toks[p];
        if (isOp(t, "*")) { p++; v = mMul(v, parseUnary()); }
        else if (isOp(t, "/")) { p++; v = mDiv(v, parseUnary()); }
        else if (isOp(t, "%") && startsOperand(toks[p + 1])) { p++; v = mMod(v, parseUnary()); }
        else if (t && (t.t === "id" || isOp(t, "("))) { v = mMul(v, parseUnary()); } // 2pi, 3(4+1)
        else break;
      }
      return v;
    }
    function parseUnary() {
      if (isOp(toks[p], "-")) { p++; return mNeg(parseUnary()); }
      if (isOp(toks[p], "+")) { p++; return parseUnary(); }
      return parsePower();
    }
    function parsePower() {
      const base = parsePostfix();
      if (isOp(toks[p], "^")) { p++; return mPow(base, parseUnary()); }
      return base;
    }
    function parsePostfix() {
      let v = parsePrimary();
      for (;;) {
        if (isOp(toks[p], "!")) { p++; v = mFact(v); }
        else if (isOp(toks[p], "%") && !startsOperand(toks[p + 1])) { p++; v = toNum(v) / 100; } // 15% = 0.15
        else break;
      }
      return v;
    }
    function parsePrimary() {
      const t = toks[p];
      if (!t) throw new Error("unexpected end of expression");
      if (t.t === "num") {
        p++;
        if (HAS_BIGINT && /^\d+$/.test(t.v)) return BigInt(t.v);
        return parseFloat(t.v);
      }
      if (isOp(t, "(")) { p++; const v = parseExpr(); need(")"); return v; }
      if (t.t === "id") {
        p++;
        const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
        if (has(MATH_CONSTS, t.v) && !isOp(toks[p], "(")) return MATH_CONSTS[t.v];
        const spec = has(MATH_FN, t.v) ? MATH_FN[t.v] : null;
        if (!spec) throw new Error("unknown name '" + t.v + "'");
        let args = [];
        if (isOp(toks[p], "(")) {
          p++;
          if (!isOp(toks[p], ")")) {
            for (;;) {
              args.push(parseExpr());
              if (isOp(toks[p], ",")) { p++; continue; }
              break;
            }
          }
          need(")");
        } else {
          args = [parseUnary()]; // sqrt 16
        }
        if (args.length < spec[0] || args.length > spec[1]) {
          throw new Error(t.v + " takes " + (spec[0] === spec[1] ? spec[0] : spec[0] + " to " + spec[1]) + " argument(s)");
        }
        return spec[2](args);
      }
      throw new Error("unexpected '" + t.v + "'");
    }

    const value = parseExpr();
    if (p < toks.length) throw new Error("unexpected '" + toks[p].v + "'");
    return { value: value, text: fmtMathResult(value) };
  }

  const MATH_TOOL = {
    type: "function",
    function: {
      name: "calculate",
      description:
        "Exactly evaluate a math expression with JavaScript. Use it for ANY arithmetic, percentages, powers, roots, trigonometry, logarithms or factorials instead of calculating in your head. " +
        "Supports + - * / % (modulo) ^ (power) ! (factorial), parentheses, constants pi e tau phi, and functions: " +
        "sqrt cbrt abs sign floor ceil trunc round(x,digits) sin cos tan asin acos atan atan2 sinh cosh tanh (radians), sind cosd tand (degrees), deg rad, " +
        "exp ln log (base 10) log2 log10 log(x,base) pow min max hypot gcd lcm mod fact. " +
        "Whole numbers are exact (BigInt) for + - * ^ !. Write 15% as 15/100. No units or thousands separators. Call it once per separate calculation.",
      parameters: {
        type: "object",
        properties: { expression: { type: "string", description: "For example: 15/100*2340 + sqrt(144)" } },
        required: ["expression"],
      },
    },
  };

  // 🪜 Used while the JS calculator is live: the AI still writes its own short steps, JS supplies every number.
  const MATH_STEPS_RULES =
    "MATH STEPS: you have a `calculate` tool that is exact. Still show your working as a short step-by-step in your own words, " +
    "one step per line (2 to 6 brief lines), and end with the final answer on the last line. " +
    "Run every numeric calculation through `calculate` and copy its result into the steps exactly, never recompute numbers in your head. " +
    "Each step says what is being done and its result, for example: 'Take 15% of 2340: 351'. " +
    "The final answer must be the exact result of the last `calculate` call. " +
    "Do not paste the raw tool expression or mention the tool or JavaScript. " +
    "A single trivial operation can be one line that already ends in the answer.";

  function runMathTool(args, withSteps, sink) {
    let expr = "";
    try {
      const a = typeof args === "string" ? JSON.parse(args || "{}") : (args || {});
      expr = String(a.expression != null ? a.expression : a.expr != null ? a.expr : "");
    } catch (e) {
      return 'Error: arguments must be JSON like {"expression":"2+2"}';
    }
    try {
      const r = evalMath(expr);
      log("math:", expr, "=", r.text);
      if (sink) sink.push(r.text);
      return expr + " = " + r.text + (withSteps ? "\n(Use this exact value in your step-by-step.)" : "");
    } catch (e) {
      return "Error: " + ((e && e.message) || "could not evaluate") + ". Use only numbers, + - * / % ^ ! parentheses and the listed functions.";
    }
  }

  // 🪜 True when the AI's final text really contains the last JS result (commas ignored, tiny rounding allowed).
  function answerUsesMath(out, results) {
    if (!results || !results.length) return true;
    const last = String(results[results.length - 1]);
    const hay = String(out).replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
    const v = Number(last);
    if (!/^-?\d+$/.test(last) && hay.indexOf(last) !== -1) return true;
    if (!isFinite(v)) return true; // huge BigInt text: can't compare reliably, don't force a retry
    const nums = hay.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi) || [];
    return nums.some((n) => {
      const x = Number(n);
      if (!isFinite(x)) return false;
      if (/^-?\d+$/.test(last)) return x === v; // whole-number results must match exactly
      return Math.abs(x - v) <= Math.max(Math.abs(v) * 0.005, 0.01); // decimals: allow rounding
    });
  }

  // 🌸 Token + rate-limit info from the last Groq call, shown in the preview sheet.
  let lastUsage = null;
  const fmtNum = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const hdrNum = (res, name) => {
    try {
      const v = res && res.headers && res.headers.get ? res.headers.get(name) : null;
      const n = v == null ? NaN : parseInt(v, 10);
      return isNaN(n) ? null : n;
    } catch (e) { return null; }
  };
  const hdrStr = (res, name) => {
    try { return (res && res.headers && res.headers.get && res.headers.get(name)) || null; } catch (e) { return null; }
  };
  // Groq sends reset times like "59.56s", "2m59.56s" or "1h2m3s". Returns milliseconds, or null.
  function parseResetMs(str) {
    if (!str) return null;
    const re = /(\d+(?:\.\d+)?)(ms|d|h|m|s)/g;
    const unit = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
    let ms = 0, found = false, m;
    while ((m = re.exec(String(str)))) { ms += parseFloat(m[1]) * unit[m[2]]; found = true; }
    return found ? ms : null;
  }
  function fmtClock(ts) {
    try {
      const d = new Date(ts);
      const p = (n) => (n < 10 ? "0" : "") + n;
      return p(d.getHours()) + ":" + p(d.getMinutes()) + (d.toDateString() !== new Date().toDateString() ? " tomorrow" : "");
    } catch (e) { return ""; }
  }
  function formatUsage(u) {
    if (!u) return null;
    const lines = [];
    if (u.total > 0) lines.push("Used " + fmtNum(u.total) + " tokens (" + fmtNum(u.prompt) + " in · " + fmtNum(u.completion) + " out)");
    if (u.remTokens != null) {
      lines.push("Tokens left: " + fmtNum(u.remTokens) + (u.limTokens != null ? " / " + fmtNum(u.limTokens) : "") + " per min" + (u.resetTokens ? " (resets in " + u.resetTokens + ")" : ""));
    }
    if (u.remReq != null || u.resetReq) {
      // 🕒 When the request quota (per day) resets: relative time from Groq plus the clock time it works out to.
      const at = u.resetReqAt ? fmtClock(u.resetReqAt) : "";
      const reset = u.resetReq ? "resets in " + u.resetReq + (at ? " · at " + at : "") : "";
      if (u.remReq != null) {
        lines.push("Requests left: " + fmtNum(u.remReq) + (u.limReq != null ? " / " + fmtNum(u.limReq) : "") + " per day" + (reset ? " (" + reset + ")" : ""));
      } else {
        lines.push("Requests " + reset.replace(/^resets/, "reset"));
      }
    }
    return lines.length ? lines : null;
  }

  async function callGroq(apiKey, text, replyContext = "", forceAnswer = false) {
    const usage = { prompt: 0, completion: 0, total: 0, remTokens: null, limTokens: null, remReq: null, limReq: null, resetTokens: null, resetReq: null, resetReqAt: null };
    lastUsage = usage;
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const gen = getGenParams(forceAnswer);
    const timer = controller ? setTimeout(() => controller.abort(), gen.timeoutMs) : null;
    let systemPrompt = buildSystemPrompt(forceAnswer) + (replyContext ? "\n\n" + replyContext : "");

    // 🌸 Optional web search grounding for answers.
    if ((forceAnswer || storage.answerQuestions !== false) && storage.searchEnabled === true) {
      const searchQuery = String(text || "").replace(/^[!~\[]?(ans|answer)\]?\s*/i, "").trim().slice(0, 200);
      if (searchQuery.length >= 4) {
        const results = await searchWeb(searchQuery);
        if (results) {
          systemPrompt += "\n\n=== CURRENT WEB SEARCH RESULTS (PRIORITY OVER YOUR TRAINING DATA) ===\n" +
            "These results are from a live web search. For any facts, dates, release dates, news, or current information, " +
            "YOU MUST prefer these results over your own knowledge. If the search results contradict what you remember, " +
            "use the search results. Cite the source briefly when useful.\n\n" +
            results +
            "\n=== END SEARCH RESULTS ===";
          log("web search injected for answer");
        }
      }
    }

    const answerMode = forceAnswer === true || storage.answerQuestions !== false;

    // 🖼️ Images from the replied message are read by Qwen 3.8 27B (the vision model).
    let images = [];
    if (storage.readImages !== false && replyContext && replyContext.indexOf("reply_message:") !== -1) {
      try { images = (getReplyImages() || []).slice(0, MAX_VISION_IMAGES); } catch (e) { images = []; }
    }
    let imagesOn = images.length > 0;
    if (imagesOn) {
      log("reading " + images.length + " replied image(s) with " + VISION_MODEL);
      debugToast("info", "Reading " + images.length + " image" + (images.length === 1 ? "" : "s") + " with " + modelLabel(VISION_MODEL));
    }

    // 🧮 JS calculator tool: the model calls it for exact math instead of guessing.
    const replyLine = (/- reply_message: "([^\n]*)/.exec(replyContext || "") || [])[1] || "";
    const useMath = storage.mathTool !== false && answerMode && MATH_HINT.test(String(text || "") + " " + replyLine);
    // 🪜 AI steps stay on even though the JS calculator does the arithmetic.
    const mathSteps = useMath; // steps always come with the JS calculator (single "JS math + AI steps" switch)
    const mathResults = []; // exact JS results of this answer, used to check the AI's steps
    let mathChecked = false;

    const buildBase = () => {
      const typed = userContent(text, replyContext, forceAnswer);
      let userMsg = typed;
      if (imagesOn) {
        const note = "The replied Discord message contains " + images.length + " image" + (images.length === 1 ? "" : "s") +
          ", attached below. Use the image" + (images.length === 1 ? "" : "s") + " only when the speaker's text asks about or depends on " +
          (images.length === 1 ? "it" : "them") + " (what is in it, read the text in it, what it means, reply to it). Never invent details that are not visible.\n\n";
        userMsg = [{ type: "text", text: note + typed }].concat(images.map((u) => ({ type: "image_url", image_url: { url: u } })));
      }
      return [
        { role: "system", content: mathSteps ? systemPrompt + "\n\n" + MATH_STEPS_RULES : systemPrompt },
        { role: "user", content: userMsg },
      ];
    };

    const ask = async (extra) => {
      const msgs = buildBase().concat(extra || []);
      mathResults.length = 0;
      for (let round = 0; ; round++) {
        const model = imagesOn ? VISION_MODEL : (MODELS.includes(storage.model) ? storage.model : DEFAULT_MODEL);
        const qwen = model.indexOf("qwen/") === 0;
        const body = {
          model: model,
          temperature: gen.temperature,
          top_p: gen.topP == null ? undefined : gen.topP,
          // Qwen: "default" = no reasoning tokens (fast); an effort chosen in Advanced settings is respected.
          reasoning_effort: qwen ? (gen.effortSet ? gen.effort : "default") : gen.effort,
          max_completion_tokens: gen.maxTokens,
          messages: msgs,
        };
        // include_reasoning and reasoning_format can't be mixed: gpt-oss uses the first, Qwen the second.
        if (qwen) body.reasoning_format = "hidden";
        else body.include_reasoning = false;
        if (useMath) {
          body.tools = [MATH_TOOL];
          body.tool_choice = round < MAX_TOOL_ROUNDS ? "auto" : "none";
        }
        const res = await fetch(GROQ_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + apiKey,
          },
          body: JSON.stringify(body),
          signal: controller ? controller.signal : undefined,
        });
        if (!res.ok) {
          if (res.status === 400 && imagesOn) {
            // An image was rejected (format, size or unreachable link): retry once as text only.
            log("image request rejected (400), retrying text-only");
            imagesOn = false;
            return ask(extra);
          }
          const err = new Error("HTTP " + res.status);
          err.status = res.status;
          throw err;
        }
        const data = await res.json();
        try {
          const u = data && data.usage;
          if (u) {
            usage.prompt += u.prompt_tokens || 0;
            usage.completion += u.completion_tokens || 0;
            usage.total += u.total_tokens || ((u.prompt_tokens || 0) + (u.completion_tokens || 0));
          }
          const rt = hdrNum(res, "x-ratelimit-remaining-tokens");
          if (rt != null) usage.remTokens = rt;
          const lt = hdrNum(res, "x-ratelimit-limit-tokens");
          if (lt != null) usage.limTokens = lt;
          const rr = hdrNum(res, "x-ratelimit-remaining-requests");
          if (rr != null) usage.remReq = rr;
          const lr = hdrNum(res, "x-ratelimit-limit-requests");
          if (lr != null) usage.limReq = lr;
          const rs = hdrStr(res, "x-ratelimit-reset-tokens");
          if (rs) usage.resetTokens = rs;
          const rrs = hdrStr(res, "x-ratelimit-reset-requests");
          if (rrs) {
            usage.resetReq = rrs;
            const rms = parseResetMs(rrs);
            usage.resetReqAt = rms != null ? Date.now() + rms : null;
          }
        } catch (e) {}
        const msg = data && data.choices && data.choices[0] && data.choices[0].message;
        const calls = msg && Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        if (useMath && calls.length && round < MAX_TOOL_ROUNDS) {
          msgs.push({ role: "assistant", content: msg.content || "", tool_calls: calls });
          for (let i = 0; i < calls.length; i++) {
            const c = calls[i] || {};
            const fn = c.function || {};
            const result = fn.name === "calculate" ? runMathTool(fn.arguments, mathSteps, mathResults) : "Error: unknown tool";
            msgs.push({ role: "tool", tool_call_id: c.id, content: result });
          }
          continue;
        }
        let out = msg ? String(msg.content || "").trim() : "";
        if (out.length > 1 && out[0] === '"' && out[out.length - 1] === '"') out = out.slice(1, -1).trim();
        if (!out) throw new Error("Empty response");
        // 🪜 The steps must be built on the JS results: if the final text doesn't contain them, ask once to fix it.
        if (mathSteps && mathResults.length && !mathChecked && !answerUsesMath(out, mathResults)) {
          mathChecked = true;
          log("steps don't match the JS result, asking for a fix:", mathResults.join("; "));
          msgs.push({ role: "assistant", content: out });
          msgs.push({ role: "user", content: "Your steps must use the exact JavaScript results: " + mathResults.join("; ") +
            ". Rewrite the short step-by-step so every number comes from these results and the last line is the correct final answer. Output only the message." });
          continue;
        }
        return out;
      }
    };
    try {
      let out = await ask();
      // Answer tag used but the model only repeated the text: ask once more, explicitly.
      if (forceAnswer === true && looksLikeEcho(out, text)) {
        log("forced answer came back as an echo, retrying once");
        try {
          out = await ask([
            { role: "assistant", content: out },
            { role: "user", content: "That only repeated the typed text. Do not rewrite it. Write the actual answer or reply now, using the Discord context and general knowledge, and say what the context shows if it only partly answers. Output only the message." },
          ]);
        } catch (e2) {
          log("echo retry failed", e2 && e2.message);
        }
      }
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

  const STATUS_HINTS = {
    200: "OK · working",
    400: "Bad request · model or params rejected",
    401: "Unauthorized · invalid API key",
    403: "Forbidden · key blocked or no access",
    404: "Not found · model unavailable for this key",
    413: "Request too large",
    429: "Too many requests · rate limit or quota hit (key is valid)",
    498: "Capacity exceeded · try again later",
    500: "Groq server error",
    502: "Bad gateway · Groq is having trouble",
    503: "Groq unavailable · try again later",
  };

  // Validates the key against Groq itself (GET /models), not a chat completion.
  // Confirms the key is accepted by Groq and that the selected rewrite model is available.
  async function testGroqKey(apiKey) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 15000) : null;
    const model = MODELS.includes(storage.model) ? storage.model : DEFAULT_MODEL;
    const modelsUrl = GROQ_URL.replace(/\/chat\/completions$/, "/models");
    const started = Date.now();
    try {
      const res = await fetch(modelsUrl, {
        method: "GET",
        headers: { Authorization: "Bearer " + apiKey },
        signal: controller ? controller.signal : undefined,
      });
      const ms = Date.now() - started;
      if (!res.ok) {
        let detail = "";
        try {
          const d = await res.json();
          if (d && d.error && d.error.message) detail = String(d.error.message).slice(0, 140);
        } catch (e) {}
        const hint = STATUS_HINTS[res.status] || (res.status >= 500 ? "Groq server error" : "Request failed");
        return { ok: false, status: res.status, ms: ms, summary: res.status + " " + hint + (detail ? " — " + detail : "") };
      }
      let names = [];
      try {
        const d = await res.json();
        const list = d && Array.isArray(d.data) ? d.data : [];
        names = list.map((m) => m && m.id).filter(Boolean);
      } catch (e) {}
      const hasModel = names.indexOf(model) !== -1;
      const short = modelLabel(model);
      const summary = hasModel
        ? "OK · Groq key valid (" + names.length + " models, " + short + " available, " + ms + " ms)"
        : "OK · Groq key valid (" + names.length + " models) but " + short + " not listed (" + ms + " ms)";
      return { ok: hasModel, status: res.status, ms: ms, summary: summary };
    } catch (e) {
      const aborted = !!(e && e.name === "AbortError");
      return { ok: false, status: 0, ms: Date.now() - started, summary: aborted ? "Timed out after 15s" : "Network error · " + ((e && e.message) || "unknown") };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function rewriteText(text, replyContext = "", forceAnswer = false) {
    lastUsage = null;
    const keys = getKeys();
    for (let i = 0; i < keys.length; i++) {
      try {
        const out = await callGroq(keys[i], text, replyContext, forceAnswer);
        debugToast("ok", "AI Writer Magic rewrite ok (key #" + (i + 1) + ")");
        return out;
      } catch (e) {
        log("key #" + (i + 1) + " failed:", e && (e.status || e.message));
        if (e && e.refused) { // other keys would decline too; keep the user's own text
          debugToast("warn", "AI Writer Magic declined, kept your text");
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

  const { buildPayloadContext, formatContext, getReplyImages, findReplyRef, getReplyTarget, getReplyMention, clearPending, start: startReplyWatch, stop: stopReplyWatch } = createReplyContext({ metro, log, notify: debugToast });

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
    const { original, finalText, finish, startEditing, onShown, usage } = props;
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
    const btn = (label, bg, onPress, key) => ({ label, bg, onPress, key });
    const renderBtn = (b, first) =>
      h(
        TouchableOpacity,
        {
          key: b.key,
          onPress: b.onPress,
          style: { flex: 1, backgroundColor: b.bg, borderRadius: 10, paddingVertical: 12, alignItems: "center", justifyContent: "center", marginLeft: first ? 0 : 8 },
        },
        h(Text, { numberOfLines: 1, style: { color: "#fff", fontWeight: "700", fontSize: 15 } }, b.label)
      );
    // Two buttons per row: Send | Edit, then Copy prompt | Cancel (Edit is hidden while editing).
    const buttons = [
      btn("Send", C.accent, () => { if (!text.trim()) return; act("send", text)(); }, "send"),
      editing ? null : btn("Edit", C.neutral, () => setEditing(true), "edit"),
      btn("Copy prompt", C.neutral, () => { showToast(copyText(original) ? "Prompt copied to clipboard" : "Couldn't copy to clipboard"); }, "copy"),
      btn("Cancel", C.danger, act("cancel", original), "cancel"),
    ].filter(Boolean);
    const buttonRows = [];
    for (let i = 0; i < buttons.length; i += 2) {
      buttonRows.push(
        h(View, { key: "row" + i, style: { flexDirection: "row", marginTop: 8 } },
          buttons.slice(i, i + 2).map((b, j) => renderBtn(b, j === 0)))
      );
    }

    const usageLines = formatUsage(usage);
    const usageView = usageLines
      ? h(View, { style: { marginTop: 10 } },
          usageLines.map((l, i) => h(Text, { key: "u" + i, style: { color: C.muted, fontSize: 12, marginTop: i ? 2 : 0 } }, l)))
      : null;

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
      usageView,
      ...buttonRows
    );
    return ActionSheetComp ? h(ActionSheetComp, null, body) : body;
  }

  function showPreview(original, finalText, startEditing, usage) {
    if (ActionSheetModule && typeof ActionSheetModule.openLazy === "function") {
      return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        // If the sheet never mounts (slash UI still open), fall back to Alert.
        // The timer is cleared by onShown as soon as the sheet is on screen.
        const timer = setTimeout(() => {
          if (done) return;
          log("action sheet did not open, using alert");
          showAlertPreview(original, finalText, startEditing, usage).then(finish);
        }, 2500);
        try {
          ActionSheetModule.openLazy(
            Promise.resolve({ default: PreviewSheet }),
            "GroqPreview",
            {
              original,
              finalText,
              startEditing,
              usage,
              onShown: () => clearTimeout(timer),
              finish: (v) => { clearTimeout(timer); finish(v); },
            }
          );
        } catch (e) {
          clearTimeout(timer);
          log("action sheet failed, using alert:", e && e.message);
          showAlertPreview(original, finalText, startEditing, usage).then(finish);
        }
      });
    }
    return showAlertPreview(original, finalText, startEditing, usage);
  }

  function showAlertPreview(original, finalText, noEdit, usage) {
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
          finalText + (formatUsage(usage) ? "\n\n" + formatUsage(usage).join("\n") : ""),
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
  async function produceFinalText(original, channelId, textStaysInBox, replyContext = "", forceAnswer = false) {
    const preview = storage.previewBeforeSend !== false;
    const stopTyping = startTypingLoop(channelId);
    let finalText = original;
    let usageInfo = null;
    try {
      finalText = await rewriteText(original, replyContext, forceAnswer);
      usageInfo = lastUsage;
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
      let r = await showPreview(original, finalText, undefined, usageInfo);
      // Alert fallback "Edit": reopen the sheet straight in edit mode
      if (r.action === "edit") r = await showPreview(original, r.text || finalText, true, usageInfo);
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
          if (bypass) return orig(...args);
          const msg = args[1];
          const rawContent = msg && typeof msg.content === "string" ? msg.content : "";
          const ans = parseAnsPrefix(rawContent);
          if (!storage.autoRewrite && !ans.forced) return orig(...args);
          const content = ans.forced ? ans.text : rawContent;

          if (bypassIfCommand(rawContent, args, "sendMessage")) return orig(...args);
          const skipWhy = ans.forced ? null : skipReason(rawContent);
          if (skipWhy) { log("skip auto-rewrite (" + skipWhy + ")"); return orig(...args); }

          if (ans.forced && getKeys().length === 0) {
            showToast("AI Writer Magic: add an API key first. Sent without the AI.");
            const plain = args.slice();
            plain[1] = Object.assign({}, msg, { content: content });
            return orig(...plain);
          }
          if (!content.trim() || getKeys().length === 0 || consumeMark(rawContent)) {
            return orig(...args);
          }

          const channelId = args[0];
          const replyContext = buildPayloadContext(channelId, args, msg && msg.messageReference, ans.forced);
          log("payload context:", replyContext.replace(/\n/g, " | ").slice(0, 180));
          const job = async () => {
            const finalText = await produceFinalText(content, channelId, false, replyContext, ans.forced);
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
        if (bypass) return orig(...args);
        if (inFlight) return;

        const slot = findTextSlot(args);
        const raw = slot ? String(slot.get() || "") : "";
        const ans = parseAnsPrefix(raw);
        if (!storage.autoRewrite && !ans.forced) return orig(...args);
        const original = ans.forced ? ans.text : raw;

        if (bypassIfCommand(raw, args, "handleSendMessage")) return orig(...args);
        const skipWhy = ans.forced ? null : skipReason(raw);
        if (skipWhy) { log("skip auto-rewrite (" + skipWhy + ")"); return orig(...args); }
        if (!shapeReported) { shapeReported = true; log("handleSendMessage args:", describeArgs(args)); }

        if (!slot || !original.trim()) return orig(...args);
        if (getKeys().length === 0) {
          if (ans.forced) { showToast("AI Writer Magic: add an API key first"); return; } // keep the text in the box
          return orig(...args);
        }

        const channelId = findChannelId(args);
        const replyContext = buildPayloadContext(channelId, args, findReplyRef(args), ans.forced);
        log("payload context:", replyContext.replace(/\n/g, " | ").slice(0, 180));
        inFlight = true;

        (async () => {
          const finalText = await produceFinalText(original, channelId, true, replyContext, ans.forced);
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
      name: "ai-writer-magic",
      displayName: "ai-writer-magic",
      description: "Rewrite your message with AI Writer Magic and send it",
      displayDescription: "Rewrite your message with AI Writer Magic and send it",
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
        const rawText = opt && opt.value ? String(opt.value) : "";
        const ans = parseAnsPrefix(rawText);
        const original = ans.forced ? ans.text : rawText;
        const channelId = ctx && ctx.channel ? ctx.channel.id : undefined;
        if (!original.trim()) return;

        // Capture the reply target NOW, before the API call. Slash UI clears the pending reply.
        let replyTarget = null;
        let replyMention = null;
        let replyContext = "";
        try {
          replyTarget = getReplyTarget(channelId);
          replyMention = getReplyMention(channelId);
          replyContext = buildPayloadContext(channelId, [], null, ans.forced);
        } catch (e) {
          log("reply capture failed:", e && e.message);
          try { replyContext = formatContext(null, ans.forced); } catch (e2) {}
        }
        log("payload context (/ai-writer-magic):", replyContext.replace(/\n/g, " | ").slice(0, 180));
        log("slash target:", replyTarget && replyTarget.id);

        try {
          // Let the slash UI close before the preview opens.
          if (RN.Keyboard && typeof RN.Keyboard.dismiss === "function") RN.Keyboard.dismiss();
          await sleep(300);
          const finalText = await produceFinalText(original, channelId, false, replyContext, ans.forced);
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
          log("/ai-writer-magic failed:", e && e.message);
          showToast("AI Writer Magic: " + ((e && e.message) || "failed to send message"));
        }
      },
    });
  }

  // ---- Smoothness helpers ----
  // Looking components up in metro on every render is slow, so resolve them once.
  let uiModsCache = null;
  function getUiMods() {
    if (uiModsCache) return uiModsCache;
    const Table = metro.findByProps("TableRowGroup", "TableSwitchRow", "TableRow") || {};
    const SliderMod = metro.findByProps("Slider");
    const Slider = (SliderMod && typeof SliderMod.Slider === "function") ? SliderMod.Slider
      : (typeof RN.Slider === "function" ? RN.Slider : null);
    const CardMod = metro.findByProps("Card");
    const mods = { Table: Table, Slider: Slider, Card: CardMod && CardMod.Card };
    if (Table.TableRowGroup && Table.TableSwitchRow && Table.TableRow) uiModsCache = mods; // only cache a complete lookup
    return mods;
  }

  // Own component with its own state, so dragging the slider only re-renders this card,
  // not the whole settings page. The value is written to storage once the drag settles.
  const TypingDurationRow = React.memo(function TypingDurationRow(props) {
    const Slider = props.Slider;
    const Card = props.Card;
    const { View, Text, TextInput } = RN;
    const P = getPalette();
    const startRaw = Number(storage.typingDuration != null ? storage.typingDuration : 3);
    const start = Number.isFinite(startRaw) ? startRaw : 3;
    const [duration, setDuration] = React.useState(start);
    const [text, setText] = React.useState(String(start));
    const saveTimer = React.useRef(null);
    const pending = React.useRef(null);

    const commitNow = (n) => {
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      pending.current = null;
      storage.typingDuration = n;
    };
    const saveSoon = (n) => {
      pending.current = n;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => commitNow(n), 300);
    };
    React.useEffect(() => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (pending.current != null) storage.typingDuration = pending.current; // don't lose the last value
    }, []);

    const snap = (v) => Math.round(Number(v) * 2) / 2;
    const content = h(View, { style: { padding: 0, gap: 12 } },
      h(View, { style: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" } },
        h(Text, { variant: "heading-md/semibold", style: { color: P.title, flexShrink: 1 } }, "Typing duration (seconds)"),
        h(View, { style: { width: 80, backgroundColor: P.rowBg, borderRadius: 10, borderWidth: 1, borderColor: P.border, paddingHorizontal: 12, paddingVertical: 6 } },
          h(TextInput, {
            placeholderTextColor: P.placeholder,
            placeholder: "0",
            value: text,
            keyboardType: "numeric",
            style: { color: P.text, fontSize: 14, padding: 0, textAlign: "center" },
            onChangeText: (t) => {
              setText(t);
              if (t === "" || t.endsWith(".")) return;
              const n = parseFloat(t);
              if (Number.isFinite(n) && n >= 0 && n <= 15) { setDuration(n); saveSoon(n); }
            },
          })
        )
      ),
      Slider
        ? h(Slider, {
            value: Math.min(15, Math.max(0, duration)),
            minimumValue: 0,
            maximumValue: 15,
            step: 0.5,
            onValueChange: (v) => { const n = snap(v); setDuration(n); setText(String(n)); saveSoon(n); },
            onSlidingComplete: (v) => { const n = snap(v); setDuration(n); setText(String(n)); commitNow(n); },
          })
        : null
    );
    return Card
      ? h(Card, null, content)
      : h(View, { style: { backgroundColor: P.card, borderRadius: 16, overflow: "hidden", padding: 12 } }, content);
  });

  // Static text block. As its own memo component it is skipped whenever the page re-renders for a toggle.
  const SettingsFooter = React.memo(function SettingsFooter() {
    const { View, Text } = RN;
    const P = getPalette();
    const LINK = "#00a8fc";
    const openUrl = (url) => {
      try {
        const r = RN.Linking && RN.Linking.openURL ? RN.Linking.openURL(url) : null;
        if (r && typeof r.catch === "function") r.catch(() => showToast("Couldn't open " + url));
        else if (!r) showToast("Couldn't open " + url);
      } catch (e) { showToast("Couldn't open " + url); }
    };
    const link = (label, url) =>
      h(Text, { style: { color: LINK, textDecorationLine: "underline" }, onPress: () => openUrl(url), suppressHighlighting: true }, label);
    const noteText = { color: P.muted, fontSize: 13, lineHeight: 19 };
    const noteHead = { color: P.title, fontSize: 14, fontWeight: "700", marginBottom: 6 };
    return h(View, { style: { paddingHorizontal: 6, paddingTop: 8, gap: 16 } },
      h(View, null,
        h(Text, { style: noteHead }, "How to get a Groq API key"),
        h(Text, { style: noteText },
          "1. Open ", link("console.groq.com", "https://console.groq.com"), " and sign up or log in. The free tier doesn't need a credit card.\n" +
          "2. Open the ", link("API Keys page", "https://console.groq.com/keys"), " and tap Create API Key.\n" +
          "3. Give it a name and copy the key. It starts with gsk_ and is shown only once, so copy it right away.\n" +
          "4. Paste it into New API key above, tap Add API key, then Test.\n\n" +
          "You can add several keys. If one is rate limited or fails, the next one is tried. See the ",
          link("rate limits", "https://console.groq.com/docs/rate-limits"), " for the free tier."
        )
      ),
      h(View, null,
        h(Text, { style: noteHead }, "How to get an Exa API key (recommended for web search)"),
        h(Text, { style: noteText },
          "1. Go to ", link("dashboard.exa.ai", "https://dashboard.exa.ai"), " and sign up or log in.\n" +
          "2. Open ", link("API Keys", "https://dashboard.exa.ai/api-keys"), " and create a new key.\n" +
          "3. Copy the key (it starts with exa-).\n" +
          "4. In the Web Search section above, paste it into the Exa API key field.\n\n" +
          "Direct Exa is faster and simpler. New accounts get free credits. See the ",
          link("Exa docs", "https://exa.ai/docs"), " for more."
        )
      ),
      h(View, null,
        h(Text, { style: noteHead }, "How to get a Composio API key (optional fallback)"),
        h(Text, { style: noteText },
          "1. Go to ", link("app.composio.dev", "https://app.composio.dev"), " and sign up or log in.\n" +
          "2. Create or select a project, then go to Settings → API Keys and create a key.\n" +
          "3. Copy the key.\n" +
          "4. Paste it into the Composio API key field in the Web Search section above.\n\n" +
          "This uses Composio's Exa connector (COMPOSIO_SEARCH_WEB). You may need to enable the Exa or Composio Search toolkit in your project. Prefer the direct Exa key when possible."
        )
      ),
      h(View, null,
        h(Text, { style: noteHead }, "Privacy"),
        h(Text, { style: noteText },
          "AI Writer Magic sends your typed text, plus the reply context you enabled (the replied-to message, nearby messages and their usernames), " +
          "to Groq's API using your own key. It doesn't contact any other server, and your keys stay in this plugin's storage on your device.\n\n" +
          "How Groq handles that data is set by Groq, not by this plugin. Its docs describe a standard retention period (up to 30 days at the time of writing) " +
          "unless Zero Data Retention is turned on in Data Controls. Check the pages below for the current terms:\n"
        ),
        h(Text, { style: noteText }, "• ", link("Groq Privacy Policy", "https://groq.com/privacy-policy")),
        h(Text, { style: noteText }, "• ", link("Your Data in GroqCloud (retention)", "https://console.groq.com/docs/your-data")),
        h(Text, { style: noteText }, "• ", link("Data Controls (Zero Data Retention)", "https://console.groq.com/settings/data-controls")),
        h(Text, { style: Object.assign({}, noteText, { marginTop: 8 }) }, "Avoid putting passwords or other private details in messages you send through AI Writer Magic.")
      )
    );
  });

  function GroqSettingsPage() {
    useProxy(storage);
    const { ScrollView, Text, View, TextInput, TouchableOpacity } = RN;
    const ui = getUiMods();
    const Table = ui.Table;
    const TableRowGroup = Table.TableRowGroup;
    const TableSwitchRow = Table.TableSwitchRow;
    const TableRow = Table.TableRow;
    const Stack = Table.Stack;
    const Slider = ui.Slider;
    const Card = ui.Card;
    const native = !!(TableRowGroup && TableSwitchRow && TableRow);

    const [newKey, setNewKey] = React.useState("");
    const [composioKeyInput, setComposioKeyInput] = React.useState(storage.composioApiKey || "");
    const [exaKeyInput, setExaKeyInput] = React.useState(storage.exaApiKey || "");
    const [testState, setTestState] = React.useState({}); // key id -> { busy, ok, text }
    const [testingAll, setTestingAll] = React.useState(false);
    const [customPrompt, setCustomPrompt] = React.useState(
      typeof storage.customPrompt === "string" ? storage.customPrompt : ""
    );
    const customPromptTimer = React.useRef(null);
    const [, forceRender] = React.useReducer((x) => x + 1, 0);
    // Mount only the first groups while the page slides in, the rest right after (keeps the transition at full frame rate).
    const [ready, setReady] = React.useState(false);
    React.useEffect(() => {
      let done = false;
      const go = () => { if (!done) { done = true; setReady(true); } };
      let task = null;
      try {
        task = RN.InteractionManager && RN.InteractionManager.runAfterInteractions ? RN.InteractionManager.runAfterInteractions(go) : null;
      } catch (e) {}
      const t = setTimeout(go, 450);
      return () => { done = true; clearTimeout(t); try { if (task && task.cancel) task.cancel(); } catch (e) {} };
    }, []);
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
    // Tests one key and writes the result into the row. Returns the result (or null for an empty key).
    const testOneKey = async (k) => {
      if (!k || typeof k.key !== "string" || !k.key.trim()) return null;
      setTestState((prev) => Object.assign({}, prev, { [k.id]: { busy: true, ok: false, text: "Testing…" } }));
      const r = await testGroqKey(k.key.trim());
      log("key test #" + k.id + ":", r.status, r.ok ? "ok" : r.summary);
      setTestState((prev) => Object.assign({}, prev, { [k.id]: { busy: false, ok: r.ok, text: (r.ok ? "✅ " : "❌ ") + r.summary } }));
      return r;
    };
    const testSingleKey = async (k) => {
      if (testingAll || (testState[k.id] && testState[k.id].busy)) return;
      const r = await testOneKey(k);
      if (r) showToast((r.ok ? "✅ " : "❌ ") + "Key #" + k.id + ": " + r.summary);
    };
    const runKeyTests = async () => {
      const list = (Array.isArray(storage.apiKeys) ? storage.apiKeys : []).filter((x) => x && typeof x.key === "string" && x.key.trim());
      if (!list.length) return showToast("Add an API key first");
      if (testingAll) return;
      setTestingAll(true);
      const busy = {};
      list.forEach((k) => { busy[k.id] = { busy: true, ok: false, text: "Testing…" }; });
      setTestState(busy);
      let good = 0;
      for (let i = 0; i < list.length; i++) {
        const k = list[i];
        const r = await testOneKey(k);
        if (!r) continue;
        if (r.ok) good++;
        if (list.length === 1) showToast((r.ok ? "✅ " : "❌ ") + "Key #" + k.id + ": " + r.summary);
      }
      if (list.length > 1) showToast((good === list.length ? "✅ " : "⚠️ ") + good + "/" + list.length + " keys working");
      setTestingAll(false);
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
          "Every message you send, in any channel, will be rewritten by AI Writer Magic before it is posted, not only messages sent with /ai-writer-magic. " +
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

    const durationRow = h(TypingDurationRow, { Slider: Slider, Card: Card });

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
    const chipColors0 = () => ({ accent: "#5865f2", input: isLightTheme() ? "#e3e5e8" : "#2b2d31", muted: P.muted });
    const ctxWindowOn = storage.ctxWindow !== false;
    const ctxPanel = ctxWindowOn
      ? h(View, { style: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6, backgroundColor: ROW_BG } },
          h(View, { style: { marginBottom: 6 } },
            h(Text, { style: { color: P.muted, fontSize: 12, fontWeight: "700", textTransform: "uppercase", marginBottom: 8 } }, "Messages before the target"),
            Chips(CTX_BEFORE_OPTIONS, ctxSize("ctxBefore", CTX_BEFORE_DEF), (n) => { storage.ctxBefore = n; }, chipColors0(), null)
          ),
          h(View, { style: { marginBottom: 6 } },
            h(Text, { style: { color: P.muted, fontSize: 12, fontWeight: "700", textTransform: "uppercase", marginBottom: 8 } }, "Messages after the target"),
            Chips(CTX_AFTER_OPTIONS, ctxSize("ctxAfter", CTX_AFTER_DEF), (n) => { storage.ctxAfter = n; }, chipColors0(), null)
          )
        )
      : null;
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

    const footer = h(SettingsFooter, { light: isLightTheme() });

    const body = [
      group("General ⚙️", [
        sw("Auto-rewrite all messages", storage.autoRewrite, onAutoRewriteToggle, "No /ai-writer-magic needed"),
        sw("Auto-answer questions", storage.answerQuestions !== false, (v) => { storage.answerQuestions = v; }, "Math, translations, and other answers. Start a message with !~{ans} or [Answer] to force it for that message"),
        sw("Auto Math Explainer", storage.mathTool !== false, (v) => { storage.mathTool = v; },
          "Numbers are calculated exactly with JavaScript (percentages, roots, powers, trig, big numbers) and the AI writes short steps built from those results, re-checked against them"),
        sw("Preview before sending", storage.previewBeforeSend !== false, (v) => { storage.previewBeforeSend = v; }, "Send / Edit / Copy prompt / Cancel"),
      ]), 
      group("Skip auto-rewrite for 🚫", [
        sw("Pings", storage.skipMentions !== false, (v) => { storage.skipMentions = v; }, "@user, @role, @everyone, @here"),
        sw("Links", storage.skipLinks !== false, (v) => { storage.skipLinks = v; }, "http(s) links, www., Discord invites"),
        sw("Bot commands", storage.skipBotCommands !== false, (v) => { storage.skipBotCommands = v; }, "Prefix commands like !help, .play, $work"),
      ]),
      group("Timing ⏱️", [durationRow]),
      group("AI Model 🧠", MODELS.map((m) => pick(modelLabel(m), m === model, () => { storage.model = m; }))),
      group("AI Personality 🎨", [
        ...PERSONALITY_OPTIONS.map((opt) => pick(opt, opt === personality, () => { storage.personality = opt; })),
        customField,
      ]),
      group("Reply Context 💬", [
        sw("Messages around reply target", ctxWindowOn, (v) => { storage.ctxWindow = v; },
          "Look up channel messages around the replied-to message ID and send them to the AI"),
        ctxWindowOn
          ? sw("Include other people", storage.ctxIncludeOthers !== false, (v) => { storage.ctxIncludeOthers = v; },
              storage.ctxIncludeOthers !== false ? "Messages from everyone nearby, not just the reply target" : "Only the reply target's messages")
          : null,
        ctxPanel,
        sw("Read images in replied messages", storage.readImages !== false, (v) => { storage.readImages = v; },
          "Replies to a message with images (attachments, embeds, image links) are read by Qwen 3.8 27B vision. Up to 3 images, about 2,048 tokens each"),
      ]),
      group("Advanced 🛠️", [
        sw("Advanced settings", advancedOn, onAdvancedToggle,
          advancedOn ? "Custom values are in use" : "Unlock temperature, max tokens, and more"),
        advancedPanel,
      ]),
      group("Debug 🐞", [
        sw("Debug toasts", storage.debugToasts === true, (v) => { storage.debugToasts = v; }, "Show success / error toasts for reply context and AI calls"),
        sw("Save log to file", storage.logToFile === true, (v) => { storage.logToFile = v; if (v) scheduleLogFlush(); }, "Auto-write the in-memory log to " + LOG_FILE),
        h(View, { style: { flexDirection: "row", paddingHorizontal: 16, paddingVertical: 12, backgroundColor: ROW_BG } },
          h(View, { style: { flex: 1, marginRight: 8 } }, button("Write log", GREEN, uiWriteLog, true)),
          h(View, { style: { flex: 1, marginRight: 8 } }, button("Share log", "#4e5058", uiShareLog, true)),
          h(View, { style: { flex: 1 } }, button("Clear log", RED, uiClearLog, true))
        ),
      ]),
      group("Groq API Keys 🔑", [
        keys.length === 0 ? h(TableRow, { label: "No API keys yet" }) : null,
        ...keys.map((k) => {
          const busy = !!(testState[k.id] && testState[k.id].busy);
          return h(TableRow, {
            key: "key-" + k.id,
            label: "#" + k.id + "  " + mask(k.key),
            subLabel: testState[k.id] ? testState[k.id].text : undefined,
            trailing: h(View, { style: { flexDirection: "row", alignItems: "center" } },
              h(View, { style: { marginRight: 8, opacity: busy || testingAll ? 0.6 : 1 } },
                button(busy ? "Testing…" : "Test", "#5865f2", () => testSingleKey(k), true)),
              button("Delete", RED, () => confirmRemoveKey(k), true)
            ),
          });
        }),
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
        keys.length > 0
          ? h(View, { style: { paddingHorizontal: 16, paddingBottom: 16, backgroundColor: ROW_BG } },
              button(testingAll ? "Testing…" : "Test API keys", "#5865f2", runKeyTests, false)
            )
          : null,
      ]),
      group("Web Search 🔍", (() => {
        const searchOn = storage.searchEnabled === true;
        const rows = [
          sw("Enable web search for answers", searchOn, (v) => { storage.searchEnabled = v; forceRender(); },
            "When answering questions, search the web first via Exa or Composio Exa to ground replies"),
        ];
        // 🌸 Exa + Composio only appear while web search is enabled.
        if (searchOn) {
          rows.push(
            h(View, { key: "exa", style: { paddingHorizontal: 16, paddingVertical: 12, backgroundColor: ROW_BG } },
              inputField("Exa API key (direct, preferred)", {
                value: exaKeyInput,
                placeholder: "exa-...",
                autoCapitalize: "none",
                autoCorrect: false,
                secureTextEntry: true,
                onChangeText: (t) => { setExaKeyInput(t); storage.exaApiKey = t.trim(); },
              })
            ),
            h(View, { key: "composio", style: { paddingHorizontal: 16, paddingVertical: 12, backgroundColor: ROW_BG } },
              inputField("Composio API key (fallback connector)", {
                value: composioKeyInput,
                placeholder: "composio key...",
                autoCapitalize: "none",
                autoCorrect: false,
                secureTextEntry: true,
                onChangeText: (t) => { setComposioKeyInput(t); storage.composioApiKey = t.trim(); },
              })
            ),
            h(Text, { key: "exa-note", style: { color: P.muted, fontSize: 12, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: ROW_BG } },
              "Direct Exa is used if its key is set. Otherwise the Composio Exa connector (COMPOSIO_SEARCH_WEB) is used. Get an Exa key at dashboard.exa.ai or a Composio key at app.composio.dev."
            )
          );
        }
        return rows;
      })()),
      footer,
    ];

    const shown = ready ? body : body.slice(0, 2);
    const content = Stack
      ? h(Stack, { spacing: 12 }, shown)
      : h(View, { style: { gap: 12 } }, shown);

    return h(ScrollView, { style: { flex: 1 }, contentContainerStyle: { padding: 12, paddingBottom: 48 } }, content);
  }

  const GROQ_KEY = "GROQ_AI_CONTROL";

  function openGroqPage() {
    const payload = { title: "AI Writer Magic", render: GroqSettingsPage };
    try {
      const navMod = metro.findByProps("getRootNavigationRef");
      const ref = navMod && navMod.getRootNavigationRef && navMod.getRootNavigationRef();
      if (ref && typeof ref.navigate === "function") {
        ref.navigate("VendettaCustomPage", payload);
        return;
      }
    } catch (e) {}
    try {
      if (Navigation && typeof Navigation.push === "function") {
        Navigation.push("VendettaCustomPage", payload);
        return;
      }
    } catch (e) {}
    showToast("AI Writer Magic: unable to open settings page");
  }

  function patchSettingsScreen() {
    const settingConstants = metro.findByProps("SETTING_RENDERER_CONFIG");
    const createListModule = metro.findByProps("createList");
    const SettingsOverviewScreen = metro.find((m) => m && m.default && m.default.name === "SettingsOverviewScreen");
    const Table = metro.findByProps("TableRowIcon") || {};
    const TableRowIcon = Table.TableRowIcon;

    // Icons8 magic wand — transparent monochrome PNG. Color follows Discord theme.
    // Falls back to Discord's native ic_wand (asset 3086) if Icons8 fails to load.
    const ICON_ID = "xKAfx2KN4Ea6";
    const WAND_ASSET = 3086;
    let icons8Failed = false;
    function iconUri() {
      const hex = isLightTheme() ? "060607" : "F2F3F5";
      return "https://img.icons8.com/?size=128&id=" + ICON_ID + "&format=png&color=" + hex;
    }
    function nativeWand() {
      try {
        const getAsset = (metro.findByProps("getAssetIDByName") || {}).getAssetIDByName;
        if (typeof getAsset === "function") {
          const id = getAsset("ic_wand") || getAsset("WandIcon");
          if (id != null) return id;
        }
      } catch (e) {}
      return WAND_ASSET;
    }
    function currentSource() {
      return icons8Failed ? nativeWand() : { uri: iconUri() };
    }
    function onIconError() {
      if (icons8Failed) return;
      icons8Failed = true;
      log("icons8 failed, using ic_wand", nativeWand());
    }
    function IconWithFallback() {
      const src = currentSource();
      if (TableRowIcon) {
        return h(TableRowIcon, { source: src, onError: onIconError });
      }
      return h(RN.Image, {
        source: src,
        style: { width: 24, height: 24 },
        onError: onIconError,
      });
    }

    if (!settingConstants) {
      log("SETTING_RENDERER_CONFIG not found");
      return;
    }

    const row = {};
    row[GROQ_KEY] = {
      type: "pressable",
      title: function () { return "AI Writer Magic"; },
      useTitle: function () { return "AI Writer Magic"; },
      icon: { uri: iconUri() },
      IconComponent: IconWithFallback,
      usePredicate: function () { return true; },
      onPress: openGroqPage,
      withArrow: true,
    };

    let rendererConfigValue = settingConstants.SETTING_RENDERER_CONFIG;
    try {
      Object.defineProperty(settingConstants, "SETTING_RENDERER_CONFIG", {
        enumerable: true,
        configurable: true,
        get: function () { return Object.assign({}, rendererConfigValue, row); },
        set: function (v) { rendererConfigValue = v; },
      });
      log("overrode SETTING_RENDERER_CONFIG");
    } catch (e) {
      log("config override failed", e && e.message);
      if (rendererConfigValue && !rendererConfigValue[GROQ_KEY]) {
        rendererConfigValue[GROQ_KEY] = row[GROQ_KEY];
      }
    }

    const firstRender = Symbol("GroqAI-pinToSettings");

    function pinSection(sections) {
      if (!Array.isArray(sections)) return;
      const section = sections.find((x) => x && ["Bunny", "Kettu", "Revenge"].indexOf(x.label) !== -1);
      if (!section) {
        const isMain = sections.some((x) => x && Array.isArray(x.settings) && x.settings.indexOf("ACCOUNT") !== -1);
        if (isMain) {
          sections.unshift({ label: "AI Writer Magic", title: "AI Writer Magic", settings: [GROQ_KEY] });
          log("added AI Writer Magic section");
        }
        return;
      }
      if (!Array.isArray(section.settings)) return;
      if (section.settings.indexOf(GROQ_KEY) !== -1) return;
      section.settings.push(GROQ_KEY);
      log("pinned to", section.label);
    }

    if (createListModule && typeof createListModule.createList === "function") {
      unpatches.push(after("createList", createListModule, function (args) {
        try {
          if (!args || !args[0] || args[0][firstRender]) return;
          args[0][firstRender] = true;
          pinSection(args[0].sections);
        } catch (e) { log("createList pin failed", e && e.message); }
      }));
    } else if (SettingsOverviewScreen) {
      unpatches.push(after("default", SettingsOverviewScreen, function (args, ret) {
        try {
          if (!args || !args[0] || args[0][firstRender]) return;
          args[0][firstRender] = true;
          function find(node, depth) {
            if (!node || typeof node !== "object" || depth > 8) return null;
            if (node.props && Array.isArray(node.props.sections)) return node.props;
            if (Array.isArray(node)) {
              for (let i = 0; i < node.length; i++) {
                const hit = find(node[i], depth + 1);
                if (hit) return hit;
              }
              return null;
            }
            if (node.props && node.props.children) return find(node.props.children, depth + 1);
            return null;
          }
          const hit = find(ret, 0);
          if (hit) pinSection(hit.sections);
        } catch (e) { log("overview pin failed", e && e.message); }
        return ret;
      }));
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
    if (typeof storage.ctxWindow !== "boolean") storage.ctxWindow = true;
    if (typeof storage.ctxIncludeOthers !== "boolean") storage.ctxIncludeOthers = true;
    if (!Number.isFinite(parseInt(storage.ctxBefore, 10))) storage.ctxBefore = CTX_BEFORE_DEF;
    if (!Number.isFinite(parseInt(storage.ctxAfter, 10))) storage.ctxAfter = CTX_AFTER_DEF;
    Object.keys(ADV_SPEC).forEach((k) => {
      if (!Number.isFinite(parseFloat(storage[ADV_SPEC[k].key]))) storage[ADV_SPEC[k].key] = ADV_SPEC[k].def;
    });
    if (typeof storage.searchEnabled !== "boolean") storage.searchEnabled = false;
    if (typeof storage.composioApiKey !== "string") storage.composioApiKey = "";
    if (typeof storage.exaApiKey !== "string") storage.exaApiKey = "";

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
