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
  const logBuffer = [];

  // ---------- Storage & Logging helpers ----------
  function getContacts() {
    if (!Array.isArray(storage.contacts)) storage.contacts = [];
    return storage.contacts;
  }
  function saveContact(contact) {
    const list = getContacts();
    const idx = list.findIndex((c) => c.discordId === contact.discordId);
    if (idx >= 0) list[idx] = Object.assign({}, list[idx], contact);
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
    storage.messages = Object.assign({}, storage.messages);
  }
  function getKeys() {
    const list = Array.isArray(storage.apiKeys) ? storage.apiKeys : [];
    return list.map((k) => (k && typeof k.key === "string" ? k.key.trim() : "")).filter(Boolean);
  }
  function log(...args) {
    const line = "[" + new Date().toISOString() + "] " + args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ");
    logBuffer.push(line);
    if (logBuffer.length > 500) logBuffer.shift();
    try { console.log("[FakeDM]", ...args); } catch (e) {}
  }

  // ---------- Groq AI Engine ----------
  async function callGroq(apiKey, userText, contact, history) {
    const system = (storage.systemPrompt || "You are roleplaying as {name} in a Discord DM. Reply naturally, casually, and in character.").replace("{name}", contact.username || "the user");
    const messages = [{ role: "system", content: system }];
    const recent = history.slice(-12);
    for (const m of recent) {
      messages.push({ role: m.from === "me" ? "user" : "assistant", content: m.text });
    }
    messages.push({ role: "user", content: userText });

    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify({ model: storage.model || DEFAULT_MODEL, temperature: 0.8, max_completion_tokens: 512, messages }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || "";
  }

  async function triggerAIReply(userText, contactId, channelId) {
    const contact = getContacts().find(c => c.discordId === contactId);
    if (!contact) return;
    
    const keys = getKeys();
    if (!keys.length) return;

    try {
      const replyText = await callGroq(keys[0], userText, contact, getMessages(contactId));
      if (!replyText) return;

      // Inject reply back through Discord's native UI action handlers
      const MessageActions = metro.findByProps("sendMessage", "receiveMessage") || metro.common?.messages;
      if (MessageActions && (MessageActions.receiveMessage || MessageActions.handleNewMessage)) {
        const mockMsg = {
          id: Date.now().toString(),
          channel_id: channelId,
          content: replyText,
          author: {
            id: contactId,
            username: contact.username,
            avatar: contact.avatarRaw || "0",
            discriminator: "0000",
            global_name: contact.username
          },
          timestamp: new Date().toISOString()
        };
        
        if (MessageActions.receiveMessage) MessageActions.receiveMessage(channelId, mockMsg);
        else MessageActions.handleNewMessage(channelId, mockMsg);

        addMessage(contactId, { from: "them", text: replyText });
      }
    } catch (e) { log("AI Native Reply Error:", e.message); }
  }

  // ---------- Native UI Message Interceptor ----------
  function patchNativeMessageSending() {
    const MessageActions = metro.findByProps("sendMessage", "cancelMessage") || metro.common?.messages;
    if (!MessageActions) return;

    unpatches.push(
      after("sendMessage", MessageActions, (args) => {
        try {
          const channelId = args[0];
          const msgObj = args[1];
          const textContent = msgObj?.content;

          const activeContact = getContacts().find(c => c.simulationChannelId === channelId);
          if (activeContact && textContent) {
            addMessage(activeContact.discordId, { from: "me", text: textContent });
            
            setTimeout(() => {
              triggerAIReply(textContent, activeContact.discordId, channelId);
            }, 1200);
          }
        } catch (e) { log("Error intercepting native message send:", e); }
      })
    );
  }

  // ---------- Settings Page ----------
  function openCustomPage(title, render) {
    try {
      const navMod = metro.findByProps("getRootNavigationRef");
      const ref = navMod?.getRootNavigationRef?.();
      if (ref?.navigate) { ref.navigate("VendettaCustomPage", { title, render }); return; }
    } catch (e) {}
    showToast("Could not open page");
  }

  function SettingsPage() {
    useProxy(storage);
    const { View, Text, TextInput, TouchableOpacity, ScrollView } = RN;
    const [newKey, setNewKey] = React.useState("");
    const keys = Array.isArray(storage.apiKeys) ? storage.apiKeys : [];

    return h(ScrollView, { style: { flex: 1, backgroundColor: "#1e1f22" }, contentContainerStyle: { padding: 16 } },
      h(Text, { style: { color: "#fff", fontSize: 20, fontWeight: "700", marginBottom: 16 } }, "Simulate DM Native Core"),
      h(Text, { style: { color: "#b5bac1", fontWeight: "700", marginBottom: 8 } }, "GROQ API KEY"),
      keys.map(k => h(View, { key: k.id, style: { flexDirection: "row", alignItems: "center", backgroundColor: "#2b2d31", padding: 12, borderRadius: 8, marginBottom: 8 } },
        h(Text, { style: { color: "#fff", flex: 1 } }, k.key.slice(0, 15) + "..."),
        h(TouchableOpacity, { onPress: () => { storage.apiKeys = keys.filter(x => x.id !== k.id); }, style: { backgroundColor: "#da373c", padding: 6, borderRadius: 4 } }, h(Text, { style: { color: "#fff" } }, "Delete"))
      )),
      h(TextInput, { value: newKey, onChangeText: setNewKey, placeholder: "gsk_...", placeholderTextColor: "#949ba4", style: { backgroundColor: "#2b2d31", color: "#fff", padding: 12, borderRadius: 8, marginBottom: 8 } }),
      h(TouchableOpacity, { onPress: () => { if (newKey.trim().startsWith("gsk_")) { storage.apiKeys = keys.concat([{ id: Date.now(), key: newKey.trim() }]); setNewKey(""); } }, style: { backgroundColor: "#248046", padding: 12, borderRadius: 8, alignItems: "center" } }, h(Text, { style: { color: "#fff", fontWeight: "700" } }, "Save API Key"))
    );
  }

  // ---------- Patch Profile Overflow Menu ----------
  function patchUserProfileMenu() {
    const ActionMod = metro.findByProps("showUserProfileOverflowMenu") || metro.findByProps("openUserProfileRow");
    if (!ActionMod) return;

    unpatches.push(
      after(ActionMod.showUserProfileOverflowMenu ? "showUserProfileOverflowMenu" : "default", ActionMod, (args, ret) => {
        try {
          const user = args[0]?.user || args[0]?.displayProfile?.user;
          if (!user || !user.id) return ret;

          const findInReactTree = vendetta.utils?.findInReactTree;
          if (!findInReactTree) return ret;

          const sheet = findInReactTree(ret, (node) => Array.isArray(node?.props?.items));
          if (!sheet) return ret;

          const items = sheet.props.items;
          if (items.some(i => i?.label === "Simulate DM")) return ret;

          items.push({
            label: "Simulate DM",
            action: () => {
              const username = user.globalName || user.global_name || user.username || "User";
              const mockChannelId = "9999" + user.id.slice(-14);

              const contact = {
                discordId: user.id,
                username: username,
                avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : "https://cdn.discordapp.com/embed/avatars/0.png",
                avatarRaw: user.avatar || "0",
                simulationChannelId: mockChannelId
              };
              saveContact(contact);

              const NavigationRouter = metro.findByProps("transitionToGuild", "selectChannel") || metro.findByProps("ns");
              if (NavigationRouter && NavigationRouter.selectChannel) {
                NavigationRouter.selectChannel({
                  channelId: mockChannelId,
                  guildId: null,
                  silent: false
                });
                showToast("Switched to native UI channel for: " + username);
              } else {
                showToast("Failed to route navigation to native channel");
              }
            }
          });
        } catch (e) { log("Profile sheet manipulation failed", e); }
        return ret;
      })
    );
  }

  // ---------- Load & Unload ----------
  function onLoad() {
    if (!Array.isArray(storage.apiKeys)) storage.apiKeys = [];
    if (!storage.contacts) storage.contacts = [];
    if (!storage.messages) storage.messages = {};
    
    log("Plugin loaded using Discord native messaging UI layouts.");
    try { patchUserProfileMenu(); } catch (e) { log("Profile patch crash", e); }
    try { patchNativeMessageSending(); } catch (e) { log("Native send intercept crash", e); }
  }

  function onUnload() {
    while (unpatches.length) { try { unpatches.pop()(); } catch (e) {} }
  }

  return { onLoad, onUnload, settings: SettingsPage };
})();
