(function () {
  "use strict";

  const { storage } = vendetta.plugin;
  const { after } = vendetta.patcher;
  const metro = vendetta.metro;
  const { React, ReactNative: RN } = metro.common;
  const h = React.createElement;
  const { showToast } = vendetta.ui.toasts;
  const { useProxy } = vendetta.storage;

  const unpatches = [];
  const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
  const DEFAULT_MODEL = "openai/gpt-oss-120b";

  // ---------- Storage helpers ----------
  function getContacts() {
    if (!Array.isArray(storage.contacts)) storage.contacts = [];
    return storage.contacts;
  }
  function saveContact(contact) {
    const list = getContacts();
    const idx = list.findIndex((c) => c.id === contact.id);
    if (idx >= 0) list[idx] = contact;
    else list.push(contact);
    storage.contacts = list.slice();
  }
  function getMessages(contactId) {
    if (!storage.messages) storage.messages = {};
    if (!Array.isArray(storage.messages[contactId])) storage.messages[contactId] = [];
    return storage.messages[contactId];
  }
  function addMessage(contactId, msg) {
    const msgs = getMessages(contactId);
    msgs.push(msg);
    storage.messages = { ...storage.messages };
  }

  function getKeys() {
    const list = Array.isArray(storage.apiKeys) ? storage.apiKeys : [];
    return list.map((k) => (k && typeof k.key === "string" ? k.key.trim() : "")).filter(Boolean);
  }

  // ---------- Logging & export ----------
  const logBuffer = [];

  function fmtArg(a) {
    if (a instanceof Error) return a.message;
    if (typeof a === "string") return a;
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  }
  function log(...args) {
    const line = "[" + new Date().toISOString() + "] " + args.map(fmtArg).join(" ");
    logBuffer.push(line);
    if (logBuffer.length > 500) logBuffer.shift();
    try { console.log("[FakeDM]", ...args); } catch (e) {}
  }

  function buildLogText() {
    const contacts = Array.isArray(storage.contacts) ? storage.contacts.length : 0;
    const msgCount = Object.values(storage.messages || {}).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0);
    return [
      "Simulate DM logs",
      "Exported: " + new Date().toISOString(),
      "Model: " + (storage.model || DEFAULT_MODEL),
      "API keys: " + getKeys().length + " (not included)",
      "Contacts: " + contacts + " | Messages: " + msgCount,
      "Entries: " + logBuffer.length,
      "-----",
      ...(logBuffer.length ? logBuffer : ["(no log entries)"]),
    ].join("\n");
  }

  function copyToClipboard(text) {
    const cands = [metro.findByProps?.("setString", "getString"), metro.common?.clipboard, RN.Clipboard];
    for (const c of cands) {
      try { if (c && typeof c.setString === "function") { c.setString(text); return true; } } catch (e) {}
    }
    return false;
  }

  // Export location (same approach as AI Writer Magic):
  //   /storage/emulated/0/Android/data/<package>/files/FakeDMExports/
  // "documents" + a RELATIVE path is resolved by the file manager itself; the external package
  // folder is reached with a "../" climb from the real documents dir, and every write is verified.
  const APP_EXPORT_SUBDIR = "FakeDMExports";

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

  function getFileManagerConstants() {
    try {
      const fm = getFileManager();
      return fm && typeof fm.getConstants === "function" ? fm.getConstants() || {} : {};
    } catch (e) { return {}; }
  }

  function cleanPath(p) {
    return String(p || "").replace(/^file:\/\//, "").replace(/\/+$/, "");
  }

  function packageFromPath(p) {
    const s = cleanPath(p);
    let m = s.match(/\/Android\/data\/([^/]+)/);
    if (m) return m[1];
    m = s.match(/\/data\/(?:user\/\d+|data)\/([^/]+)/);
    return m ? m[1] : "";
  }

  function exportStamp() {
    const d = new Date();
    const p2 = (n) => (n < 10 ? "0" : "") + n;
    return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + "_" + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
  }

  // Reads the file back to prove it exists with the right content: "ok" | "mismatch" | "missing" | "unverified"
  async function verifyFile(fm, absPath, expected) {
    let exists;
    try { if (typeof fm.fileExists === "function") exists = await fm.fileExists(absPath); } catch (e) { exists = undefined; }
    if (exists === false) return "missing";
    try {
      if (typeof fm.readFile === "function") {
        const back = await fm.readFile(absPath, "utf8");
        if (typeof back === "string") return back === expected ? "ok" : "mismatch";
      }
    } catch (e) {
      return exists === true ? "ok" : "missing";
    }
    return exists === true ? "ok" : "unverified";
  }

  // Returns { path, external, verified } or throws if nothing could be verified.
  async function writeAppFile(text, name) {
    const fm = getFileManager();
    if (!fm) throw new Error("file manager not available");
    const rel = APP_EXPORT_SUBDIR + "/" + name;
    const docsDir = cleanPath(getFileManagerConstants().DocumentsDirPath);
    const pkg = packageFromPath(docsDir);
    const isExtPath = (p) => String(p).indexOf("/Android/data/") !== -1;
    const problems = [];

    // 1) documents + relative path
    let docsPath = "";
    let docsState = "unverified";
    try {
      await fm.writeFile("documents", rel, text, "utf8");
      docsPath = docsDir ? docsDir + "/" + rel : "";
      if (docsPath) docsState = await verifyFile(fm, docsPath, text);
      log("export: documents write", docsPath || "(path unknown)", docsState);
      if (docsState === "ok" && isExtPath(docsPath)) return { path: docsPath, external: true, verified: true };
      if (docsState === "missing" || docsState === "mismatch") problems.push("documents: " + docsState);
    } catch (e) {
      problems.push("documents write failed: " + ((e && e.message) || e));
      log("export: documents write failed", e);
    }

    // 2) documents dir is internal -> try the external package folder via a relative "../" climb
    if (docsDir && pkg && !isExtPath(docsDir)) {
      const extDir = "/storage/emulated/0/Android/data/" + pkg + "/files";
      const depth = docsDir.split("/").filter(Boolean).length;
      let up = "";
      for (let i = 0; i < depth; i++) up += "../";
      const climbRel = up + extDir.replace(/^\//, "") + "/" + rel;
      const extPath = extDir + "/" + rel;
      try {
        await fm.writeFile("documents", climbRel, text, "utf8");
        const st = await verifyFile(fm, extPath, text);
        log("export: external write", extPath, st);
        if (st === "ok") return { path: extPath, external: true, verified: true };
        problems.push("external: " + st);
      } catch (e) {
        problems.push("external write failed: " + ((e && e.message) || e));
        log("export: external write failed", e);
      }
    }

    // 3) fall back to the internal file, never pretending it is external
    if (docsPath && docsState === "ok") return { path: docsPath, external: false, verified: true };
    if (docsPath && docsState === "unverified") return { path: docsPath, external: false, verified: false };
    throw new Error("file was not found after writing (" + (problems.join("; ") || "unknown") + ")");
  }

  function exportToastText(r) {
    if (r.external && r.verified) return "Logs exported & verified: " + r.path;
    if (r.verified) return "Logs saved in app-private storage (not visible in file managers): " + r.path;
    return "Logs written but could not be verified: " + r.path;
  }

  async function exportLogs() {
    const text = buildLogText();
    try {
      const r = await writeAppFile(text, "fakedm-log-" + exportStamp() + ".txt");
      log("Logs exported to", r.path);
      showToast(exportToastText(r));
    } catch (e) {
      log("Export failed:", e);
      showToast(
        copyToClipboard(text)
          ? "Storage access denied! Backup text automatically copied to clipboard."
          : "Export failed: " + ((e && e.message) || "unknown")
      );
    }
  }

  async function shareLogs() {
    const text = logBuffer.slice(-300).join("\n") || "(log is empty)";
    try {
      if (RN.Share && typeof RN.Share.share === "function") {
        await RN.Share.share({ message: text, title: "Simulate DM log" });
        return;
      }
    } catch (e) {}
    showToast(copyToClipboard(text) ? "Log copied to clipboard" : "Couldn't share or copy log");
  }

  // ---------- Discord user helpers ----------
  const DEFAULT_AVATAR = "https://cdn.discordapp.com/embed/avatars/0.png";
  const loggedOnce = {};
  function logOnce(key, ...args) {
    if (loggedOnce[key]) return;
    loggedOnce[key] = true;
    log(...args);
  }

  function getUserStore() {
    try { return metro.findByStoreName?.("UserStore") || null; } catch (e) { return null; }
  }
  function getCurrentUser() {
    try { return getUserStore()?.getCurrentUser?.() || null; } catch (e) { return null; }
  }
  function avatarUrlFor(user) {
    if (user && user.id && user.avatar) return "https://cdn.discordapp.com/avatars/" + user.id + "/" + user.avatar + ".png?size=128";
    return DEFAULT_AVATAR;
  }
  function displayNameOf(user) {
    return (user && (user.globalName || user.global_name || user.username)) || "User";
  }
  // Server tag (the "MC" pill next to names)
  function guildTagOf(user) {
    try {
      const pg = user && (user.primaryGuild || user.primary_guild);
      if (!pg || !pg.tag) return null;
      const gid = pg.identityGuildId || pg.identity_guild_id;
      const badge = pg.badge;
      const urls = gid && badge
        ? [
            "https://cdn.discordapp.com/guild-tag-badges/" + gid + "/" + badge + ".png?size=64",
            "https://cdn.discordapp.com/clan-badges/" + gid + "/" + badge + ".png?size=64",
          ]
        : [];
      return { tag: String(pg.tag), urls };
    } catch (e) { return null; }
  }
  // Fields stored on a contact, taken from a Discord user object
  function contactFieldsFromUser(user) {
    const gt = guildTagOf(user);
    return {
      discordId: user.id,
      username: displayNameOf(user),
      handle: user.username || "",
      avatar: avatarUrlFor(user),
      tag: gt ? gt.tag : "",
      tagUrls: gt ? gt.urls : [],
    };
  }

  // ---------- Date formatting (Discord-style) ----------
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const p2 = (n) => (n < 10 ? "0" : "") + n;
  function msgDate(m) {
    const n = Number(m && (m.ts || m.id));
    return new Date(isFinite(n) && n > 1e12 ? n : Date.now());
  }
  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  function fmtClock(d) {
    let hr = d.getHours();
    const ap = hr >= 12 ? "PM" : "AM";
    hr = hr % 12 || 12;
    return hr + ":" + p2(d.getMinutes()) + " " + ap;
  }
  // Today: "9:24 PM"   Other days: "08/23/2026 8:45 PM"
  function fmtStamp(d) {
    if (sameDay(d, new Date())) return fmtClock(d);
    return p2(d.getMonth() + 1) + "/" + p2(d.getDate()) + "/" + d.getFullYear() + " " + fmtClock(d);
  }
  function fmtDivider(d) {
    return MONTHS[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear();
  }

  // ---------- Theme ----------
  function isLightTheme() {
    try {
      const store = metro.findByStoreName?.("ThemeStore");
      if (store?.theme) return store.theme === "light";
    } catch (e) {}
    try {
      return RN.Appearance?.getColorScheme?.() === "light";
    } catch (e) {}
    return false;
  }
  function getPalette() {
    return isLightTheme()
      ? { bg: "#ffffff", text: "#060607", muted: "#4e5058", card: "#f2f3f5", accent: "#5865f2", input: "#e3e5e8" }
      : { bg: "#313338", text: "#dbdee1", muted: "#80848e", card: "#2b2d31", accent: "#5865f2", input: "#383a40" };
  }

  // Chat screen colors: pure-black Discord look in dark mode
  function getChatPalette() {
    const base = getPalette();
    return isLightTheme()
      ? Object.assign({}, base, { composer: "#f2f3f5", line: "#d4d7dc", pill: "#e3e5e8" })
      : Object.assign({}, base, { bg: "#000000", text: "#f2f3f5", card: "#0b0b0c", composer: "#111214", line: "#2b2d31", pill: "#2b2d31" });
  }

  // ---------- Groq call ----------
  async function callGroq(apiKey, userText, contact, history) {
    const system = (storage.systemPrompt || "You are roleplaying as {name} in a Discord DM. Reply naturally, casually, and in character. Keep replies reasonably short unless asked for more.").replace("{name}", contact.username || "the user");

    const messages = [{ role: "system", content: system }];
    const recent = history.slice(-12);
    for (const m of recent) {
      messages.push({
        role: m.from === "me" ? "user" : "assistant",
        content: m.text,
      });
    }
    messages.push({ role: "user", content: userText });

    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model: storage.model || DEFAULT_MODEL,
        temperature: 0.8,
        max_completion_tokens: 512,
        messages,
      }),
    });

    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const out = data?.choices?.[0]?.message?.content?.trim();
    if (!out) throw new Error("Empty response");
    return out;
  }

  async function getAIReply(userText, contact) {
    const keys = getKeys();
    if (!keys.length) return "Add a Groq API key in settings first.";
    const history = getMessages(contact.id);
    for (const key of keys) {
      try {
        const out = await callGroq(key, userText, contact, history);
        log("AI reply OK for", contact.username, "(" + out.length + " chars)");
        return out;
      } catch (e) {
        log("key failed", e.message);
      }
    }
    return "AI request failed. Check your API key.";
  }

  // ---------- Fake Chat Screen (Discord DM look) ----------
  function TagPill({ tag, urls }) {
    const { View, Text, Image } = RN;
    const [i, setI] = React.useState(0);
    const url = urls && urls[i];
    return h(
      View,
      { style: { flexDirection: "row", alignItems: "center", backgroundColor: "#2b2d31", borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, marginLeft: 6 } },
      url
        ? h(Image, { source: { uri: url }, onError: () => setI(i + 1), style: { width: 14, height: 14, marginRight: 4 } })
        : null,
      h(Text, { style: { color: "#dbdee1", fontSize: 12, fontWeight: "700" } }, tag)
    );
  }

  function FakeChatScreen({ contact }) {
    const { View, Text, ScrollView, Image, TextInput, TouchableOpacity, KeyboardAvoidingView, Platform } = RN;
    const P = getChatPalette();
    const [messages, setMessages] = React.useState(() => getMessages(contact.id));
    const [input, setInput] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const scrollRef = React.useRef(null);
    const me = getCurrentUser();

    const refresh = () => setMessages([...getMessages(contact.id)]);

    const send = async () => {
      const text = input.trim();
      if (!text || busy) return;

      const now = Date.now();
      const userMsg = {
        id: now.toString(),
        ts: now,
        from: "me",
        text,
        time: new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };
      log("Sent message to", contact.username);
      addMessage(contact.id, userMsg);
      refresh();
      setInput("");
      setBusy(true);

      try {
        const replyText = await getAIReply(text, contact);
        const t2 = Date.now();
        const reply = {
          id: (t2 + 1).toString(),
          ts: t2,
          from: "them",
          text: replyText,
          time: new Date(t2).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        };
        addMessage(contact.id, reply);
        refresh();
      } catch (e) {
        showToast("AI error: " + (e.message || "unknown"));
      } finally {
        setBusy(false);
      }
    };

    React.useEffect(() => {
      setTimeout(() => scrollRef.current?.scrollToEnd?.({ animated: true }), 80);
    }, [messages, busy]);

    // Author info for the header line of a message group
    const authorOf = (msg) => {
      if (msg.from === "me") {
        const display = displayNameOf(me);
        const handle = (me && me.username) || "";
        const gt = guildTagOf(me);
        return { avatar: avatarUrlFor(me), display, handle, tag: gt ? gt.tag : "", tagUrls: gt ? gt.urls : [] };
      }
      return {
        avatar: contact.avatar || DEFAULT_AVATAR,
        display: contact.username || "User",
        handle: contact.handle || "",
        tag: contact.tag || "",
        tagUrls: contact.tagUrls || [],
      };
    };

    const rows = [];
    messages.forEach((msg, index) => {
      const d = msgDate(msg);
      const prev = index > 0 ? messages[index - 1] : null;
      const pd = prev ? msgDate(prev) : null;
      const newDay = !pd || !sameDay(d, pd);
      const grouped = !!prev && !newDay && prev.from === msg.from && d.getTime() - pd.getTime() < 7 * 60 * 1000;

      if (newDay) {
        rows.push(
          h(
            View,
            { key: "day" + msg.id, style: { flexDirection: "row", alignItems: "center", marginHorizontal: 12, marginTop: 18, marginBottom: 2 } },
            h(View, { style: { flex: 1, height: 1, backgroundColor: P.line } }),
            h(Text, { style: { color: P.muted, fontSize: 13, fontWeight: "600", marginHorizontal: 12 } }, fmtDivider(d)),
            h(View, { style: { flex: 1, height: 1, backgroundColor: P.line } })
          )
        );
      }

      const a = authorOf(msg);
      const nameLine = a.handle && a.handle.toLowerCase() !== a.display.toLowerCase() ? a.display + " (@" + a.handle + ")" : a.display;

      rows.push(
        h(
          View,
          { key: msg.id, style: { flexDirection: "row", paddingHorizontal: 12, paddingTop: grouped ? 2 : 14, alignItems: "flex-start" } },
          grouped
            ? h(View, { style: { width: 52 } })
            : h(Image, { source: { uri: a.avatar }, style: { width: 40, height: 40, borderRadius: 20, marginRight: 12, marginTop: 2, backgroundColor: P.pill } }),
          h(
            View,
            { style: { flex: 1 } },
            grouped
              ? null
              : h(
                  View,
                  { style: { flexDirection: "row", alignItems: "center", marginBottom: 2 } },
                  h(Text, { numberOfLines: 1, style: { flexShrink: 1, color: P.text, fontWeight: "700", fontSize: 16 } }, nameLine),
                  a.tag ? h(TagPill, { tag: a.tag, urls: a.tagUrls }) : null,
                  h(Text, { style: { color: P.muted, fontSize: 12, marginLeft: 8 } }, fmtStamp(d))
                ),
            h(Text, { selectable: true, style: { color: P.text, fontSize: 16, lineHeight: 22 } }, msg.text)
          )
        )
      );
    });

    // Decorative composer buttons (visual only)
    const glyph = (g, size) =>
      h(View, { style: { width: 38, height: 38, alignItems: "center", justifyContent: "center" } },
        h(Text, { style: { color: P.muted, fontSize: size || 22 } }, g));

    const hasText = input.trim().length > 0;

    return h(
      KeyboardAvoidingView,
      { style: { flex: 1, backgroundColor: P.bg }, behavior: Platform.OS === "ios" ? "padding" : undefined },
      h(
        ScrollView,
        { ref: scrollRef, contentContainerStyle: { paddingBottom: 12 }, keyboardShouldPersistTaps: "handled" },
        rows
      ),
      h(
        View,
        { style: { paddingHorizontal: 10, paddingTop: 6, paddingBottom: 10, backgroundColor: P.bg } },
        busy
          ? h(Text, { style: { color: P.muted, fontSize: 12, marginLeft: 14, marginBottom: 4 } }, (contact.username || "They") + " is typing…")
          : null,
        h(
          View,
          { style: { flexDirection: "row", alignItems: "flex-end", backgroundColor: P.composer, borderRadius: 26, borderWidth: 1, borderColor: P.line, paddingHorizontal: 6, paddingVertical: 4 } },
          glyph("+", 26),
          h(TextInput, {
            value: input,
            onChangeText: setInput,
            placeholder: "Message @" + (contact.username || "user"),
            placeholderTextColor: P.muted,
            multiline: true,
            style: { flex: 1, color: P.text, fontSize: 16, paddingHorizontal: 6, paddingVertical: 8, maxHeight: 120 },
          }),
          hasText
            ? h(
                TouchableOpacity,
                { onPress: send, disabled: busy, style: { width: 38, height: 38, borderRadius: 19, backgroundColor: busy ? "#4e5058" : P.accent, alignItems: "center", justifyContent: "center", marginLeft: 4 } },
                h(Text, { style: { color: "#fff", fontSize: 20, fontWeight: "700" } }, "↑")
              )
            : h(View, { style: { flexDirection: "row" } }, glyph("🎁", 18), glyph("☺", 24), glyph("🎤", 18))
        )
      )
    );
  }

  function openChat(contact) {
    openCustomPage(contact.username || "Chat", () => h(FakeChatScreen, { contact }));
  }

  // ---------- Contact Manager ----------
  function ContactManager() {
    const { View, Text, TextInput, TouchableOpacity, ScrollView, Image } = RN;
    const P = getPalette();
    const [contacts, setContacts] = React.useState(getContacts());
    const [username, setUsername] = React.useState("");
    const [avatar, setAvatar] = React.useState("");

    const add = () => {
      if (!username.trim()) return showToast("Enter a username");
      const contact = {
        id: Date.now().toString(),
        username: username.trim(),
        avatar: avatar.trim() || "https://cdn.discordapp.com/embed/avatars/0.png",
      };
      saveContact(contact);
      setContacts(getContacts());
      setUsername("");
      setAvatar("");
      showToast("Contact added");
    };

    const removeContact = (c) => {
      storage.contacts = getContacts().filter((x) => x.id !== c.id);
      const m = Object.assign({}, storage.messages || {});
      delete m[c.id];
      storage.messages = m;
      setContacts(getContacts().slice());
      log("Contact removed:", c.username);
      showToast("Contact removed");
    };

    return h(
      ScrollView,
      { style: { flex: 1, backgroundColor: P.bg }, contentContainerStyle: { padding: 16 } },
      h(Text, { style: { color: P.text, fontSize: 20, fontWeight: "700", marginBottom: 12 } }, "Simulate DMs"),
      contacts.length === 0
        ? h(Text, { style: { color: P.muted, marginBottom: 16 } }, "No contacts yet. Add one below.")
        : contacts.map((c) =>
            h(
              TouchableOpacity,
              {
                key: c.id,
                onPress: () => openChat(c),
                style: { flexDirection: "row", alignItems: "center", padding: 12, backgroundColor: P.card, borderRadius: 10, marginBottom: 8 },
              },
              h(Image, { source: { uri: c.avatar }, style: { width: 44, height: 44, borderRadius: 22, marginRight: 12 } }),
              h(Text, { style: { color: P.text, fontSize: 16, fontWeight: "600", flex: 1 } }, c.username),
              h(
                TouchableOpacity,
                { onPress: () => removeContact(c), style: { paddingHorizontal: 10, paddingVertical: 6 } },
                h(Text, { style: { color: "#da373c", fontSize: 18, fontWeight: "700" } }, "✕")
              )
            )
          ),
      h(Text, { style: { color: P.muted, marginTop: 16, marginBottom: 8, fontWeight: "600" } }, "Add contact"),
      h(TextInput, {
        value: username,
        onChangeText: setUsername,
        placeholder: "Username",
        placeholderTextColor: P.muted,
        style: { backgroundColor: P.card, color: P.text, borderRadius: 8, padding: 12, marginBottom: 8 },
      }),
      h(TextInput, {
        value: avatar,
        onChangeText: setAvatar,
        placeholder: "Avatar URL (optional)",
        placeholderTextColor: P.muted,
        autoCapitalize: "none",
        style: { backgroundColor: P.card, color: P.text, borderRadius: 8, padding: 12, marginBottom: 12 },
      }),
      h(
        TouchableOpacity,
        { onPress: add, style: { backgroundColor: "#248046", borderRadius: 8, padding: 14, alignItems: "center" } },
        h(Text, { style: { color: "#fff", fontWeight: "700", fontSize: 16 } }, "Add Contact")
      )
    );
  }

  // ---------- Settings Page ----------
  function SettingsPage() {
    useProxy(storage);
    const { View, Text, TextInput, TouchableOpacity, ScrollView } = RN;
    const P = getPalette();
    const [newKey, setNewKey] = React.useState("");
    const [prompt, setPrompt] = React.useState(storage.systemPrompt || "");
    const keys = Array.isArray(storage.apiKeys) ? storage.apiKeys : [];
    const [, bump] = React.useState(0);

    const addKey = () => {
      const k = newKey.trim();
      if (!k.startsWith("gsk_")) return showToast("Key must start with gsk_");
      const list = Array.isArray(storage.apiKeys) ? storage.apiKeys : [];
      if (list.some((x) => x.key === k)) return showToast("Key already added");
      const nextId = list.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
      storage.apiKeys = list.concat([{ id: nextId, key: k }]);
      setNewKey("");
      showToast("Key added");
    };

    const removeKey = (id) => {
      storage.apiKeys = (storage.apiKeys || []).filter((x) => x.id !== id);
    };

    const savePrompt = () => {
      storage.systemPrompt = prompt;
      showToast("Prompt saved");
    };

    return h(
      ScrollView,
      { style: { flex: 1, backgroundColor: P.bg }, contentContainerStyle: { padding: 16 } },
      h(Text, { style: { color: P.text, fontSize: 20, fontWeight: "700", marginBottom: 16 } }, "Simulate DM Settings"),
      h(
        TouchableOpacity,
        { onPress: () => openCustomPage("Simulate DMs", ContactManager), style: { backgroundColor: P.accent, borderRadius: 8, padding: 14, alignItems: "center", marginBottom: 24 } },
        h(Text, { style: { color: "#fff", fontWeight: "700", fontSize: 16 } }, "Open Simulated DMs")
      ),


      h(Text, { style: { color: P.muted, fontWeight: "700", marginBottom: 8 } }, "GROQ API KEYS"),
      keys.length === 0
        ? h(Text, { style: { color: P.muted, marginBottom: 8 } }, "No keys added")
        : keys.map((k) =>
            h(
              View,
              { key: k.id, style: { flexDirection: "row", alignItems: "center", backgroundColor: P.card, borderRadius: 8, padding: 12, marginBottom: 8 } },
              h(Text, { style: { color: P.text, flex: 1 } }, "#" + k.id + "  " + (k.key.length > 12 ? k.key.slice(0, 8) + "…" + k.key.slice(-4) : k.key)),
              h(
                TouchableOpacity,
                { onPress: () => removeKey(k.id), style: { backgroundColor: "#da373c", borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6 } },
                h(Text, { style: { color: "#fff", fontWeight: "600" } }, "Delete")
              )
            )
          ),
      h(TextInput, {
        value: newKey,
        onChangeText: setNewKey,
        placeholder: "gsk_...",
        placeholderTextColor: P.muted,
        autoCapitalize: "none",
        style: { backgroundColor: P.card, color: P.text, borderRadius: 8, padding: 12, marginBottom: 8 },
      }),
      h(
        TouchableOpacity,
        { onPress: addKey, style: { backgroundColor: "#248046", borderRadius: 8, padding: 12, alignItems: "center", marginBottom: 24 } },
        h(Text, { style: { color: "#fff", fontWeight: "700" } }, "Add API Key")
      ),

      h(Text, { style: { color: P.muted, fontWeight: "700", marginBottom: 8 } }, "SYSTEM PROMPT"),
      h(Text, { style: { color: P.muted, fontSize: 12, marginBottom: 6 } }, "Use {name} for the contact’s username."),
      h(TextInput, {
        value: prompt,
        onChangeText: setPrompt,
        multiline: true,
        placeholder: "You are roleplaying as {name}...",
        placeholderTextColor: P.muted,
        style: { backgroundColor: P.card, color: P.text, borderRadius: 8, padding: 12, minHeight: 100, textAlignVertical: "top", marginBottom: 8 },
      }),
      h(
        TouchableOpacity,
        { onPress: savePrompt, style: { backgroundColor: P.accent, borderRadius: 8, padding: 12, alignItems: "center" } },
        h(Text, { style: { color: "#fff", fontWeight: "700" } }, "Save Prompt")
      ),

      h(Text, { style: { color: P.muted, fontWeight: "700", marginTop: 24, marginBottom: 8 } }, "DEBUG LOGS"),
      h(Text, { style: { color: P.muted, fontSize: 12, marginBottom: 8 } }, logBuffer.length + " log entries. Logs include usernames and error details; API keys are never included. Exports go to Android/data/<package>/files/FakeDMExports/."),
      h(
        TouchableOpacity,
        { onPress: async () => { await exportLogs(); bump((n) => n + 1); }, style: { backgroundColor: "#248046", borderRadius: 8, padding: 12, alignItems: "center", marginBottom: 8 } },
        h(Text, { style: { color: "#fff", fontWeight: "700" } }, "Export Logs")
      ),
      h(
        TouchableOpacity,
        { onPress: shareLogs, style: { backgroundColor: "#5865f2", borderRadius: 8, padding: 12, alignItems: "center", marginBottom: 8 } },
        h(Text, { style: { color: "#fff", fontWeight: "700" } }, "Share Logs")
      ),
      h(
        TouchableOpacity,
        { onPress: () => { showToast(copyToClipboard(buildLogText()) ? "Logs copied to clipboard" : "Copy failed"); }, style: { backgroundColor: P.accent, borderRadius: 8, padding: 12, alignItems: "center", marginBottom: 8 } },
        h(Text, { style: { color: "#fff", fontWeight: "700" } }, "Copy Logs")
      ),
      h(
        TouchableOpacity,
        { onPress: () => { logBuffer.length = 0; bump((n) => n + 1); showToast("Logs cleared"); }, style: { backgroundColor: "#da373c", borderRadius: 8, padding: 12, alignItems: "center" } },
        h(Text, { style: { color: "#fff", fontWeight: "700" } }, "Clear Logs")
      )
    );
  }

  // ---------- Navigation ----------
  function openCustomPage(title, render) {
    try {
      const navMod = metro.findByProps("getRootNavigationRef");
      const ref = navMod?.getRootNavigationRef?.();
      if (ref?.navigate) {
        ref.navigate("VendettaCustomPage", { title, render });
        return;
      }
    } catch (e) {}
    try {
      const Navigation = metro.findByProps("Navigation")?.Navigation;
      Navigation?.push?.("VendettaCustomPage", { title, render });
    } catch (e) {
      log("openCustomPage failed:", e);
      showToast("Could not open page");
    }
  }

  // ---------- Patch DM list ----------
  const DM_NAME_RE = /^(DirectMessages|DirectMessagesScreen|DirectMessageList|PrivateChannels|PrivateChannelList|PrivateChannelsList|ConnectedPrivateChannels|DMList|DMsList|MessagesTab|MessagesScreen|HomeDirectMessages)$|PrivateChannel.*List|DirectMessage.*List/i;

  function fnName(f) {
    try { return (f && (f.displayName || f.name)) || ""; } catch (e) { return ""; }
  }

  function findDMListCandidates() {
    const found = [];
    const seen = new Set();
    const add = (holder, key, label) => {
      try {
        if (!holder || typeof holder[key] !== "function" || seen.has(holder[key])) return;
        seen.add(holder[key]);
        found.push({ holder, key, label });
      } catch (e) {}
    };

    // 1) Known / likely names
    const names = ["DirectMessages", "DirectMessagesScreen", "PrivateChannels", "PrivateChannelList", "ConnectedPrivateChannels", "DMList", "MessagesTab", "HomeDirectMessages"];
    for (const n of names) {
      try { const m = metro.findByName?.(n, false); if (m) add(m, "default", n); } catch (e) {}
      try { (metro.findByNameAll?.(n, false) || []).forEach((m) => add(m, "default", n)); } catch (e) {}
    }

    // 2) Scan every loaded module for a default export whose name looks like a DM list
    try {
      const all = metro.findAll?.((m) => {
        try { return typeof m?.default === "function" && DM_NAME_RE.test(fnName(m.default)); } catch (e) { return false; }
      }) || [];
      all.forEach((m) => add(m, "default", fnName(m.default)));
    } catch (e) {}

    return found;
  }

  function patchDMScreen() {
    const candidates = findDMListCandidates();
    log("DM list candidates:", candidates.map((c) => c.label).join(", ") || "none");

    if (!candidates.length) {
      showToast("Simulate DM: DM list not found (check logs)");
      return;
    }

    const injectButton = (args, ret) => {
      try {
        if (!ret || !RN || ret?.props?.["data-fakedm"]) return ret;
        return h(
          RN.View,
          { style: { flex: 1 }, "data-fakedm": true },
          h(
            RN.TouchableOpacity,
            {
              onPress: () => openCustomPage("Simulate DMs", ContactManager),
              style: { marginHorizontal: 12, marginVertical: 8, padding: 14, backgroundColor: "#5865f2", borderRadius: 8, alignItems: "center" },
            },
            h(RN.Text, { style: { color: "#fff", fontWeight: "700", fontSize: 16 } }, "Simulate DM")
          ),
          ret
        );
      } catch (e) {
        return ret;
      }
    };

    // Patch the first few candidates; the wrapper skips anything already wrapped
    let patched = 0;
    for (const c of candidates.slice(0, 4)) {
      try {
        unpatches.push(after(c.key, c.holder, injectButton));
        patched++;
      } catch (e) {
        log("patch failed for", c.label, e?.message);
      }
    }
    showToast("Simulate DM: patched " + patched + " DM list component(s)");
  }

  // ---------- Settings entry (like AI Writer Magic) ----------
  const SETTINGS_KEY = "FAKE_DM_SIM";

  function patchSettings() {
    const settingConstants = metro.findByProps("SETTING_RENDERER_CONFIG");
    if (!settingConstants) return;

    const row = {};
    row[SETTINGS_KEY] = {
      type: "pressable",
      title: () => "Simulate DM",
      useTitle: () => "Simulate DM",
      usePredicate: () => true,
      onPress: () => openCustomPage("Simulate DM Settings", SettingsPage),
      withArrow: true,
    };

    let value = settingConstants.SETTING_RENDERER_CONFIG;
    try {
      Object.defineProperty(settingConstants, "SETTING_RENDERER_CONFIG", {
        enumerable: true,
        configurable: true,
        get: () => Object.assign({}, value, row),
        set: (v) => { value = v; },
      });
    } catch (e) {
      if (value && !value[SETTINGS_KEY]) value[SETTINGS_KEY] = row[SETTINGS_KEY];
    }

    const createList = metro.findByProps("createList");
    if (createList?.createList) {
      unpatches.push(
        after("createList", createList, (args) => {
          try {
            const sections = args?.[0]?.sections;
            if (!Array.isArray(sections)) return;
            const section = sections.find((s) => s && ["Bunny", "Kettu", "Revenge"].includes(s.label));
            if (section && Array.isArray(section.settings) && !section.settings.includes(SETTINGS_KEY)) {
              section.settings.push(SETTINGS_KEY);
            } else if (sections.some((s) => s?.settings?.includes("ACCOUNT"))) {
              sections.unshift({ label: "Simulate DM", title: "Simulate DM", settings: [SETTINGS_KEY] });
            }
          } catch (e) {}
        })
      );
    }
  }

  // ---------- Patch user profile overflow menu ----------
  function patchUserProfileMenu() {
    const NAMES = ["UserProfileOverflowMenu", "BotUserProfileOverflowMenu"];
    const openLazy = metro.findByProps("openLazy")?.openLazy;

    function getMainItems(ret) {
      let items = ret?.props?.items;
      if (Array.isArray(items) && Array.isArray(items[0])) return items[0];
      items = ret?.props?.children?.props?.items;
      if (Array.isArray(items) && Array.isArray(items[0])) return items[0];
      try {
        const findInReactTree = vendetta.utils?.findInReactTree;
        if (findInReactTree) {
          const node = findInReactTree(ret, (n) => Array.isArray(n?.props?.items) && Array.isArray(n.props.items[0]));
          return node?.props?.items?.[0] ?? null;
        }
      } catch (e) {}
      return null;
    }

    function patchFn(args, ret) {
      try {
        const props = args[0] || {};
        let user = props.user || props.displayProfile?.user;
        if (!user) {
          const uid = props.userId || props.user_id;
          if (uid) user = getUserStore()?.getUser?.(uid);
        }
        if (!user || !user.id) {
          logOnce("noUser", "profile menu: no user found, props:", Object.keys(props).join(","));
          return;
        }
        const items = getMainItems(ret);
        if (!items) {
          logOnce("noItems", "profile menu: menu items not found");
          return;
        }
        if (items.some((i) => i?.label === "Simulate DM")) return;

        items.push({
          label: "Simulate DM",
          action: () => {
            const fields = contactFieldsFromUser(user);
            log("Simulate DM pressed for", fields.username, "(@" + fields.handle + ")", fields.discordId);

            let contact = getContacts().find((c) => c.discordId === user.id);
            if (!contact) {
              contact = Object.assign({ id: Date.now().toString() }, fields);
              saveContact(contact);
              log("Contact created from profile:", contact.username);
              showToast("Contact created: " + contact.username);
            } else {
              // refresh name/avatar/tag in case they changed
              contact = Object.assign({}, contact, fields);
              saveContact(contact);
              log("Contact updated from profile:", contact.username);
            }

            openChat(contact);
          },
        });
      } catch (e) {
        log("profile menu patch error", e);
      }
    }

    let hooked = 0;
    const tryHook = (mod, label) => {
      try {
        if (!mod || typeof mod.default !== "function") return false;
        unpatches.push(after("default", mod, patchFn));
        hooked++;
        log("profile menu: patched", label);
        return true;
      } catch (e) {
        log("profile menu: patch failed for", label, e);
        return false;
      }
    };

    for (const name of NAMES) {
      try { tryHook(metro.findByName?.(name, false), name); } catch (e) {}
    }
    if (!hooked) {
      // Fallback: scan loaded modules for a profile overflow menu component
      try {
        const re = /UserProfile.*OverflowMenu|UserProfileOverflow/i;
        const all = metro.findAll?.((m) => { try { return typeof m?.default === "function" && re.test(fnName(m.default)); } catch (e) { return false; } }) || [];
        all.slice(0, 4).forEach((m) => tryHook(m, fnName(m.default)));
      } catch (e) {}
    }
    if (!hooked) log("profile menu: no overflow menu component found, Simulate DM entry is unavailable there");
  }

  function onLoad() {
    if (!Array.isArray(storage.apiKeys)) storage.apiKeys = [];
    if (!storage.contacts) storage.contacts = [];
    if (!storage.messages) storage.messages = {};
    if (typeof storage.systemPrompt !== "string") {
      storage.systemPrompt = "You are roleplaying as {name} in a Discord DM. Reply naturally and casually in character. Keep most replies short.";
    }
    // patchDMScreen() disabled: wrapping the DM list crashes native views (removeViewAt error)
    log("Plugin loaded");
    try { patchSettings(); } catch (e) { log("settings patch failed", e); }
    try { patchUserProfileMenu(); } catch (e) { log("profile menu patch failed", e); }
  }

  function onUnload() {
    while (unpatches.length) {
      try { unpatches.pop()(); } catch (e) {}
    }
  }

  return { onLoad, onUnload, settings: SettingsPage };
})();
