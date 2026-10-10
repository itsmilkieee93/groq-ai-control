(function () {
  "use strict";

  function createReplyContext({ metro, log }) {
    const MessageStore =
      metro.findByProps("getMessage", "getMessages") ||
      (metro.findByStoreName ? metro.findByStoreName("MessageStore") : null) ||
      null;
    const UserStore =
      (metro.findByStoreName ? metro.findByStoreName("UserStore") : null) ||
      metro.findByProps("getCurrentUser") ||
      null;

    const pendingByChannel = new Map();
    let PendingReplyStore = null;
    let fluxUnsub = null;

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
        // Keep the cached message until send reads it. Discord clears the
        // pending reply as the send starts, which is before our hook runs.
        return;
      }
      const message = action.message || action.referencedMessage || action.referenced_message;
      rememberPending(channelId, message);
      if (message) log("cached swipe reply", channelId, textOfMessage(message).slice(0, 80));
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

    function resolveReplyInfo(channelId, args, explicitRef) {
      const fromArgs = extractReplyMessage(args);
      const fromStore = messageFromStore(channelId, explicitRef || findReplyRef(args));
      const fromPending = getPendingReplyMessage(channelId);
      const fromCache = cachedPending(channelId);
      const msg = fromArgs || fromPending || fromStore || fromCache;
      if (!msg) {
        log("no reply target", channelId, explicitRef && (explicitRef.message_id || explicitRef.messageId));
        return null;
      }
      const source = fromArgs ? "args" : fromPending ? "pending" : fromStore ? "store" : "cache";
      log("reply target from", source);
      const who = authorOf(msg);
      const snaps = snapshotMessages(msg);
      const forwardAuthor = snaps.length ? authorOf(snaps[0]) : { id: "", username: "", globalName: "" };
      return {
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
      if (reply && (reply.text || reply.id || reply.username || reply.globalName || reply.isBot || reply.isForward)) {
        lines.push(reply.isForward
          ? "The speaker is replying to this forwarded Discord message:"
          : reply.isBot
            ? "The speaker is replying to this Discord bot message:"
            : "The speaker is replying to this Discord message:");
        lines.push("- reply_discord_user_id: " + (reply.id || "unknown"));
        lines.push("- reply_discord_username: " + (reply.username || "unknown"));
        lines.push("- reply_discord_global_name: " + (reply.globalName || "unknown"));
        if (reply.isBot) lines.push("- reply_is_bot: true");
        if (reply.isForward) lines.push("- reply_is_forward: true");
        if (reply.text) lines.push("- reply_message: \"" + reply.text.replace(/"/g, "'") + "\"");
      }
      lines.push("These are Discord user IDs, usernames, and global names. Use them only as context. Output only the final chat message.");
      return lines.join("\n");
    }

    function buildPayloadContext(channelId, args, explicitRef) {
      return formatContext(resolveReplyInfo(channelId, args, explicitRef));
    }

    return { buildPayloadContext, formatContext, findReplyRef, start, stop };
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
  const log = (...a) => { try { console.log("[GroqAI]", ...a); } catch (e) {} };

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

  async function callGroq(apiKey, text, replyContext = "") {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 20000) : null;
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
          temperature: 0.7,
          reasoning_effort: storage.answerQuestions !== false ? "medium" : "low",
          include_reasoning: false,
          max_completion_tokens: 2048,
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
        return await callGroq(keys[i], text, replyContext);
      } catch (e) {
        log("key #" + (i + 1) + " failed:", e && (e.status || e.message));
        if (e && e.refused) return text; // other keys would decline too; keep the user's own text
      }
    }
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

  const { buildPayloadContext, formatContext, findReplyRef, start: startReplyWatch, stop: stopReplyWatch } = createReplyContext({ metro, log });

  function PreviewSheet(props) {
    const { View, Text, TextInput, TouchableOpacity, ScrollView } = RN;
    const { original, finalText, finish, startEditing } = props;
    const C = { text: "#f2f3f5", muted: "#b5bac1", card: "#2b2d31", accent: "#5865f2", danger: "#da373c", neutral: "#4e5058" };

    React.useEffect(() => () => finish({ action: "cancel", text: original }), []);

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
        try {
          ActionSheetModule.openLazy(
            Promise.resolve({ default: PreviewSheet }),
            "GroqPreview",
            { original, finalText, finish, startEditing }
          );
        } catch (e) {
          log("action sheet failed, using alert:", e && e.message);
          showAlertPreview(original, finalText, startEditing).then(resolve);
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


  function patchSendMessage() {
    if (!MessageModules || typeof MessageModules.sendMessage !== "function") {
      log("MessageModules.sendMessage not found");
      return false;
    }
    unpatches.push(
      instead("sendMessage", MessageModules, function (args, orig) {
        try {
          if (bypass || !storage.autoRewrite) return orig(...args);
          const msg = args[1];
          const content = msg && typeof msg.content === "string" ? msg.content : "";

          if (bypassIfCommand(content, args, "sendMessage")) return orig(...args);

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

        const finalText = await produceFinalText(original, channelId, false, formatContext(null));
        if (finalText === null) return;

        try {
          MessageModules.sendMessage(channelId, {
            content: finalText,
            tts: false,
            invalidEmojis: [],
            validNonShortcutEmojis: [],
          });
        } catch (e) {
          showToast("Groq: failed to send message");
        }
        // nothing returned -> Discord won't send a second copy
      },
    });
  }

  function GroqSettingsPage() {
    useProxy(storage);
    const { View, Text, TextInput, Switch, TouchableOpacity, ScrollView } = RN;
    const [newKey, setNewKey] = React.useState("");
    const [duration, setDuration] = React.useState(String(storage.typingDuration != null ? storage.typingDuration : 3));

    const C = {
      bg: "#1e1f22",
      card: "#2b2d31",
      input: "#111214",
      text: "#f2f3f5",
      muted: "#b5bac1",
      accent: "#5865f2",
      danger: "#da373c",
    };

    const card = { backgroundColor: C.card, borderRadius: 12, padding: 14, marginBottom: 14 };
    const title = { color: C.muted, fontSize: 12, fontWeight: "700", marginBottom: 8, textTransform: "uppercase" };
    const input = {
      backgroundColor: C.input,
      color: C.text,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 14,
    };
    const btn = (bg) => ({
      backgroundColor: bg,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 10,
      alignItems: "center",
      justifyContent: "center",
    });

    const addKey = () => {
      const k = newKey.trim();
      if (!k.startsWith("gsk_")) return showToast("API key must start with gsk_");
      const list = Array.isArray(storage.apiKeys) ? storage.apiKeys : [];
      if (list.some((x) => x && x.key === k)) return showToast("Key already added");
      const nextId = list.reduce((m, x) => Math.max(m, (x && x.id) || 0), 0) + 1;
      storage.apiKeys = list.concat([{ id: nextId, key: k }]);
      setNewKey("");
    };

    const removeKey = (id) => {
      storage.apiKeys = (storage.apiKeys || []).filter((x) => x && x.id !== id);
    };

    const mask = (k) => (k.length > 12 ? k.slice(0, 8) + "…" + k.slice(-4) : k);
    const keys = Array.isArray(storage.apiKeys) ? storage.apiKeys : [];

    return h(
      ScrollView,
      { style: { flex: 1, backgroundColor: C.bg }, contentContainerStyle: { padding: 16, paddingBottom: 48 } },

      // Auto rewrite toggle
      h(
        View,
        { style: Object.assign({}, card, { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }) },
        h(Text, { style: { color: C.text, fontSize: 15, flex: 1, paddingRight: 12 } }, "Auto-rewrite all messages (no /groq needed)"),
        h(Switch, {
          value: !!storage.autoRewrite,
          onValueChange: (v) => { storage.autoRewrite = v; },
          trackColor: { false: "#4e5058", true: C.accent },
        })
      ),

      // Answer questions toggle
      h(
        View,
        { style: Object.assign({}, card, { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }) },
        h(Text, { style: { color: C.text, fontSize: 15, flex: 1, paddingRight: 12 } }, "Auto-answer questions (math, translations, etc.)"),
        h(Switch, {
          value: storage.answerQuestions !== false,
          onValueChange: (v) => { storage.answerQuestions = v; },
          trackColor: { false: "#4e5058", true: C.accent },
        })
      ),

      // Preview before send toggle
      h(
        View,
        { style: Object.assign({}, card, { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }) },
        h(Text, { style: { color: C.text, fontSize: 15, flex: 1, paddingRight: 12 } }, "Preview before sending (Send / Edit / Copy prompt / Cancel)"),
        h(Switch, {
          value: storage.previewBeforeSend !== false,
          onValueChange: (v) => { storage.previewBeforeSend = v; },
          trackColor: { false: "#4e5058", true: C.accent },
        })
      ),

      // Typing duration
      h(
        View,
        { style: card },
        h(Text, { style: title }, "Typing Duration (seconds)"),
        h(TextInput, {
          style: input,
          value: duration,
          keyboardType: "numeric",
          placeholder: "3",
          placeholderTextColor: C.muted,
          onChangeText: (t) => {
            const clean = t.replace(/[^0-9.]/g, "");
            setDuration(clean);
            const n = parseFloat(clean);
            storage.typingDuration = Number.isFinite(n) && n >= 0 ? n : 0;
          },
        })
      ),

      // AI model
      h(
        View,
        { style: card },
        h(Text, { style: title }, "AI Model"),
        Chips(
          MODELS,
          MODELS.includes(storage.model) ? storage.model : DEFAULT_MODEL,
          (v) => { storage.model = v; },
          C,
          (m) => m.replace("openai/", "")
        )
      ),

      // Personality
      h(
        View,
        { style: card },
        h(Text, { style: title }, "AI Personality"),
        Chips(
          PERSONALITY_OPTIONS,
          PERSONALITY_OPTIONS.includes(storage.personality) ? storage.personality : "Casual/Slang",
          (v) => { storage.personality = v; },
          C
        ),
        storage.personality === "Custom"
          ? h(TextInput, {
              style: Object.assign({}, input, { minHeight: 110, textAlignVertical: "top", marginTop: 4 }),
              value: storage.customPrompt || "",
              multiline: true,
              placeholder: "Custom prompt guidelines...",
              placeholderTextColor: C.muted,
              onChangeText: (t) => { storage.customPrompt = t; },
            })
          : null
      ),

      // API keys
      h(
        View,
        { style: card },
        h(Text, { style: title }, "Groq API Keys (" + keys.length + ")"),
        keys.length === 0
          ? h(Text, { style: { color: C.muted, marginBottom: 10 } }, "No API keys yet.")
          : keys.map((k) =>
              h(
                View,
                {
                  key: "key-" + k.id,
                  style: { flexDirection: "row", alignItems: "center", marginBottom: 8 },
                },
                h(Text, { style: { color: C.text, flex: 1, fontFamily: "monospace" } }, "#" + k.id + "  " + mask(k.key)),
                h(
                  TouchableOpacity,
                  { style: btn(C.danger), onPress: () => removeKey(k.id) },
                  h(Text, { style: { color: "#fff", fontWeight: "600" } }, "Delete")
                )
              )
            ),
        h(
          View,
          { style: { flexDirection: "row", alignItems: "center", marginTop: 6 } },
          h(TextInput, {
            style: Object.assign({}, input, { flex: 1, marginRight: 8 }),
            value: newKey,
            placeholder: "gsk_...",
            placeholderTextColor: C.muted,
            autoCapitalize: "none",
            autoCorrect: false,
            onChangeText: setNewKey,
          }),
          h(
            TouchableOpacity,
            { style: btn(C.accent), onPress: addKey },
            h(Text, { style: { color: "#fff", fontWeight: "600" } }, "Add")
          )
        )
      )
    );
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
