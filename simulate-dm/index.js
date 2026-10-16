(function () {
  "use strict";

  const { storage } = vendetta.plugin;
  const { after } = vendetta.patcher;
  const metro = vendetta.metro;
  const { React, ReactNative: RN } = metro.common;
  const h = React.createElement;
  const { showToast } = vendetta.ui.toasts;
  const { useProxy } = vendetta.storage;
  const { findInReactTree } = vendetta.utils || {};

  const unpatches = [];
  const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
  const DEFAULT_MODEL = "openai/gpt-oss-120b";

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

  function avatarUrlFor(user) {
    if (user && user.id && user.avatar) {
      return "https://cdn.discordapp.com/avatars/" + user.id + "/" + user.avatar + ".png?size=128";
    }
    return "https://cdn.discordapp.com/embed/avatars/0.png";
  }
  function displayNameOf(user) {
    return (user && (user.globalName || user.global_name || user.username)) || "User";
  }

  function openPage(title, renderFn) {
    try {
      const navMod = metro.findByProps("getRootNavigationRef");
      const ref = navMod?.getRootNavigationRef?.();
      if (ref?.navigate) {
        ref.navigate("VendettaCustomPage", { title, render: renderFn });
        return true;
      }
    } catch (e) {}
    try {
      const Navigation = metro.findByProps("Navigation")?.Navigation;
      if (Navigation?.push) {
        Navigation.push("VendettaCustomPage", { title, render: renderFn });
        return true;
      }
    } catch (e) {}
    showToast("Could not open page");
    return false;
  }

  function openChat(contact) {
    openPage(contact.username || "Chat", () => h(FakeChatScreen, { contact }));
  }

  function openSettings() {
    openPage("Simulate DM Settings", SettingsPage);
  }

  function patchUserProfileMenu() {
    const NAMES = ["UserProfileOverflowMenu", "BotUserProfileOverflowMenu"];

    function getMainItems(ret) {
      let items = ret?.props?.items;
      if (Array.isArray(items) && Array.isArray(items[0])) return items[0];
      items = ret?.props?.children?.props?.items;
      if (Array.isArray(items) && Array.isArray(items[0])) return items[0];
      if (findInReactTree) {
        const node = findInReactTree(ret, (n) => Array.isArray(n?.props?.items) && Array.isArray(n.props.items[0]));
        return node?.props?.items?.[0] ?? null;
      }
      return null;
    }

    function patchFn(args, ret) {
      try {
        const props = args[0] || {};
        const user = props.user || props.displayProfile?.user;
        if (!user || !user.id) return;
        const items = getMainItems(ret);
        if (!items || items.some((i) => i?.label === "Simulate DM")) return;

        items.push({
          label: "Simulate DM",
          action: () => {
            const username = displayNameOf(user);
            const avatar = avatarUrlFor(user);
            let contact = getContacts().find((c) => c.discordId === user.id);
            if (!contact) {
              contact = { id: Date.now().toString(), discordId: user.id, username: username, avatar: avatar };
              saveContact(contact);
              showToast("Contact created: " + username);
            } else {
              contact.username = username;
              contact.avatar = avatar;
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
        if (mod) unpatches.push(after("default", mod, patchFn));
      } catch (e) {}
    }
  }

  function FakeChatScreen({ contact }) {
    const { View, Text, ScrollView, TextInput, TouchableOpacity, Image, KeyboardAvoidingView, Platform } = RN;
    const [messages, setMessages] = React.useState(() => getMessages(contact.id).slice(-50));
    const [input, setInput] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const scrollRef = React.useRef(null);

    const send = async () => {
      const text = input.trim();
      if (!text || busy) return;
      const now = Date.now();
      addMessage(contact.id, { id: now.toString(), from: "me", text, ts: now });
      setMessages(getMessages(contact.id).slice(-50));
      setInput("");
      setBusy(true);
      try {
        const keys = getKeys();
        if (!keys.length) { showToast("Add a Groq API key in settings first"); return; }
        const system = (storage.systemPrompt || "You are roleplaying as {name} in a Discord DM. Reply naturally and casually.").replace("{name}", contact.username || "the user");
        const history = getMessages(contact.id).slice(-8);
        const msgs = [{ role: "system", content: system }];
        for (const m of history) msgs.push({ role: m.from === "me" ? "user" : "assistant", content: m.text });
        msgs.push({ role: "user", content: text });
        const res = await fetch(GROQ_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + keys[0] },
          body: JSON.stringify({ model: storage.model || DEFAULT_MODEL, temperature: 0.8, max_completion_tokens: 256, messages: msgs }),
        });
        const data = await res.json();
        const reply = data?.choices?.[0]?.message?.content?.trim() || "AI error";
        addMessage(contact.id, { id: (Date.now() + 1).toString(), from: "them", text: reply, ts: Date.now() });
        setMessages(getMessages(contact.id).slice(-50));
      } catch (e) { showToast("AI error"); }
      finally { setBusy(false); }
    };

    React.useEffect(() => {
      const t = setTimeout(() => scrollRef.current?.scrollToEnd?.({ animated: true }), 80);
      return () => clearTimeout(t);
    }, [messages]);

    return h(
      KeyboardAvoidingView,
      { style: { flex: 1, backgroundColor: "#313338" }, behavior: Platform.OS === "ios" ? "padding" : "height" },
      h(ScrollView, { ref: scrollRef, style: { flex: 1 }, contentContainerStyle: { padding: 12, paddingBottom: 8 }, keyboardShouldPersistTaps: "handled" },
        messages.length === 0
          ? h(Text, { style: { color: "#80848e", textAlign: "center", marginTop: 60 } }, "No messages yet")
          : messages.map((m) => h(View, { key: m.id, style: { flexDirection: "row", marginBottom: 12, alignItems: "flex-start" } },
              m.from !== "me" ? h(Image, { source: { uri: contact.avatar }, style: { width: 40, height: 40, borderRadius: 20, marginRight: 12 } }) : h(View, { style: { width: 52 } }),
              h(View, { style: { flex: 1 } },
                h(View, { style: { flexDirection: "row", alignItems: "baseline" } },
                  h(Text, { style: { color: m.from === "me" ? "#00a8fc" : "#dbdee1", fontWeight: "600", fontSize: 16 } }, m.from === "me" ? "You" : contact.username),
                  h(Text, { style: { color: "#80848e", fontSize: 12, marginLeft: 8 } }, new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))
                ),
                h(Text, { style: { color: "#dbdee1", fontSize: 16, marginTop: 2 } }, m.text)
              )
            ))
      ),
      h(View, { style: { flexDirection: "row", paddingHorizontal: 12, paddingVertical: 8, backgroundColor: "#313338", borderTopWidth: 1, borderTopColor: "#1e1f22", alignItems: "center" } },
        h(TextInput, { value: input, onChangeText: setInput, placeholder: "Message @" + (contact.username || "user"), placeholderTextColor: "#80848e", style: { flex: 1, backgroundColor: "#383a40", color: "#fff", borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, marginRight: 8, maxHeight: 100 }, multiline: true }),
        h(TouchableOpacity, { onPress: send, disabled: busy || !input.trim(), style: { backgroundColor: busy || !input.trim() ? "#4e5058" : "#5865f2", borderRadius: 20, paddingHorizontal: 18, paddingVertical: 10 } },
          h(Text, { style: { color: "#fff", fontWeight: "700" } }, busy ? "..." : "Send")
        )
      )
    );
  }

  function SettingsPage() {
    useProxy(storage);
    const { View, Text, TextInput, TouchableOpacity, ScrollView } = RN;
    const [newKey, setNewKey] = React.useState("");
    const keys = Array.isArray(storage.apiKeys) ? storage.apiKeys : [];
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
    const removeKey = (id) => { storage.apiKeys = (storage.apiKeys || []).filter((x) => x.id !== id); };
    return h(ScrollView, { style: { flex: 1, backgroundColor: "#313338" }, contentContainerStyle: { padding: 16 } },
      h(Text, { style: { color: "#fff", fontSize: 20, fontWeight: "700", marginBottom: 8 } }, "Simulate DM"),
      h(Text, { style: { color: "#80848e", marginBottom: 20 } }, "Profile \u2192 \u2022\u2022\u2022 \u2192 Simulate DM"),
      h(Text, { style: { color: "#b5bac1", fontWeight: "700", marginBottom: 8 } }, "API KEYS"),
      keys.length === 0 ? h(Text, { style: { color: "#80848e", marginBottom: 12 } }, "None added") : keys.map((k) => h(View, { key: k.id, style: { flexDirection: "row", alignItems: "center", backgroundColor: "#2b2d31", borderRadius: 8, padding: 12, marginBottom: 8 } },
        h(Text, { style: { color: "#fff", flex: 1 } }, "#" + k.id + "  " + k.key.slice(0, 6) + "..." + k.key.slice(-4)),
        h(TouchableOpacity, { onPress: () => removeKey(k.id), style: { paddingHorizontal: 10 } }, h(Text, { style: { color: "#da373c", fontWeight: "700" } }, "\u2715"))
      )),
      h(TextInput, { value: newKey, onChangeText: setNewKey, placeholder: "gsk_...", placeholderTextColor: "#80848e", autoCapitalize: "none", style: { backgroundColor: "#2b2d31", color: "#fff", borderRadius: 8, padding: 12, marginBottom: 8 } }),
      h(TouchableOpacity, { onPress: addKey, style: { backgroundColor: "#248046", borderRadius: 8, padding: 14, alignItems: "center" } },
        h(Text, { style: { color: "#fff", fontWeight: "700" } }, "Add Key")
      )
    );
  }

  function patchSettings() {
    const settingConstants = metro.findByProps("SETTING_RENDERER_CONFIG");
    if (!settingConstants) return;
    const SETTINGS_KEY = "FAKE_DM_SIM";
    const row = {};
    row[SETTINGS_KEY] = { type: "pressable", title: () => "Simulate DM", useTitle: () => "Simulate DM", usePredicate: () => true, onPress: openSettings, withArrow: true };
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
    try { patchSettings(); } catch (e) {}
    try { patchUserProfileMenu(); } catch (e) {}
  }

  function onUnload() {
    while (unpatches.length) { try { unpatches.pop()(); } catch (e) {} }
  }

  return { onLoad, onUnload, settings: SettingsPage };
})();
