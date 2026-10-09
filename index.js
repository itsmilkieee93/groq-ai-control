(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Vendetta / Kettu globals
  // ---------------------------------------------------------------------------
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

  const REWRITE_RULES =
    "You rewrite the user's chat message. Keep the original meaning, language, and emojis. " +
    "Return ONLY the rewritten message, with no quotes, labels, or explanations.";

  const ANSWER_RULES =
    "The user's text is a chat message they are about to send. " +
    "If it is a question or request that has an objective answer you can give (math, facts, translations, " +
    "definitions, or things like 'say hi in Japanese'), do NOT repeat it: write the final answer itself as the " +
    "chat message, short and ready to send, and compute math carefully. " +
    "If it is ordinary conversation, or a question aimed at another person (their plans, feelings, opinions, " +
    "availability), just rewrite it and keep its meaning. " +
    "Return ONLY the message to send, with no quotes, labels, or explanations.";

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
    return rules + "\n\n" + baseline;
  }

  // Selectable chip row used by the settings page
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

  // Texts we already produced ourselves; the send hook lets them through untouched
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

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // Metro modules (resolved lazily so a miss never crashes the plugin)
  // ---------------------------------------------------------------------------
  const ChatInputModule = metro.findByProps("handleSendMessage", "changeText");
  const TypingModule = metro.findByProps("sendTyping", "startTyping");
  const MessageModules = metro.findByProps("sendMessage", "receiveMessage");
  const SelectedChannelStore = metro.findByStoreName ? metro.findByStoreName("SelectedChannelStore") : null;

  const NavModule = metro.findByProps("Navigation");
  const Navigation = (NavModule && NavModule.Navigation) || NavModule;
  const FormRowModule = metro.findByProps("FormRow");
  const FormRow = (FormRowModule && FormRowModule.FormRow) || FormRowModule;

  // ---------------------------------------------------------------------------
  // Groq networking with rotating API keys
  // ---------------------------------------------------------------------------
  async function callGroq(apiKey, text) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 20000) : null;
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
            { role: "system", content: buildSystemPrompt() },
            { role: "user", content: text },
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
      return out;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Tries each key in order. 429 / any network or API error -> next key.
  // All keys failed (or none set) -> original text is returned untouched.
  async function rewriteText(text) {
    const keys = getKeys();
    for (let i = 0; i < keys.length; i++) {
      try {
        return await callGroq(keys[i], text);
      } catch (e) {
        log("key #" + (i + 1) + " failed:", e && (e.status || e.message));
      }
    }
    return text;
  }

  // ---------------------------------------------------------------------------
  // Typing indicator loop (re-sent every 8 seconds)
  // ---------------------------------------------------------------------------
  function startTypingLoop(channelId) {
    if (!channelId || !TypingModule || typeof TypingModule.sendTyping !== "function") return () => {};
    const ping = () => { try { TypingModule.sendTyping(channelId); } catch (e) {} };
    ping();
    const id = setInterval(ping, 8000);
    return () => clearInterval(id);
  }

  // ---------------------------------------------------------------------------
  // Chat input interception
  // ---------------------------------------------------------------------------
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

  // Rewrites/answers `original`, shows the typing indicator, waits the typing delay.
  // Always resolves with text to send (the original text if everything fails).
  async function produceFinalText(original, channelId) {
    const stopTyping = startTypingLoop(channelId);
    let finalText = original;
    try {
      finalText = await rewriteText(original);
      const delay = getTypingMs();
      if (delay > 0) await sleep(delay);
    } catch (e) {
      finalText = original;
    } finally {
      stopTyping();
    }
    markOutput(finalText);
    return finalText;
  }

  // Primary auto-rewrite hook: every message the chat box sends goes through sendMessage.
  // `instead` + a returned promise holds the send until the AI text is ready, in order.
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
          if (!content.trim() || content.trim().startsWith("/") || getKeys().length === 0 || consumeMark(content)) {
            return orig(...args);
          }
          const channelId = args[0];
          const job = async () => {
            const finalText = await produceFinalText(content, channelId);
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

  // Fallback hook, only used when sendMessage cannot be patched.
  function patchChatInput() {
    if (!ChatInputModule || typeof ChatInputModule.handleSendMessage !== "function") {
      log("ChatInputModule.handleSendMessage not found");
      return;
    }
    // NOTE: `instead` is used (not plain `before`) because the rewrite is asynchronous:
    // the original send must be held back until Groq answers, then released.
    unpatches.push(
      instead("handleSendMessage", ChatInputModule, function (args, orig) {
        if (bypass || !storage.autoRewrite || inFlight) {
          if (inFlight && !bypass) return; // swallow double-taps while rewriting
          return orig(...args);
        }

        const slot = findTextSlot(args);
        const original = slot ? String(slot.get() || "") : "";
        if (!slot || !original.trim() || original.trim().startsWith("/") || getKeys().length === 0) {
          return orig(...args);
        }

        const channelId = findChannelId(args);
        inFlight = true;

        (async () => {
          const stopTyping = startTypingLoop(channelId);
          let finalText = original;
          try {
            finalText = await rewriteText(original);
            const delay = getTypingMs();
            if (delay > 0) await sleep(delay);
          } catch (e) {
            finalText = original;
          } finally {
            stopTyping();
          }

          try {
            if (typeof ChatInputModule.changeText === "function") ChatInputModule.changeText(finalText);
          } catch (e) {}

          try {
            slot.set(finalText);
            bypass = true;
            orig(...args);
          } catch (e) {
            log("send failed, retrying with original text", e && e.message);
            try { slot.set(original); orig(...args); } catch (e2) {}
          } finally {
            bypass = false;
            inFlight = false;
          }
        })();
        // original call is held back; it is released above after rewriting
      })
    );
  }

  // ---------------------------------------------------------------------------
  // Manual /groq command
  // ---------------------------------------------------------------------------
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

        const stopTyping = startTypingLoop(channelId);
        let finalText = original;
        try {
          finalText = await rewriteText(original);
          const delay = getTypingMs();
          if (delay > 0) await sleep(delay);
        } catch (e) {
          finalText = original;
        } finally {
          stopTyping();
        }

        try {
          markOutput(finalText);
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

  // ---------------------------------------------------------------------------
  // Settings page component
  // ---------------------------------------------------------------------------
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
        h(Text, { style: { color: C.text, fontSize: 15, flex: 1, paddingRight: 12 } }, "Otomatis Tulis Ulang Semua Chat (Tanpa /groq)"),
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
        h(Text, { style: { color: C.text, fontSize: 15, flex: 1, paddingRight: 12 } }, "Jawab Soal / Pertanyaan Otomatis (matematika, terjemahan, dll)"),
        h(Switch, {
          value: storage.answerQuestions !== false,
          onValueChange: (v) => { storage.answerQuestions = v; },
          trackColor: { false: "#4e5058", true: C.accent },
        })
      ),

      // Typing duration
      h(
        View,
        { style: card },
        h(Text, { style: title }, "Typing Duration (detik)"),
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
          ? h(Text, { style: { color: C.muted, marginBottom: 10 } }, "Belum ada API key.")
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

  // ---------------------------------------------------------------------------
  // Settings screen integration
  // ---------------------------------------------------------------------------
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

  // Depth-first search for an array containing an element whose label matches `anchor`
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

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------
  function onLoad() {
    if (!Array.isArray(storage.apiKeys)) storage.apiKeys = [];
    if (typeof storage.autoRewrite !== "boolean") storage.autoRewrite = false;
    if (typeof storage.answerQuestions !== "boolean") storage.answerQuestions = true;
    if (storage.typingDuration == null) storage.typingDuration = 3;
    if (!PERSONALITY_OPTIONS.includes(storage.personality)) storage.personality = "Casual/Slang";
    if (typeof storage.customPrompt !== "string") storage.customPrompt = "";
    if (!MODELS.includes(storage.model)) storage.model = DEFAULT_MODEL;

    try { patchSettingsScreen(); } catch (e) { log("settings patch error", e && e.message); }
    try {
      if (!patchSendMessage()) patchChatInput();
    } catch (e) { log("input patch error", e && e.message); }
    try { registerGroqCommand(); } catch (e) { log("command error", e && e.message); }
  }

  function onUnload() {
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
