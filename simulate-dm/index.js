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

  // ---------- Logging ----------
  const logBuffer = [];
  function log(...args) {
    const line = "[" + new Date().toISOString() + "] " + args.map(a => (a instanceof Error ? a.message : (typeof a === "string" ? a : JSON.stringify(a)))).join(" ");
    logBuffer.push(line);
    if (logBuffer.length > 500) logBuffer.shift();
    try { console.log("[FakeDM v348.10]", ...args); } catch (e) {}
  }

  // ---------- Discord user helpers ----------
  const DEFAULT_AVATAR = "https://cdn.discordapp.com/embed/avatars/0.png";
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

  // ---------- Date formatting ----------
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
  function fmtStamp(d) {
    if (sameDay(d, new Date())) return fmtClock(d);
    return p2(d.getMonth() + 1) + "/" + p2(d.getDate()) + "/" + d.getFullYear() + " " + fmtClock(d);
  }
  function fmtDivider(d) {
    return MONTHS[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear();
  }

  // ---------- Theme & Native Tokens ----------
  function isLightTheme() {
    try {
      const store = metro.findByStoreName?.("ThemeStore");
      if (store?.theme) return store.theme === "light";
    } catch (e) {}
    try { return RN.Appearance?.getColorScheme?.() === "light"; } catch (e) {}
    return false;
  }

  function getChatPalette() {
    const light = isLightTheme();
    return light
      ? { bg: "#ffffff", text: "#060607", muted: "#4e5058", card: "#f2f3f5", accent: "#5865f2", composer: "#f2f3f5", line: "#d4d7dc", pill: "#e3e5e8" }
      : { bg: "#313338", text: "#dbdee1", muted: "#80848e", card: "#2b2d31", accent: "#5865f2", composer: "#2b2d31", line: "#1f2023", pill: "#2b2d31" };
  }

  // ---------- Groq AI Integration ----------
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
        return await callGroq(key, userText, contact, history);
      } catch (e) {}
    }
    return "AI request failed. Check your API key.";
  }

  // ---------- Tag Pill ----------
  function TagPill({ tag, urls }) {
    const { View, Text, Image } = RN;
    const [i, setI] = React.useState(0);
    const url = urls && urls[i];
    return h(
      View,
      { style: { flexDirection: "row", alignItems: "center", backgroundColor: "#2b2d31", borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1, marginLeft: 4 } },
      url ? h(Image, { source: { uri: url }, onError: () => setI(i + 1), style: { width: 12, height: 12, marginRight: 3 } }) : null,
      h(Text, { style: { color: "#dbdee1", fontSize: 11, fontWeight: "700" } }, tag)
    );
  }

  // ---------- Chat Screen (v348.10 UI) ----------
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
      const userMsg = { id: now.toString(), ts: now, from: "me", text };
      addMessage(contact.id, userMsg);
      refresh();
      setInput("");
      setBusy(true);

      try {
        const replyText = await getAIReply(text, contact);
        const t2 = Date.now();
        const reply = { id: (t2 + 1).toString(), ts: t2, from: "them", text: replyText };
        addMessage(contact.id, reply);
        refresh();
      } catch (e) {
        showToast("AI error");
      } finally {
        setBusy(false);
      }
    };

    React.useEffect(() => {
      setTimeout(() => scrollRef.current?.scrollToEnd?.({ animated: true }), 80);
    }, [messages, busy]);

    const authorOf = (msg) => {
      if (msg.from === "me") {
        const display = displayNameOf(me);
        const gt = guildTagOf(me);
        return { avatar: avatarUrlFor(me), display, tag: gt ? gt.tag : "", tagUrls: gt ? gt.urls : [] };
      }
      return {
        avatar: contact.avatar || DEFAULT_AVATAR,
        display: contact.username || "User",
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
            { key: "day" + msg.id, style: { flexDirection: "row", alignItems: "center", marginHorizontal: 16, marginTop: 24, marginBottom: 8 } },
            h(View, { style: { flex: 1, height: 1, backgroundColor: P.line } }),
            h(Text, { style: { color: P.muted, fontSize: 12, fontWeight: "600", marginHorizontal: 8 } }, fmtDivider(d)),
            h(View, { style: { flex: 1, height: 1, backgroundColor: P.line } })
          )
        );
      }

      const a = authorOf(msg);
      rows.push(
        h(
          View,
          { key: msg.id, style: { flexDirection: "row", paddingHorizontal: 16, paddingTop: grouped ? 2 : 10, alignItems: "flex-start" } },
          grouped
            ? h(View, { style: { width: 44 } })
            : h(Image, { source: { uri: a.avatar }, style: { width: 40, height: 40, borderRadius: 20, marginRight: 12, backgroundColor: P.pill } }),
          h(
            View,
            { style: { flex: 1 } },
            grouped
              ? null
              : h(
                  View,
                  { style: { flexDirection: "row", alignItems: "center", marginBottom: 2 } },
                  h(Text, { numberOfLines: 1, style: { flexShrink: 1, color: P.text, fontWeight: "600", fontSize: 15 } }, a.display),
                  a.tag ? h(TagPill, { tag: a.tag, urls: a.tagUrls }) : null,
                  h(Text, { style: { color: P.muted, fontSize: 11, marginLeft: 6 } }, fmtStamp(d))
                ),
            h(Text, { selectable: true, style: { color: P.text, fontSize: 15, lineHeight: 20 } }, msg.text)
          )
        )
      );
    });

    const iconGlyph = (char) => h(View, { style: { width: 36, height: 36, alignItems: "center", justifyContent: "center" } }, h(Text, { style: { color: P.muted, fontSize: 20 } }, char));
    const hasText = input.trim().length > 0;

    return h(
      KeyboardAvoidingView,
      { style: { flex: 1, backgroundColor: P.bg }, behavior: Platform.OS === "ios" ? "padding" : undefined },
      h(ScrollView, { ref: scrollRef, contentContainerStyle: { paddingBottom: 16 }, keyboardShouldPersistTaps: "handled" }, rows),
      h(
        View,
        { style: { paddingHorizontal: 12, paddingVertical: 8, backgroundColor: P.bg } },
        busy ? h(Text, { style: { color: P.muted, fontSize: 12, marginLeft: 12, marginBottom: 4 } }, (contact.username || "They") + " sedang mengetik...") : null,
        h(
          View,
          { style: { flexDirection: "row", alignItems: "center", backgroundColor: P.composer, borderRadius: 8, paddingHorizontal: 4, paddingVertical: 2 } },
          iconGlyph("+"),
          h(TextInput, {
            value: input,
            onChangeText: setInput,
            placeholder: "Kirim pesan ke @" + (contact.username || "user"),
            placeholderTextColor: P.muted,
            multiline: true,
            style: { flex: 1, color: P.text, fontSize: 15, paddingHorizontal: 8, paddingVertical: 8, maxHeight: 110 },
          }),
          hasText
            ? h(
                TouchableOpacity,
                { onPress: send, disabled: busy, style: { width: 32, height: 32, borderRadius: 16, backgroundColor: P.accent, alignItems: "center", justifyContent: "center", marginRight: 4 } },
                h(Text, { style: { color: "#fff", fontSize: 16, fontWeight: "700" } }, "↑")
              )
            : h(View, { style: { flexDirection: "row" } }, iconGlyph("🎁"), iconGlyph("☺"))
        )
      )
    );
  }

  function openChat(contact) {
    openCustomPage(contact.username || "Chat", () => h(FakeChatScreen, { contact }));
  }

  // ---------- Contact Manager & Settings UI ----------
  function ContactManager() {
    const { View, Text, TextInput, TouchableOpacity, ScrollView, Image } = RN;
    const P = getChatPalette();
    const [contacts, setContacts] = React.useState(getContacts());
    const [username, setUsername] = React.useState("");
    const [avatar, setAvatar] = React.useState("");

    const add = () => {
      if (!username.trim()) return showToast("Masukkan username");
      const contact = { id: Date.now().toString(), username: username.trim(), avatar: avatar.trim() || DEFAULT_AVATAR };
      saveContact(contact);
      setContacts(getContacts());
      setUsername("");
      setAvatar("");
      showToast("Kontak ditambahkan");
    };

    const removeContact = (c) => {
      storage.contacts = getContacts().filter((x) => x.id !== c.id);
      const m = Object.assign({}, storage.messages || {});
      delete m[c.id];
      storage.messages = m;
      setContacts(getContacts().slice());
      showToast("Kontak dihapus");
    };

    return h(
      ScrollView,
      { style: { flex: 1, backgroundColor: P.bg }, contentContainerStyle: { padding: 16 } },
      h(Text, { style: { color: P.text, fontSize: 18, fontWeight: "700", marginBottom: 12 } }, "Simulasi DM"),
      contacts.length === 0
        ? h(Text, { style: { color: P.muted, marginBottom: 16 } }, "Belum ada kontak. Tambahkan di bawah.")
        : contacts.map((c) =>
            h(
              TouchableOpacity,
              {
                key: c.id,
                onPress: () => openChat(c),
                style: { flexDirection: "row", alignItems: "center", padding: 10, backgroundColor: P.card, borderRadius: 8, marginBottom: 8 },
              },
              h(Image, { source: { uri: c.avatar }, style: { width: 40, height: 40, borderRadius: 20, marginRight: 12 } }),
              h(Text, { style: { color: P.text, fontSize: 15, fontWeight: "600", flex: 1 } }, c.username),
              h(TouchableOpacity, { onPress: () => removeContact(c), style: { padding: 8 } }, h(Text, { style: { color: "#ed4245", fontWeight: "700" } }, "✕"))
            )
          ),
      h(Text, { style: { color: P.muted, marginTop: 16, marginBottom: 8, fontWeight: "600" } }, "Tambah Kontak"),
      h(TextInput, { value: username, onChangeText: setUsername, placeholder: "Username", placeholderTextColor: P.muted, style: { backgroundColor: P.card, color: P.text, borderRadius: 8, padding: 12, marginBottom: 8 } }),
      h(TextInput, { value: avatar, onChangeText: setAvatar, placeholder: "URL Avatar (opsional)", placeholderTextColor: P.muted, autoCapitalize: "none", style: { backgroundColor: P.card, color: P.text, borderRadius: 8, padding: 12, marginBottom: 12 } }),
      h(TouchableOpacity, { onPress: add, style: { backgroundColor: "#248046", borderRadius: 8, padding: 12, alignItems: "center" } }, h(Text, { style: { color: "#fff", fontWeight: "700" } }, "Simpan Kontak"))
    );
  }

  function SettingsPage() {
    useProxy(storage);
    const { View, Text, TextInput, TouchableOpacity, ScrollView } = RN;
    const P = getChatPalette();
    const [newKey, setNewKey] = React.useState("");
    const [prompt, setPrompt] = React.useState(storage.systemPrompt || "");
    const keys = Array.isArray(storage.apiKeys) ? storage.apiKeys : [];

    const addKey = () => {
      const k = newKey.trim();
      if (!k.startsWith("gsk_")) return showToast("Key harus dimulai dengan gsk_");
      const list = Array.isArray(storage.apiKeys) ? storage.apiKeys : [];
      if (list.some((x) => x.key === k)) return showToast("Key sudah ada");
      const nextId = list.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
      storage.apiKeys = list.concat([{ id: nextId, key: k }]);
      setNewKey("");
      showToast("API Key ditambahkan");
    };

    const removeKey = (id) => {
      storage.apiKeys = (storage.apiKeys || []).filter((x) => x.id !== id);
    };

    const savePrompt = () => {
      storage.systemPrompt = prompt;
      showToast("System prompt disimpan");
    };

    return h(
      ScrollView,
      { style: { flex: 1, backgroundColor: P.bg }, contentContainerStyle: { padding: 16 } },
      h(Text, { style: { color: P.text, fontSize: 18, fontWeight: "700", marginBottom: 16 } }, "Pengaturan Simulasi DM (v348.10)"),
      h(TouchableOpacity, { onPress: () => openCustomPage("Daftar Simulasi DM", ContactManager), style: { backgroundColor: P.accent, borderRadius: 8, padding: 12, alignItems: "center", marginBottom: 20 } }, h(Text, { style: { color: "#fff", fontWeight: "700" } }, "Buka Simulasi DM")),
      h(Text, { style: { color: P.muted, fontWeight: "700", marginBottom: 8 } }, "GROQ API KEYS"),
      keys.map((k) =>
        h(
          View,
          { key: k.id, style: { flexDirection: "row", alignItems: "center", backgroundColor: P.card, borderRadius: 8, padding: 10, marginBottom: 8 } },
          h(Text, { style: { color: P.text, flex: 1 } }, "#" + k.id + " " + (k.key.length > 10 ? k.key.slice(0, 6) + "..." + k.key.slice(-4) : k.key)),
          h(TouchableOpacity, { onPress: () => removeKey(k.id), style: { backgroundColor: "#ed4245", borderRadius: 4, paddingHorizontal: 8, paddingVertical: 4 } }, h(Text, { style: { color: "#fff" } }, "Hapus"))
        )
      ),
      h(TextInput, { value: newKey, onChangeText: setNewKey, placeholder: "gsk_...", placeholderTextColor: P.muted, autoCapitalize: "none", style: { backgroundColor: P.card, color: P.text, borderRadius: 8, padding: 12, marginBottom: 8 } }),
      h(TouchableOpacity, { onPress: addKey, style: { backgroundColor: "#248046", borderRadius: 8, padding: 12, alignItems: "center", marginBottom: 20 } }, h(Text, { style: { color: "#fff", fontWeight: "700" } }, "Tambah API Key")),
      h(Text, { style: { color: P.muted, fontWeight: "700", marginBottom: 8 } }, "SYSTEM PROMPT"),
      h(TextInput, { value: prompt, onChangeText: setPrompt, multiline: true, placeholder: "You are roleplaying as {name}...", placeholderTextColor: P.muted, style: { backgroundColor: P.card, color: P.text, borderRadius: 8, padding: 12, minHeight: 90, textAlignVertical: "top", marginBottom: 8 } }),
      h(TouchableOpacity, { onPress: savePrompt, style: { backgroundColor: P.accent, borderRadius: 8, padding: 12, alignItems: "center" } }, h(Text, { style: { color: "#fff", fontWeight: "700" } }, "Simpan Prompt"))
    );
  }

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
      showToast("Gagal membuka halaman");
    }
  }

  function patchSettings() {
    const settingConstants = metro.findByProps("SETTING_RENDERER_CONFIG");
    if (!settingConstants) return;

    const row = {};
    row["FAKE_DM_SIM"] = {
      type: "pressable",
      title: () => "Simulate DM",
      useTitle: () => "Simulate DM",
      usePredicate: () => true,
      onPress: () => openCustomPage("Pengaturan Simulate DM", SettingsPage),
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
      if (value && !value["FAKE_DM_SIM"]) value["FAKE_DM_SIM"] = row["FAKE_DM_SIM"];
    }

    const createList = metro.findByProps("createList");
    if (createList?.createList) {
      unpatches.push(
        after("createList", createList, (args) => {
          try {
            const sections = args?.[0]?.sections;
            if (!Array.isArray(sections)) return;
            const section = sections.find((s) => s && ["Bunny", "Kettu", "Revenge", "Plugins"].includes(s.label));
            if (section && Array.isArray(section.settings) && !section.settings.includes("FAKE_DM_SIM")) {
              section.settings.push("FAKE_DM_SIM");
            }
          } catch (e) {}
        })
      );
    }
  }

  function patchUserProfileMenu() {
    const NAMES = ["UserProfileOverflowMenu", "BotUserProfileOverflowMenu", "UserProfileSheet"];
    function getMainItems(ret) {
      let items = ret?.props?.items;
      if (Array.isArray(items) && Array.isArray(items[0])) return items[0];
      items = ret?.props?.children?.props?.items;
      if (Array.isArray(items) && Array.isArray(items[0])) return items[0];
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
        if (!user || !user.id) return;
        const items = getMainItems(ret);
        if (!items || items.some((i) => i?.label === "Simulate DM")) return;

        items.push({
          label: "Simulate DM",
          action: () => {
            const fields = contactFieldsFromUser(user);
            let contact = getContacts().find((c) => c.discordId === user.id);
            if (!contact) {
              contact = Object.assign({ id: Date.now().toString() }, fields);
              saveContact(contact);
              showToast("Kontak dibuat: " + contact.username);
            } else {
              contact = Object.assign({}, contact, fields);
              saveContact(contact);
            }
            openChat(contact);
          },
        });
      } catch (e) {}
    }

    for (const name of NAMES) {
      try {
        const mod = metro.findByName?.(name, false);
        if (mod && typeof mod.default === "function") {
          unpatches.push(after("default", mod, patchFn));
        }
      } catch (e) {}
    }
  }

  function onLoad() {
    if (!Array.isArray(storage.apiKeys)) storage.apiKeys = [];
    if (!storage.contacts) storage.contacts = [];
    if (!storage.messages) storage.messages = {};
    if (typeof storage.systemPrompt !== "string") {
      storage.systemPrompt = "You are roleplaying as {name} in a Discord DM. Reply naturally and casually in character. Keep most replies short.";
    }
    try { patchSettings(); } catch (e) {}
    try { patchUserProfileMenu(); } catch (e) {}
  }

  function onUnload() {
    while (unpatches.length) {
      try { unpatches.pop()(); } catch (e) {}
    }
  }

  return { onLoad, onUnload, settings: SettingsPage };
})();
