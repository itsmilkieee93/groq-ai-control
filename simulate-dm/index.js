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
      showToast("Could not open page");
    }
  }

  // ---------- Add button next to search in Messages tab ----------
  function patchSearchButton() {
    const searchNames = ["SearchBar", "DMSearch", "PrivateChannelsSearch", "MessagesSearch", "SearchIcon", "HeaderSearch"];
    let patched = 0;

    function tryPatch(mod, label) {
      try {
        if (!mod || typeof mod.default !== "function") return false;
        unpatches.push(after("default", mod, (args, ret) => {
          try {
            if (!ret || ret?.props?.["data-fakedm-search"]) return ret;
            return h(
              RN.View,
              { style: { flexDirection: "row", alignItems: "center" }, "data-fakedm-search": true },
              ret,
              h(
                RN.TouchableOpacity,
                {
                  onPress: () => openCustomPage("Simulate DMs", ContactManager),
                  style: { marginLeft: 8, padding: 8, backgroundColor: "#5865f2", borderRadius: 8 },
                },
                h(RN.Text, { style: { color: "#fff", fontWeight: "700", fontSize: 14 } }, "Sim")
              )
            );
          } catch (e) { return ret; }
        }));
        patched++;
        log("search button: patched", label);
        return true;
      } catch (e) { return false; }
    }

    for (const name of searchNames) {
      try { tryPatch(metro.findByName?.(name, false), name); } catch (e) {}
    }

    if (!patched) {
      try {
        const re = /Search(Bar|Icon|Button|Header)/i;
        const all = metro.findAll?.((m) => {
          try { return typeof m?.default === "function" && re.test((m.default.displayName || m.default.name || "")); } catch (e) { return false; }
        }) || [];
        all.slice(0, 3).forEach((m) => tryPatch(m, m.default.displayName || m.default.name || "search"));
      } catch (e) {}
    }

    if (patched) showToast("Simulate DM button added next to search");
    else log("search button: no search component found");
  }

  // ---------- Contact Manager (minimal) ----------
  function ContactManager() {
    const { View, Text, TouchableOpacity, ScrollView, Image } = RN;
    const contacts = getContacts();
    return h(
      ScrollView,
      { style: { flex: 1, backgroundColor: "#313338" }, contentContainerStyle: { padding: 16 } },
      h(Text, { style: { color: "#fff", fontSize: 20, fontWeight: "700", marginBottom: 12 } }, "Simulate DMs"),
      contacts.length === 0
        ? h(Text, { style: { color: "#80848e" } }, "No contacts yet. Use the profile menu to add one.")
        : contacts.map((c) =>
            h(
              TouchableOpacity,
              { key: c.id, onPress: () => openCustomPage(c.username, () => h(FakeChatScreen, { contact: c })), style: { flexDirection: "row", alignItems: "center", padding: 12, backgroundColor: "#2b2d31", borderRadius: 10, marginBottom: 8 } },
              h(Image, { source: { uri: c.avatar }, style: { width: 44, height: 44, borderRadius: 22, marginRight: 12 } }),
              h(Text, { style: { color: "#fff", fontSize: 16, fontWeight: "600" } }, c.username)
            )
          )
    );
  }

  // ---------- Fake Chat Screen (simplified) ----------
  function FakeChatScreen({ contact }) {
    const { View, Text, ScrollView, TextInput, TouchableOpacity } = RN;
    const [messages, setMessages] = React.useState(() => getMessages(contact.id));
    const [input, setInput] = React.useState("");
    const [busy, setBusy] = React.useState(false);

    const send = async () => {
      const text = input.trim();
      if (!text || busy) return;
      const now = Date.now();
      addMessage(contact.id, { id: now.toString(), from: "me", text, ts: now });
      setMessages([...getMessages(contact.id)]);
      setInput("");
      setBusy(true);
      try {
        const keys = getKeys();
        if (!keys.length) { showToast("Add a Groq API key in settings"); return; }
        const system = (storage.systemPrompt || "You are roleplaying as {name} in a Discord DM.").replace("{name}", contact.username || "the user");
        const history = getMessages(contact.id).slice(-10);
        const msgs = [{ role: "system", content: system }];
        for (const m of history) msgs.push({ role: m.from === "me" ? "user" : "assistant", content: m.text });
        msgs.push({ role: "user", content: text });
        const res = await fetch(GROQ_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + keys[0] },
          body: JSON.stringify({ model: storage.model || DEFAULT_MODEL, temperature: 0.8, max_completion_tokens: 512, messages: msgs }),
        });
        const data = await res.json();
        const reply = data?.choices?.[0]?.message?.content?.trim() || "AI error";
        addMessage(contact.id, { id: (Date.now()+1).toString(), from: "them", text: reply, ts: Date.now() });
        setMessages([...getMessages(contact.id)]);
      } catch (e) { showToast("AI error"); }
      finally { setBusy(false); }
    };

    return h(
      View,
      { style: { flex: 1, backgroundColor: "#313338" } },
      h(ScrollView, { contentContainerStyle: { padding: 12 } },
        messages.map((m) => h(Text, { key: m.id, style: { color: m.from === "me" ? "#00a8fc" : "#dbdee1", marginBottom: 8 } }, (m.from === "me" ? "You: " : (contact.username || "Them") + ": ") + m.text))
      ),
      h(View, { style: { flexDirection: "row", padding: 10, backgroundColor: "#2b2d31" } },
        h(TextInput, { value: input, onChangeText: setInput, placeholder: "Message " + (contact.username || "user"), placeholderTextColor: "#80848e", style: { flex: 1, backgroundColor: "#383a40", color: "#fff", borderRadius: 8, padding: 10, marginRight: 8 } }),
        h(TouchableOpacity, { onPress: send, disabled: busy, style: { backgroundColor: busy ? "#4e5058" : "#5865f2", borderRadius: 8, paddingHorizontal: 16, justifyContent: "center" } },
          h(Text, { style: { color: "#fff", fontWeight: "700" } }, busy ? "..." : "Send")
        )
      )
    );
  }

  // ---------- Settings ----------
  function SettingsPage() {
    useProxy(storage);
    const { View, Text, TextInput, TouchableOpacity, ScrollView } = RN;
    const [newKey, setNewKey] = React.useState("");
    const keys = Array.isArray(storage.apiKeys) ? storage.apiKeys : [];
    const addKey = () => {
      const k = newKey.trim();
      if (!k.startsWith("gsk_")) return showToast("Key must start with gsk_");
      const list = Array.isArray(storage.apiKeys) ? storage.apiKeys : [];
      const nextId = list.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
      storage.apiKeys = list.concat([{ id: nextId, key: k }]);
      setNewKey("");
      showToast("Key added");
    };
    return h(
      ScrollView,
      { style: { flex: 1, backgroundColor: "#313338" }, contentContainerStyle: { padding: 16 } },
      h(Text, { style: { color: "#fff", fontSize: 20, fontWeight: "700", marginBottom: 16 } }, "Simulate DM Settings"),
      h(TouchableOpacity, { onPress: () => openCustomPage("Simulate DMs", ContactManager), style: { backgroundColor: "#5865f2", borderRadius: 8, padding: 14, alignItems: "center", marginBottom: 24 } },
        h(Text, { style: { color: "#fff", fontWeight: "700" } }, "Open Simulated DMs")
      ),
      h(Text, { style: { color: "#80848e", fontWeight: "700", marginBottom: 8 } }, "GROQ API KEYS"),
      keys.map((k) => h(Text, { key: k.id, style: { color: "#fff", marginBottom: 4 } }, "#" + k.id + "  " + k.key.slice(0, 8) + "...")),
      h(TextInput, { value: newKey, onChangeText: setNewKey, placeholder: "gsk_...", placeholderTextColor: "#80848e", autoCapitalize: "none", style: { backgroundColor: "#2b2d31", color: "#fff", borderRadius: 8, padding: 12, marginBottom: 8 } }),
      h(TouchableOpacity, { onPress: addKey, style: { backgroundColor: "#248046", borderRadius: 8, padding: 12, alignItems: "center" } },
        h(Text, { style: { color: "#fff", fontWeight: "700" } }, "Add API Key")
      )
    );
  }

  function patchSettings() {
    const settingConstants = metro.findByProps("SETTING_RENDERER_CONFIG");
    if (!settingConstants) return;
    const SETTINGS_KEY = "FAKE_DM_SIM";
    const row = {};
    row[SETTINGS_KEY] = { type: "pressable", title: () => "Simulate DM", useTitle: () => "Simulate DM", usePredicate: () => true, onPress: () => openCustomPage("Simulate DM Settings", SettingsPage), withArrow: true };
    let value = settingConstants.SETTING_RENDERER_CONFIG;
    try {
      Object.defineProperty(settingConstants, "SETTING_RENDERER_CONFIG", { enumerable: true, configurable: true, get: () => Object.assign({}, value, row), set: (v) => { value = v; } });
    } catch (e) { if (value && !value[SETTINGS_KEY]) value[SETTINGS_KEY] = row[SETTINGS_KEY]; }
    const createList = metro.findByProps("createList");
    if (createList?.createList) {
      unpatches.push(after("createList", createList, (args) => {
        try {
          const sections = args?.[0]?.sections;
          if (!Array.isArray(sections)) return;
          const section = sections.find((s) => s && ["Bunny", "Kettu", "Revenge"].includes(s.label));
          if (section && Array.isArray(section.settings) && !section.settings.includes(SETTINGS_KEY)) section.settings.push(SETTINGS_KEY);
          else if (sections.some((s) => s?.settings?.includes("ACCOUNT"))) sections.unshift({ label: "Simulate DM", title: "Simulate DM", settings: [SETTINGS_KEY] });
        } catch (e) {}
      }));
    }
  }

  function onLoad() {
    if (!Array.isArray(storage.apiKeys)) storage.apiKeys = [];
    if (!storage.contacts) storage.contacts = [];
    if (!storage.messages) storage.messages = {};
    if (typeof storage.systemPrompt !== "string") storage.systemPrompt = "You are roleplaying as {name} in a Discord DM. Reply naturally and casually in character.";
    try { patchSearchButton(); } catch (e) { log("search button patch failed", e); }
    try { patchSettings(); } catch (e) { log("settings patch failed", e); }
  }

  function onUnload() {
    while (unpatches.length) { try { unpatches.pop()(); } catch (e) {} }
  }

  return { onLoad, onUnload, settings: SettingsPage };
})();
