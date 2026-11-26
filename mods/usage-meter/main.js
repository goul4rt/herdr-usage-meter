import { View, div, image, svg } from "gpui-kit";
import { Input, InputState, Scrollbar, h_flex, v_flex } from "gpui-base";
import {
  agents,
  appHome,
  checking,
  closeOverlay,
  exec,
  keys,
  layout,
  nextCommand,
  notify,
  openOverlay,
  props,
  readTextFile,
  run,
  shared,
  setShared,
  spaces,
  theme,
  window,
} from "herdr";
import { LANGUAGES, resolveLang, tr } from "./i18n.js";

const STATE_KEY = "usage.meter.state";
const PREFS_KEY = "usage.meter.prefs";
const CACHE_KEY = "usage.meter.cache";
const SESSION_BOOT_KEY = "usage.meter.booted";
const SYS_POLL_MS = 120_000;
const MIN_MANUAL_GAP_MS = 5_000;

const PROFILE_ICONS = [
  { id: "icons/claude.svg", label: "Claude" },
  { id: "icons/hermes.svg", label: "Hermes" },
  { id: "icons/kiro.svg", label: "Kiro" },
  { id: "icons/agent.svg", label: "Agent" },
  { id: "icons/dsh-tui.svg", label: "DeepSeek" },
  { id: "icons/copilot.svg", label: "Copilot" },
  { id: "icons/goose.svg", label: "Goose" },
  { id: "icons/pi.svg", label: "Pi" },
  { id: "icons/antigravity.svg", label: "Agy" },
  { id: "icons/codex.svg", label: "Codex" },
  { id: "icons/opencode.svg", label: "OpenCode" },
  { id: "icons/gemini.svg", label: "Gemini" },
  { id: "icons/kimi.svg", label: "Kimi" },
  { id: "icons/grok.svg", label: "Grok" },
  { id: "icons/cursor.svg", label: "Cursor" },
  { id: "mods/workspace-chrome/terminal.svg", label: "Terminal" },
  { id: "mods/workspace-chrome/server.svg", label: "Server" },
];

const DEFAULT_PROVIDERS = {
  claude: true,
  harness: true,
  antigravity: true,
  codex: true,
  opencode: true,
  gemini: false,
  kimi: false,
  grok: false,
  cursor: false,
  ports: true,
  system: true,
};

const DEFAULT_PREFS = {
  prefsVersion: 2,
  language: "auto",
  displayMode: "used",
  detailMode: "detailed",
  defaultPeriod: "today",
  period: null,
  pollMinutes: 15,
  alwaysStartCollapsed: true,
  barCollapsed: true,
  showEstimatedCost: true,
  showCostInPopover: false,
  showCostInSidebar: false,
  showBarActions: false,
  showBarsInSidebar: true,
  showResetInSidebar: true,
  showExtraProfilesInBar: true,
  showHarnessInBar: true,
  showCodexInBar: true,
  showOpencodeInBar: true,
  showCpuInBar: false,
  showPortsInBar: false,
  showChipsInSidebar: true,
  hideUnauthProfiles: true,
  sidebarCollapsed: false,
  tab: "overview",
  overviewScope: "all",
  portsFilter: "local",
  providers: DEFAULT_PROVIDERS,
  profileCustom: {},
};

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

const isSidebarNarrow = () => (findNode(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

function readPrefs() {
  let raw = shared(PREFS_KEY);
  if (!raw || typeof raw !== "object") {
    try {
      raw = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
    } catch {
      raw = null;
    }
  }
  const hasV2 = raw && typeof raw === "object" && (raw.prefsVersion ?? 0) >= 2;
  const hasV3 = raw && typeof raw === "object" && (raw.prefsVersion ?? 0) >= 3;
  const merged = {
    ...DEFAULT_PREFS,
    ...(raw && typeof raw === "object" ? raw : {}),
    ...(!hasV2
      ? {
          prefsVersion: 3,
          pollMinutes: 15,
          alwaysStartCollapsed: true,
          barCollapsed: true,
          showCostInSidebar: false,
          showBarActions: false,
          showCpuInBar: false,
          showPortsInBar: false,
          showEstimatedCost: true,
          showCostInPopover: false,
        }
      : !hasV3
        ? {
            prefsVersion: 3,
            showEstimatedCost: true,
            showCostInPopover: false,
          }
        : {}),
    providers: {
      ...DEFAULT_PROVIDERS,
      ...(raw?.providers && typeof raw.providers === "object" ? raw.providers : {}),
    },
    profileCustom:
      raw?.profileCustom && typeof raw.profileCustom === "object" ? raw.profileCustom : {},
  };
  if (raw && !hasV3) {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(merged));
    } catch {}
    setShared(PREFS_KEY, merged);
  }
  return merged;
}

function patchPrefs(patch) {
  const cur = readPrefs();
  const next = {
    ...cur,
    ...patch,
    prefsVersion: 3,
    providers: patch.providers ? { ...cur.providers, ...patch.providers } : cur.providers,
    profileCustom: patch.profileCustom ?? cur.profileCustom ?? {},
  };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {}
  setShared(PREFS_KEY, next);
}

function profileMeta(cp, prefs) {
  const custom = prefs?.profileCustom?.[cp?.profile] || {};
  const defaultIcon =
    cp?.defaultIcon ||
    (cp?.kind === "harness" ? "icons/hermes.svg" : "icons/claude.svg");
  return {
    label: (custom.alias || "").trim() || cp?.label || cp?.profile || "Claude",
    icon: custom.icon || defaultIcon,
    hidden: custom.hidden === true,
    showInBar: custom.showInBar !== false,
  };
}

function formatResetShort(resetsAt, now, L) {
  if (!resetsAt) return "";
  const diff = Math.max(0, resetsAt - now);
  if (diff < 60_000) return L.resetsNow;
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remM = mins % 60;
  if (hrs < 24) return remM > 0 ? `${hrs}h ${remM}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const remH = hrs % 24;
  return remH > 0 ? `${days}d ${remH}h` : `${days}d`;
}

function formatResetLong(resetsAt, now, L) {
  if (!resetsAt) return "";
  const diff = Math.max(0, resetsAt - now);
  if (diff < 60_000) return `${L.resetsIn} ${L.soon}`;
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${L.resetsIn} ${mins} min`;
  const hrs = Math.floor(mins / 60);
  const remM = mins % 60;
  if (hrs < 24) return remM > 0 ? `${L.resetsIn} ${hrs} h ${remM} min` : `${L.resetsIn} ${hrs} h`;
  const days = Math.floor(hrs / 24);
  const remH = hrs % 24;
  return remH > 0 ? `${L.resetsIn} ${days} d ${remH} h` : `${L.resetsIn} ${days} d`;
}

function fmtUsd(val) {
  const n = Number(val) || 0;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

function pctColor(usedPct, t) {
  if (usedPct >= 85) return t.blocked || "#ef4444";
  if (usedPct >= 65) return t.working || "#f59e0b";
  return t.accent || "#8b9cf6";
}

function displayPct(usedPct, displayMode) {
  const u = Math.max(0, Math.min(100, Math.round(Number(usedPct) || 0)));
  return displayMode === "remaining" ? 100 - u : u;
}

function barFillWidth(usedPct, totalPx, displayMode) {
  const shown = displayPct(usedPct, displayMode);
  if (shown <= 0) return 0;
  return Math.max(2, Math.round((shown / 100) * totalPx));
}

function meterBar(usedPct, widthPx, heightPx, t, displayMode = "used") {
  const fillW = barFillWidth(usedPct, widthPx, displayMode);
  const col = pctColor(usedPct, t);
  return div()
    .w(widthPx)
    .h(heightPx)
    .flex_none()
    .rounded(Math.ceil(heightPx / 2))
    .bg(t.border)
    .overflow_hidden()
    .when(fillW > 0, (el) =>
      el.child(div().w(fillW).h(heightPx).rounded(Math.ceil(heightPx / 2)).bg(col)),
    );
}

function statusPill(text, color, t, fixedWidth = null) {
  return div()
    .when(Boolean(fixedWidth), (el) => el.w(fixedWidth).flex().items_center().justify_center())
    .px(7)
    .py(2)
    .rounded(5)
    .bg(t.raised)
    .text_size(10.5)
    .font_medium()
    .text_color(color)
    .child(text);
}

const TINT_ICONS = new Set([
  "icons/opencode.svg",
  "icons/gemini.svg",
  "icons/grok.svg",
  "icons/cursor.svg",
  "icons/hermes.svg",
  "icons/agent.svg",
  "icons/dsh-tui.svg",
  "icons/copilot.svg",
  "icons/goose.svg",
  "mods/workspace-chrome/terminal.svg",
  "mods/workspace-chrome/server.svg",
  "mods/usage-meter/chart.svg",
  "mods/usage-meter/cpu.svg",
  "mods/usage-meter/ports.svg",
]);

function providerIcon(iconPath, size, color) {
  return TINT_ICONS.has(iconPath)
    ? svg(iconPath).size(size).flex_none().text_color(color)
    : image(iconPath).size(size).flex_none();
}

function translateStatus(rawStatus, L) {
  const map = {
    ok: L.st_ok,
    ready: L.st_ready,
    cached_session: L.st_cached_session,
    rate_limited: L.st_rate_limited,
    gateway: L.st_gateway,
    bedrock: L.st_bedrock,
    offline: L.st_offline,
    unavailable: L.st_unavailable,
    unconfigured: L.st_unconfigured,
    installed: L.st_installed,
    error: L.st_error,
    inactive: L.st_inactive,
  };
  return map[rawStatus] || L.st_unavailable;
}

function herdrToggle(t, id, on, onClick) {
  return div()
    .id(id)
    .w(36)
    .h(20)
    .rounded(10)
    .p(2)
    .flex_none()
    .cursor_pointer()
    .bg(on ? t.accent : t.hover)
    .flex()
    .when(on, (el) => el.justify_end())
    .on_click(onClick)
    .child(div().w(16).h(16).rounded(8).bg(on ? t.accent_foreground : t.muted));
}

export default class UsageMeter extends View {
  init(_props, cx) {
    const p = props();
    this.lastManualAt = 0;
    this.fetching = false;
    this.lastSysAt = 0;
    this.lastPollTick = 0;
    this.confirmKillPid = null;
    this.editingIconProfile = null;
    this.editingAliasProfile = null;
    this.popView = "main";
    this.aliasDraft = "";
    this.aliasInput = null;
    this.handle = null;
    if (p?.mode === "details" || p?.overlay) {
      this.handle = cx.focus_handle();
      this.handle.focus();
      this.aliasInput = InputState.new({ placeholder: "Alias..." });
      this.aliasInput.on("change", (_e, cx) => {
        this.aliasDraft = this.aliasInput.value();
        cx.notify();
      });
      this.aliasInput.on("submit", (_e, cx) => {
        if (this.editingAliasProfile) {
          this.saveProfileAlias(this.editingAliasProfile, this.aliasInput.value(), cx);
        }
      });
    }

    if (!shared(SESSION_BOOT_KEY)) {
      setShared(SESSION_BOOT_KEY, true);
      const curP = readPrefs();
      if (curP.alwaysStartCollapsed !== false) {
        patchPrefs({ barCollapsed: true });
      }
    } else if (!shared(PREFS_KEY)) {
      setShared(PREFS_KEY, readPrefs());
    }

    if (!shared(STATE_KEY) || !shared(STATE_KEY)?.data) {
      try {
        const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
        if (cached && typeof cached === "object" && cached.data) {
          setShared(STATE_KEY, { data: cached.data, loading: false, error: null, updatedAt: cached.updatedAt });
        } else {
          setShared(STATE_KEY, { data: null, loading: false, error: null });
        }
      } catch {
        setShared(STATE_KEY, { data: null, loading: false, error: null });
      }
    } else if (shared(STATE_KEY)?.loading) {
      // Clear stale loading state left across hot reloads
      setShared(STATE_KEY, { ...shared(STATE_KEY), loading: false });
    }

    if (checking()) return;

    cx.timer.every(60_000, (cx) => {
      const prefs = readPrefs();
      if (p?.poller && prefs.pollMinutes > 0) {
        const intervalMs = prefs.pollMinutes * 60_000;
        const last = this.getState().updatedAt || 0;
        if (Date.now() - last >= intervalMs) {
          this.fetchUsage(cx, false);
        }
      }
    });

    if (p?.poller) {
      cx.spawn(async (cx) => {
        let parsed = null;
        try {
          const raw = await readTextFile(`${appHome()}/mods/usage-meter/snapshot.json`);
          if (raw) {
            parsed = JSON.parse(raw);
            const cur = this.getState();
            if (!cur.data || (parsed.updatedAt && parsed.updatedAt > (cur.data?.updatedAt ?? 0))) {
              setShared(STATE_KEY, {
                loading: this.fetching,
                data: parsed,
                error: null,
                updatedAt: parsed.updatedAt,
              });
              cx.notify();
            }
          }
        } catch {}
        const prefs = readPrefs();
        const latestAt = parsed?.updatedAt || this.getState().updatedAt || 0;
        const freshMs = (prefs.pollMinutes > 0 ? prefs.pollMinutes : 15) * 60_000;
        if (!latestAt || (prefs.pollMinutes > 0 && Date.now() - latestAt >= freshMs)) {
          this.fetchUsage(cx, false);
        }
      });

      cx.timer.every(SYS_POLL_MS, (cx) => {
        const prefs = readPrefs();
        if (
          (prefs.providers.ports || prefs.providers.system) &&
          (prefs.showCpuInBar || prefs.showPortsInBar)
        ) {
          this.fetchSysOnly(cx);
        }
      });

      cx.spawn(async (cx) => {
        for (;;) {
          const cmd = await nextCommand();
          if (cmd === "refresh") this.fetchUsage(cx, true);
          else if (cmd === "popover") this.openPopover();
          else if (cmd === "details") this.openDetails("overview");
          else if (cmd === "claude") {
            patchPrefs({ overviewScope: "claude" });
            this.openDetails("overview");
          } else if (cmd === "all") {
            patchPrefs({ overviewScope: "all" });
            this.openDetails("overview");
          } else if (cmd === "ports") this.openDetails("ports");
          else if (cmd === "agents") this.openDetails("agents");
          else if (cmd === "settings") this.openDetails("settings");
          else if (cmd === "toggle_bar") patchPrefs({ barCollapsed: !readPrefs().barCollapsed });
          else if (cmd === "toggle_sidebar") this.toggleSidebarSection();
          cx.notify();
        }
      });
    }
  }

  getState() {
    const raw = shared(STATE_KEY) || { loading: false, data: null, error: null };
    // Safety valve if loading got stuck beyond 35s
    if (raw.loading && raw.startedAt && Date.now() - raw.startedAt > 35_000) {
      return { ...raw, loading: false };
    }
    return raw;
  }

  fetchSysOnly(cx) {
    const cur = this.getState();
    if (!cur.data || this.fetching) return;
    cx.spawn(async (cx) => {
      try {
        const script = `${appHome()}/mods/usage-meter/collect.py`;
        const res = await exec("python3", [script, "sys"], { timeout: 8_000 });
        if (res.code !== 0) return;
        const sysData = JSON.parse(res.stdout);
        const latest = this.getState();
        if (!latest.data) return;
        setShared(STATE_KEY, {
          ...latest,
          data: {
            ...latest.data,
            ports: sysData.ports,
            system: sysData.system,
          },
        });
      } catch {}
      cx.notify();
    });
  }

  fetchUsage(cx, manual = false) {
    const cur = this.getState();
    const now = Date.now();
    if (this.fetching) return;
    if (manual && now - this.lastManualAt < MIN_MANUAL_GAP_MS) return;
    if (manual) this.lastManualAt = now;

    this.fetching = true;
    if (manual || !cur.data) {
      setShared(STATE_KEY, { ...cur, loading: true, startedAt: now });
      cx.notify();
    }
    cx.spawn(async (cx) => {
      try {
        const script = `${appHome()}/mods/usage-meter/collect.py`;
        const args = manual ? [script, "--force"] : [script];
        const res = await exec("python3", args, { timeout: 28_000 });
        if (res.code !== 0) {
          throw new Error((res.stderr || "collect.py failed").trim());
        }
        const parsed = JSON.parse(res.stdout);
        const next = { loading: false, data: parsed, error: null, updatedAt: Date.now() };
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify({ data: parsed, updatedAt: next.updatedAt }));
        } catch {}
        setShared(STATE_KEY, next);
      } catch (err) {
        const latest = this.getState();
        setShared(STATE_KEY, {
          ...latest,
          loading: false,
          error: String(err?.message || err),
        });
      } finally {
        this.fetching = false;
      }
      cx.notify();
    });
  }

  updateProfileCustom(profileKey, patch) {
    const prefs = readPrefs();
    const curAll = prefs.profileCustom || {};
    const curProf = curAll[profileKey] || {};
    patchPrefs({
      profileCustom: {
        ...curAll,
        [profileKey]: { ...curProf, ...patch },
      },
    });
  }

  saveProfileAlias(profileKey, rawAlias, cx) {
    const cleaned = (rawAlias || "").trim();
    this.updateProfileCustom(profileKey, { alias: cleaned || undefined });
    this.editingAliasProfile = null;
    this.aliasDraft = "";
    if (this.handle) this.handle.focus();
    cx.notify();
  }

  toggleSidebarSection() {
    const prefs = readPrefs();
    const next = !prefs.sidebarCollapsed;
    patchPrefs({ sidebarCollapsed: next });
    run("layout.resize", { id: "usage-sidebar", px: next ? 30 : 182 });
  }

  copyText(text, L) {
    exec("sh", ["-c", "printf '%s' \"$1\" | pbcopy", "copy", text]).then(() => {
      notify({ title: L.copied, body: text, level: "info", timeout: 2200 });
    });
  }

  killPortPid(pid, port, L, cx) {
    exec("kill", ["-TERM", String(pid)]).then((r) => {
      this.confirmKillPid = null;
      if (r.code === 0) {
        notify({ title: `${L.portKilled} :${port}`, body: `PID ${pid}`, level: "success", timeout: 2500 });
        this.fetchSysOnly(cx);
      } else {
        notify({ title: `${L.killError} ${pid}`, body: r.stderr || L.noPerm, level: "error", timeout: 3000 });
      }
      cx.notify();
    });
  }

  openPopover() {
    openOverlay({
      mod: "usage-meter",
      kind: "popup",
      width: 448,
      props: { mode: "popover" },
    });
  }

  openDetails(tab = "overview") {
    patchPrefs({ tab });
    openOverlay({
      mod: "usage-meter",
      kind: "dialog",
      width: 840,
      height: 616,
      props: { mode: "details" },
    });
  }

  langStrings(st, prefs) {
    const code = resolveLang(prefs.language, st.data?.systemLocale);
    return { code, L: tr(code) };
  }

  paletteHint() {
    const mac = window()?.platform === "macos";
    const mod = {
      cmd: mac ? "⌘" : "Ctrl+",
      ctrl: mac ? "⌃" : "Ctrl+",
      shift: mac ? "⇧" : "Shift+",
      alt: mac ? "⌥" : "Alt+",
      option: mac ? "⌥" : "Alt+",
    };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys?.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key || "⌘⇧P";
  }

  renderStatusBar(t, st, prefs) {
    const { L } = this.langStrings(st, prefs);
    const now = Date.now();
    const d = st.data;
    const pv = prefs.providers;
    const cl = d?.claude;
    const clProfilesAll = d?.claudeProfiles ?? [];
    const clMeta = profileMeta(cl, prefs);
    const extraProfiles = clProfilesAll.filter((p) => {
      const m = profileMeta(p, prefs);
      return (
        !m.hidden &&
        m.showInBar &&
        p.profile !== cl?.profile &&
        (p.kind === "oauth" || !p.kind) &&
        (p.status === "ok" || p.session || p.status === "rate_limited")
      );
    });
    const harnessProfiles = clProfilesAll.filter((p) => {
      const m = profileMeta(p, prefs);
      return p.kind === "harness" && !m.hidden && m.showInBar;
    });
    const ag = d?.antigravity;
    const cxData = d?.codex;
    const oc = d?.opencode;
    const portsCount = (d?.ports ?? []).length;
    const sys = d?.system;
    const todayCost = d?.costs?.totals?.today?.cost;
    const modeLabel = prefs.displayMode === "remaining" ? L.remaining : L.used;

    const space = spaces().find((s) => s.active);
    const agList = agents();
    const needs = agList.filter((a) => a.status === "blocked").length;

    const clReady = cl?.status === "ok";
    const cl5h = cl?.session?.percent ?? 0;
    const cl5hR = formatResetShort(cl?.session?.resetsAt, now, L);
    const clSem = cl?.weekly?.percent ?? 0;
    const clSemR = formatResetShort(cl?.weekly?.resetsAt, now, L);
    const clFable = cl?.fable?.percent;

    const agReady = ag?.status === "ok";
    const agGem = ag?.groups?.find((g) => g.shortName === "Gemini");
    const agCl = ag?.groups?.find((g) => g.shortName === "Claude/GPT");
    const gem5h = agGem?.h5?.percent ?? 0;
    const gemSem = agGem?.weekly?.percent ?? 0;
    const clg5h = agCl?.h5?.percent ?? 0;

    const showCodex = pv.codex && cxData && (cxData.status === "ok" || cxData.status === "cached_session");
    const codexPct = cxData?.session?.percent ?? cxData?.weekly?.percent ?? 0;
    const showOpencode = pv.opencode && oc && oc.status === "ok" && oc.allTimeTokens > 0;
    const collapsed = prefs.barCollapsed;

    const wsLabel = (icon, text) =>
      h_flex()
        .gap(5)
        .flex_none()
        .items_center()
        .child(svg(`mods/workspace-chrome/${icon}.svg`).size(12.5))
        .child(div().whitespace_nowrap().child(text));

    return h_flex()
      .size_full()
      .px(12)
      .gap(10)
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.3)
      .text_color(t.muted)
      // Left: Herdr workspace status inline
      .child(
        h_flex()
          .gap(11)
          .flex_none()
          .items_center()
          .child(wsLabel(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
          .when(Boolean(space?.branch), (el) => el.child(wsLabel("branch", space.branch)))
          .child(
            h_flex()
              .gap(5)
              .flex_none()
              .items_center()
              .child(div().size(6).rounded(3).bg(t.dim))
              .child(`${agList.length} ${agList.length === 1 ? "agent" : "agents"}`)
              .when(needs > 0, (el) =>
                el.child(
                  div()
                    .text_color(t.blocked)
                    .child(`· ${needs} ${needs === 1 ? "needs" : "need"} you`),
                ),
              ),
          ),
      )
      .child(div().w(1).h(12).flex_none().bg(t.border))
      // Collapsed state
      .when(collapsed, (el) =>
        el
          .child(
            h_flex()
              .id("bar-collapsed-trigger")
              .gap(7)
              .px(5)
              .py(2)
              .rounded(5)
              .items_center()
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .tooltip(`${L.usage} · ${L.allAgents}`)
              .on_click(() => this.openPopover())
              .when(pv.claude, (e) =>
                e
                  .child(image("icons/claude.svg").size(12.5).flex_none())
                  .child(
                    div()
                      .text_color(t.foreground)
                      .child(
                        clReady
                          ? `${displayPct(cl5h, prefs.displayMode)}%${
                              extraProfiles.length > 0 && extraProfiles[0]?.session
                                ? ` / ${displayPct(extraProfiles[0].session.percent ?? 0, prefs.displayMode)}%`
                                : ""
                            }`
                          : "—",
                      ),
                  ),
              )
              .when(pv.antigravity, (e) =>
                e
                  .child(image("icons/antigravity.svg").size(12.5).flex_none())
                  .child(div().text_color(t.muted).child(agReady ? `${displayPct(gem5h, prefs.displayMode)}%` : "—")),
              ),
          )
          .when(prefs.showEstimatedCost && prefs.showCostInSidebar && todayCost !== undefined, (e) =>
            e.child(
              h_flex()
                .id("bar-collapsed-cost")
                .gap(4)
                .px(6)
                .py(1)
                .rounded(4)
                .bg(t.surface)
                .border(1)
                .border_color(t.border)
                .items_center()
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .tooltip(L.usageDetailsHistory)
                .on_click(() => this.openDetails("overview"))
                .child(div().font_medium().text_color(t.foreground).child(fmtUsd(todayCost))),
            ),
          )
          .child(
            div()
              .id("bar-expand-btn")
              .px(5)
              .py(1)
              .rounded(4)
              .text_color(t.dim)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .tooltip(L.expandBar)
              .on_click(() => patchPrefs({ barCollapsed: false }))
              .child("»"),
          )
          .child(div().flex_1()),
      )
      // Expanded state
      .when(!collapsed, (el) =>
        el
          .child(
            div()
              .id("bar-mode-toggle")
              .px(4)
              .py(1)
              .rounded(4)
              .flex_none()
              .text_color(t.dim)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .tooltip(L.setPctDesc)
              .on_click(() =>
                patchPrefs({ displayMode: prefs.displayMode === "used" ? "remaining" : "used" }),
              )
              .child(modeLabel),
          )
          .when(pv.claude && !clMeta.hidden && clMeta.showInBar, (e) =>
            e.child(
              h_flex()
                .id("bar-claude-trigger")
                .gap(5)
                .px(4)
                .py(2)
                .rounded(5)
                .flex_none()
                .items_center()
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click(() => this.openPopover())
                .child(providerIcon(clMeta.icon, 12.5, t.foreground))
                .when(clMeta.label && clMeta.label !== "Padrão", (x) =>
                  x.child(div().text_color(t.dim).child(clMeta.label)),
                )
                .when(clReady, (c) =>
                  c
                    .when(prefs.showBarsInSidebar, (b) => b.child(meterBar(cl5h, 20, 4.5, t, prefs.displayMode)))
                    .child(div().text_color(t.foreground).child(`${displayPct(cl5h, prefs.displayMode)}%`))
                    .when(prefs.showResetInSidebar && Boolean(cl5hR), (x) =>
                      x.child(div().text_color(t.dim).child(cl5hR)),
                    )
                    .child(div().text_color(t.dim).child("·"))
                    .child(
                      div()
                        .text_color(t.muted)
                        .child(
                          `${displayPct(clSem, prefs.displayMode)}%${prefs.showResetInSidebar && clSemR ? ` ${clSemR}` : ` ${L.weekShort}`}`,
                        ),
                    )
                    .when(clFable !== undefined && clFable !== null, (x) =>
                      x
                        .child(div().text_color(t.dim).child("·"))
                        .child(div().text_color(t.dim).child(`${displayPct(clFable, prefs.displayMode)}% F`)),
                    ),
                )
                .when(!clReady, (c) =>
                  c.child(div().text_color(t.dim).child(st.loading ? "Claude…" : translateStatus(cl?.status, L))),
                ),
            ),
          )
          .when(pv.claude && prefs.showExtraProfilesInBar && extraProfiles.length > 0, (e) =>
            e.children(
              extraProfiles.map((ep, idx) => {
                const epMeta = profileMeta(ep, prefs);
                const epReady = ep.status === "ok" && Boolean(ep.session);
                const ep5h = ep.session?.percent ?? 0;
                const epSem = ep.weekly?.percent ?? 0;
                const epR = formatResetShort(ep.session?.resetsAt, now, L);
                return h_flex()
                  .id(`bar-claude-extra-${idx}`)
                  .gap(4)
                  .px(4)
                  .py(2)
                  .rounded(5)
                  .flex_none()
                  .items_center()
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .tooltip(`Claude (${epMeta.label})${ep.plan ? ` · ${ep.plan}` : ""}${ep.rateLimited ? ` · ${L.staleCacheTag}` : ""}`)
                  .on_click(() => this.openPopover())
                  .when(epMeta.icon !== "icons/claude.svg", (x) =>
                    x.child(providerIcon(epMeta.icon, 11.5, t.foreground)),
                  )
                  .child(div().text_color(t.dim).child(epMeta.label))
                  .when(epReady, (c) =>
                    c
                      .child(div().text_color(t.foreground).child(`${displayPct(ep5h, prefs.displayMode)}%`))
                      .when(prefs.showResetInSidebar && Boolean(epR), (x) =>
                        x.child(div().text_color(t.dim).child(epR)),
                      )
                      .child(div().text_color(t.dim).child("·"))
                      .child(div().text_color(t.muted).child(`${displayPct(epSem, prefs.displayMode)}% ${L.weekShort}`)),
                  )
                  .when(!epReady, (c) =>
                    c.child(div().text_color(t.dim).child(translateStatus(ep.status, L))),
                  );
              }),
            ),
          )
          .when(pv.harness && prefs.showHarnessInBar && harnessProfiles.length > 0, (e) =>
            e.children(
              harnessProfiles.map((hp, idx) => {
                const hm = profileMeta(hp, prefs);
                const tok = hp.todayTokens > 0 ? hp.todayTokens : hp.d7Tokens || 0;
                return h_flex()
                  .id(`bar-harness-trigger-${idx}`)
                  .gap(4)
                  .px(4)
                  .py(2)
                  .rounded(5)
                  .flex_none()
                  .items_center()
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .tooltip(
                    `${hm.label} · ${hp.plan || hp.defaultModel || "LiteLLM"} · ${L.today}: ${fmtTokens(hp.todayTokens || 0)} (${hp.todayMessages || 0} ${L.msgs})`,
                  )
                  .on_click(() => this.openPopover())
                  .child(div().size(5).rounded(3).bg(hp.gatewayUp ? (t.done || t.accent) : t.dim))
                  .child(providerIcon(hm.icon, 11.5, t.muted))
                  .child(div().text_color(t.dim).child(hm.label))
                  .when(tok > 0, (x) => x.child(div().text_color(t.muted).child(fmtTokens(tok))));
              }),
            ),
          )
          .when(pv.claude && pv.antigravity, (e) => e.child(div().w(1).h(11).flex_none().bg(t.border)))
          .when(pv.antigravity, (e) =>
            e.child(
              h_flex()
                .id("bar-agy-trigger")
                .gap(5)
                .px(4)
                .py(2)
                .rounded(5)
                .flex_none()
                .items_center()
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click(() => this.openPopover())
                .child(image("icons/antigravity.svg").size(12.5).flex_none())
                .when(agReady, (a) =>
                  a
                    .when(prefs.showBarsInSidebar, (b) => b.child(meterBar(gem5h, 18, 4.5, t, prefs.displayMode)))
                    .child(
                      div()
                        .text_color(t.muted)
                        .child(`Gem ${displayPct(gem5h, prefs.displayMode)}%/${displayPct(gemSem, prefs.displayMode)}%`),
                    )
                    .child(div().text_color(t.dim).child(`· Cl ${displayPct(clg5h, prefs.displayMode)}%`)),
                )
                .when(!agReady, (a) =>
                  a.child(div().text_color(t.dim).child(st.loading ? "Agy…" : translateStatus(ag?.status, L))),
                ),
            ),
          )
          .when(prefs.showCodexInBar && Boolean(showCodex), (e) =>
            e.child(
              h_flex()
                .id("bar-codex-trigger")
                .gap(4)
                .px(4)
                .py(2)
                .rounded(5)
                .flex_none()
                .items_center()
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .tooltip(`Codex: ${cxData.sessionsCount} ${L.sessions} · ${fmtTokens(cxData.totalTokens)} tok`)
                .on_click(() => this.openDetails("agents"))
                .child(providerIcon("icons/codex.svg", 12, t.foreground))
                .child(div().text_color(t.muted).child(`${displayPct(codexPct, prefs.displayMode)}%`)),
            ),
          )
          .when(prefs.showOpencodeInBar && Boolean(showOpencode), (e) =>
            e.child(
              h_flex()
                .id("bar-opencode-trigger")
                .gap(4)
                .px(4)
                .py(2)
                .rounded(5)
                .flex_none()
                .items_center()
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .tooltip(`OpenCode: ${oc.sessionsCount} ${L.sessions} · ${fmtTokens(oc.allTimeTokens)} tok`)
                .on_click(() => this.openDetails("agents"))
                .child(providerIcon("icons/opencode.svg", 11.5, t.foreground))
                .child(div().text_color(t.dim).child(fmtTokens(oc.allTimeTokens))),
            ),
          )
          .child(div().flex_1())
          .when(prefs.showCpuInBar && pv.system && Boolean(sys), (e) =>
            e.child(
              h_flex()
                .id("bar-sys-pill")
                .gap(3)
                .px(4)
                .py(2)
                .rounded(4)
                .flex_none()
                .items_center()
                .cursor_pointer()
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .tooltip(L.tabSystem)
                .on_click(() => this.openDetails("system"))
                .child(svg("mods/usage-meter/cpu.svg").size(11).text_color(t.dim))
                .child(div().text_color(t.dim).child(`${sys.cpuPercent}%`)),
            ),
          )
          .when(prefs.showPortsInBar && pv.ports && d?.ports !== undefined, (e) =>
            e.child(
              h_flex()
                .id("bar-ports-pill")
                .gap(3)
                .px(4)
                .py(2)
                .rounded(4)
                .flex_none()
                .items_center()
                .cursor_pointer()
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .tooltip(L.tabPorts)
                .on_click(() => this.openDetails("ports"))
                .child(svg("mods/usage-meter/ports.svg").size(11).text_color(t.dim))
                .child(div().text_color(t.dim).child(`${portsCount}p`)),
            ),
          )
          .when(prefs.showEstimatedCost && prefs.showCostInSidebar && todayCost !== undefined, (e) =>
            e.child(
              h_flex()
                .id("bar-cost-pill")
                .gap(4)
                .px(6)
                .py(1)
                .rounded(4)
                .flex_none()
                .items_center()
                .cursor_pointer()
                .bg(t.surface)
                .border(1)
                .border_color(t.border)
                .hover((s) => s.bg(t.hover))
                .tooltip(L.usageDetailsHistory)
                .on_click(() => this.openDetails("overview"))
                .child(div().font_medium().text_color(t.foreground).child(fmtUsd(todayCost))),
            ),
          )
          .child(
            div()
              .id("bar-collapse-btn")
              .px(4)
              .py(1)
              .rounded(4)
              .flex_none()
              .text_color(t.dim)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .tooltip(L.collapseBar)
              .on_click(() => patchPrefs({ barCollapsed: true }))
              .child("«"),
          ),
      )
      .when(prefs.showBarActions, (e) =>
        e
          .child(
            div()
              .id("bar-settings")
              .p(3)
              .rounded(4)
              .flex_none()
              .text_color(t.dim)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .tooltip(L.openSettings)
              .on_click(() => this.openDetails("settings"))
              .child(svg("mods/usage-meter/sliders.svg").size(11.5)),
          )
          .child(
            div()
              .id("bar-refresh")
              .p(3)
              .rounded(4)
              .flex_none()
              .text_color(t.dim)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .tooltip(L.refresh)
              .on_click((_e, cx) => this.fetchUsage(cx, true))
              .child(
                svg("mods/usage-meter/refresh.svg")
                  .size(11.5)
                  .when(st.loading, (s) => s.spin(900)),
              ),
          ),
      )
      .child(
        div()
          .id("bar-palette")
          .flex_none()
          .text_color(t.dim)
          .cursor_pointer()
          .hover((s) => s.text_color(t.foreground))
          .on_click(() => run("app.palette"))
          .child(`${this.paletteHint()} commands`),
      );
  }

  renderSidebar(t, st, prefs) {
    const { L } = this.langStrings(st, prefs);
    const narrow = isSidebarNarrow();
    const now = Date.now();
    const d = st.data;
    const cl = d?.claude;
    const clProfilesAll = d?.claudeProfiles ?? [];
    const clMeta = profileMeta(cl, prefs);
    const extraProfiles = clProfilesAll.filter((p) => {
      const m = profileMeta(p, prefs);
      return (
        !m.hidden &&
        m.showInBar &&
        p.profile !== cl?.profile &&
        (p.kind === "oauth" || !p.kind) &&
        (p.status === "ok" || p.session || p.status === "rate_limited")
      );
    });
    const harnessProfiles = clProfilesAll.filter((p) => {
      const m = profileMeta(p, prefs);
      return p.kind === "harness" && !m.hidden && m.showInBar;
    });
    const ag = d?.antigravity;
    const cxData = d?.codex;
    const oc = d?.opencode;
    const portsCount = (d?.ports ?? []).length;
    const sys = d?.system;
    const todayCost = d?.costs?.totals?.today?.cost;
    const d7Cost = d?.costs?.totals?.d7?.cost;
    const pv = prefs.providers;

    if (narrow) {
      const cl5h = cl?.session?.percent ?? 0;
      const railW = window()?.platform === "macos" ? 54 : 34;
      return v_flex()
        .size_full()
        .bg(t.chrome)
        .border_t(1)
        .border_color(t.border)
        .py(6)
        .gap(3)
        .items_center()
        .justify_center()
        .child(
          v_flex()
            .id("sb-rail-usage")
            .w(railW)
            .py(5)
            .gap(3)
            .rounded(7)
            .items_center()
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .tooltip(
              `Claude: ${displayPct(cl5h, prefs.displayMode)}%${todayCost !== undefined ? ` · ${fmtUsd(todayCost)}` : ""}`,
            )
            .on_click(() => this.openPopover())
            .child(image("icons/claude.svg").size(14))
            .child(div().text_size(10).text_color(t.foreground).child(`${displayPct(cl5h, prefs.displayMode)}%`))
            .when(prefs.showCostInSidebar && todayCost !== undefined, (el) =>
              el.child(div().text_size(9.5).text_color(t.dim).child(fmtUsd(todayCost))),
            ),
        );
    }

    const clReady = cl?.status === "ok";
    const cl5h = cl?.session?.percent ?? 0;
    const clSem = cl?.weekly?.percent ?? 0;
    const clFable = cl?.fable?.percent;
    const clReset = formatResetShort(cl?.session?.resetsAt, now, L);

    const agReady = ag?.status === "ok";
    const agGem = ag?.groups?.find((g) => g.shortName === "Gemini");
    const agCl = ag?.groups?.find((g) => g.shortName === "Claude/GPT");
    const gem5h = agGem?.h5?.percent ?? 0;
    const gemSem = agGem?.weekly?.percent ?? 0;
    const clg5h = agCl?.h5?.percent ?? 0;
    const agReset = formatResetShort(ag?.resetsAt, now, L);

    if (prefs.sidebarCollapsed) {
      return h_flex()
        .size_full()
        .bg(t.chrome)
        .border_t(1)
        .border_color(t.border)
        .px(12)
        .items_center()
        .justify_between()
        .child(
          h_flex()
            .id("sb-expand-header")
            .gap(5)
            .items_center()
            .cursor_pointer()
            .text_color(t.dim)
            .hover((s) => s.text_color(t.foreground))
            .tooltip(L.expandPanel)
            .on_click(() => this.toggleSidebarSection())
            .child(svg("mods/usage-meter/chevron-right.svg").size(11))
            .child(div().text_size(11.5).font_medium().child(L.usageAndCosts)),
        )
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .when(clReady && pv.claude, (el) =>
              el.child(
                div()
                  .id("sb-col-pct")
                  .text_size(11)
                  .text_color(t.muted)
                  .cursor_pointer()
                  .on_click(() => this.openPopover())
                  .child(`${displayPct(cl5h, prefs.displayMode)}%`),
              ),
            )
            .when(prefs.showCostInSidebar && todayCost !== undefined, (el) =>
              el.child(
                div()
                  .id("sb-col-cost")
                  .px(5)
                  .py(1)
                  .rounded(4)
                  .bg(t.surface)
                  .border(1)
                  .border_color(t.border)
                  .text_size(10.5)
                  .font_semibold()
                  .text_color(t.foreground)
                  .cursor_pointer()
                  .on_click(() => this.openDetails("overview"))
                  .child(fmtUsd(todayCost)),
              ),
            ),
        );
    }

    const chips = [];
    if (pv.codex && cxData && (cxData.status === "ok" || cxData.status === "cached_session")) {
      chips.push(`Codex ${displayPct(cxData.weekly?.percent ?? 0, prefs.displayMode)}%`);
    }
    if (pv.opencode && oc?.status === "ok" && oc.sessionsCount > 0) {
      chips.push(`OC ${oc.sessionsCount}`);
    }

    return v_flex()
      .size_full()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .px(8)
      .pt(6)
      .pb(5)
      .gap(3)
      // Header
      .child(
        h_flex()
          .px(8)
          .h(22)
          .items_center()
          .justify_between()
          .child(
            h_flex()
              .id("sb-collapse-header")
              .gap(5)
              .items_center()
              .cursor_pointer()
              .text_color(t.dim)
              .hover((s) => s.text_color(t.foreground))
              .tooltip(L.collapsePanel)
              .on_click(() => this.toggleSidebarSection())
              .child(svg("mods/usage-meter/chevron-down.svg").size(11))
              .child(div().text_size(11.5).font_medium().child(L.usageAndCosts))
              .when(Boolean(cl?.rateLimited), (el) =>
                el.child(div().text_size(9.5).text_color(t.working).child(L.cacheBadge)),
              ),
          )
          .child(
            h_flex()
              .gap(4)
              .items_center()
              .when(prefs.showCostInSidebar && todayCost !== undefined, (el) =>
                el.child(
                  div()
                    .id("sb-cost-badge")
                    .px(5)
                    .py(1)
                    .rounded(4)
                    .bg(t.surface)
                    .border(1)
                    .border_color(t.border)
                    .text_size(10.5)
                    .font_semibold()
                    .text_color(t.foreground)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .tooltip(L.usageDetailsHistory)
                    .on_click(() => this.openDetails("overview"))
                    .child(fmtUsd(todayCost)),
                ),
              )
              .child(
                div()
                  .id("sb-refresh")
                  .p(3)
                  .rounded(5)
                  .text_color(t.dim)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .tooltip(L.refresh)
                  .on_click((_e, cx) => this.fetchUsage(cx, true))
                  .child(
                    svg("mods/usage-meter/refresh.svg")
                      .size(11.5)
                      .when(st.loading, (s) => s.spin(900)),
                  ),
              )
              .child(
                div()
                  .id("sb-settings")
                  .p(3)
                  .rounded(5)
                  .text_color(t.dim)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .tooltip(L.openSettings)
                  .on_click(() => this.openDetails("settings"))
                  .child(svg("mods/usage-meter/sliders.svg").size(11.5)),
              ),
          ),
      )
      // Claude row
      .when(pv.claude, (el) =>
        el.child(
          v_flex()
            .id("sb-claude")
            .px(8)
            .py(4)
            .gap(3)
            .rounded(7)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click(() => this.openPopover())
            .child(
              h_flex()
                .items_center()
                .justify_between()
                .child(
                  h_flex()
                    .gap(6)
                    .items_center()
                    .child(image("icons/claude.svg").size(13).flex_none())
                    .child(div().text_size(12).font_medium().text_color(t.foreground).child("Claude"))
                    .when(Boolean(cl?.plan), (e) =>
                      e.child(div().text_size(10.5).text_color(t.dim).child(cl.plan)),
                    )
                    .when(extraProfiles.length > 0, (e) =>
                      e.child(
                        div()
                          .text_size(10)
                          .text_color(t.accent)
                          .child(`+${extraProfiles[0].label}`),
                      ),
                    ),
                )
                .child(
                  h_flex()
                    .gap(4)
                    .items_center()
                    .when(clReady && prefs.showResetInSidebar && Boolean(clReset), (e) =>
                      e.child(div().text_size(10.5).text_color(t.dim).child(clReset)),
                    )
                    .child(
                      div()
                        .text_size(11.5)
                        .font_semibold()
                        .text_color(clReady ? t.foreground : t.dim)
                        .child(clReady ? `${displayPct(cl5h, prefs.displayMode)}%` : "—"),
                    ),
                ),
            )
            .when(clReady && prefs.showBarsInSidebar, (e) =>
              e.child(meterBar(cl5h, 236, 4, t, prefs.displayMode)),
            )
            .when(clReady, (e) =>
              e.child(
                div()
                  .text_size(10.5)
                  .text_color(t.dim)
                  .truncate()
                  .child(
                    `5h ${displayPct(cl5h, prefs.displayMode)}% · ${L.weekShort} ${displayPct(clSem, prefs.displayMode)}%` +
                      (clFable !== undefined && clFable !== null
                        ? ` · Fable ${displayPct(clFable, prefs.displayMode)}%`
                        : ""),
                  ),
              ),
            ),
        ),
      )
      // Antigravity row
      .when(pv.antigravity, (el) =>
        el.child(
          v_flex()
            .id("sb-agy")
            .px(8)
            .py(4)
            .gap(3)
            .rounded(7)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click(() => this.openPopover())
            .child(
              h_flex()
                .items_center()
                .justify_between()
                .child(
                  h_flex()
                    .gap(6)
                    .items_center()
                    .child(image("icons/antigravity.svg").size(13).flex_none())
                    .child(div().text_size(12).font_medium().text_color(t.foreground).child("Antigravity")),
                )
                .child(
                  h_flex()
                    .gap(4)
                    .items_center()
                    .when(agReady && prefs.showResetInSidebar && Boolean(agReset), (e) =>
                      e.child(div().text_size(10.5).text_color(t.dim).child(agReset)),
                    )
                    .child(
                      div()
                        .text_size(11.5)
                        .font_semibold()
                        .text_color(agReady ? t.foreground : t.dim)
                        .child(agReady ? `${displayPct(gem5h, prefs.displayMode)}%` : "—"),
                    ),
                ),
            )
            .when(agReady && prefs.showBarsInSidebar, (e) =>
              e.child(meterBar(Math.max(gem5h, clg5h), 236, 4, t, prefs.displayMode)),
            )
            .when(agReady, (e) =>
              e.child(
                div()
                  .text_size(10.5)
                  .text_color(t.dim)
                  .truncate()
                  .child(
                    `Gem ${displayPct(gem5h, prefs.displayMode)}%/${displayPct(gemSem, prefs.displayMode)}% · Cl/GPT ${displayPct(clg5h, prefs.displayMode)}%`,
                  ),
              ),
            ),
        ),
      )
      // Bottom quick chips + Inspector shortcut
      .child(
        h_flex()
          .px(6)
          .h(20)
          .gap(4)
          .items_center()
          .justify_between()
          .text_size(10.5)
          .child(
            h_flex()
              .gap(4)
              .items_center()
              .when(prefs.showChipsInSidebar && chips.length > 0, (el) =>
                el.child(
                  div()
                    .id("sb-chip-agents")
                    .px(5)
                    .py(1)
                    .rounded(4)
                    .bg(t.surface)
                    .text_color(t.muted)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .on_click(() => this.openDetails("agents"))
                    .child(chips.join(" · ")),
                ),
              )
              .when(prefs.showChipsInSidebar && pv.ports && d?.ports !== undefined, (el) =>
                el.child(
                  div()
                    .id("sb-chip-ports")
                    .px(5)
                    .py(1)
                    .rounded(4)
                    .bg(t.surface)
                    .text_color(t.muted)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .on_click(() => this.openDetails("ports"))
                    .child(`${portsCount}p`),
                ),
              )
              .when(prefs.showChipsInSidebar && pv.system && Boolean(sys), (el) =>
                el.child(
                  div()
                    .id("sb-chip-sys")
                    .px(5)
                    .py(1)
                    .rounded(4)
                    .bg(t.surface)
                    .text_color(t.muted)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .on_click(() => this.openDetails("system"))
                    .child(`${sys.cpuPercent}%`),
                ),
              )
              .when(!prefs.showChipsInSidebar && d7Cost !== undefined, (el) =>
                el.child(div().px(2).text_color(t.dim).child(`7d: ${fmtUsd(d7Cost)}`)),
              ),
          )
          .child(
            h_flex()
              .id("sb-details-link")
              .gap(2)
              .px(4)
              .py(1)
              .rounded(4)
              .items_center()
              .text_color(t.muted)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .tooltip(d7Cost !== undefined ? `7d: ${fmtUsd(d7Cost)}` : L.inspector)
              .on_click(() => this.openDetails("overview"))
              .child(L.inspector)
              .child(svg("mods/usage-meter/chevron-right.svg").size(10)),
          ),
      );
  }

  renderPopover(t, st, prefs) {
    const { L } = this.langStrings(st, prefs);
    const now = Date.now();
    const d = st.data;
    const pv = prefs.providers;
    const clProfilesAll = d?.claudeProfiles ?? (d?.claude ? [d.claude] : []);
    const clShown = (prefs.hideUnauthProfiles
      ? clProfilesAll.filter(
          (p) =>
            p.status === "ok" ||
            p.status === "rate_limited" ||
            (pv.harness && p.kind === "harness"),
        )
      : clProfilesAll
    ).filter((p) => !profileMeta(p, prefs).hidden);
    const ag = d?.antigravity;
    const cxData = d?.codex;
    const oc = d?.opencode;
    const othersAll = d?.others ?? [];
    const othersShown = othersAll.filter((o) => pv[o.id]);
    const portsCount = (d?.ports ?? []).length;
    const sys = d?.system;
    const todayCost = d?.costs?.totals?.today?.cost;
    const d7Cost = d?.costs?.totals?.d7?.cost;
    const detailed = prefs.detailMode === "detailed";
    const overlayId = props()?.overlay;

    const metricChip = (label, usedPct, w = 32) =>
      h_flex()
        .gap(5)
        .items_center()
        .child(div().text_size(11).text_color(t.muted).child(label))
        .child(meterBar(usedPct, w, 5, t, prefs.displayMode))
        .child(
          div()
            .text_size(11)
            .font_medium()
            .text_color(t.foreground)
            .child(`${displayPct(usedPct, prefs.displayMode)}%`),
        );

    const segBtn = (id, label, tip, active) =>
      div()
        .id(id)
        .flex_1()
        .h(24)
        .rounded(6)
        .flex()
        .items_center()
        .justify_center()
        .text_size(12)
        .font_medium()
        .cursor_pointer()
        .tooltip(tip)
        .when(active, (el) => el.bg(t.raised).text_color(t.foreground))
        .when(!active, (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
        .on_click(() => patchPrefs({ detailMode: id === "seg-det" ? "detailed" : "compact" }))
        .child(label);

    const agResetText = ag?.resetsAt ? formatResetLong(ag.resetsAt, now, L) : "";
    const agGem = ag?.groups?.find((g) => g.shortName === "Gemini");
    const agCl = ag?.groups?.find((g) => g.shortName === "Claude/GPT");
    const agTimeText = ag?.updatedAt
      ? `${L.updatedAgo} ${new Date(ag.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : "";

    const fullBarRow = (label, resetAt, pctVal) => {
      const pShown = displayPct(pctVal ?? 0, prefs.displayMode);
      const rTxt = resetAt ? formatResetLong(resetAt, now, L) : L.resetsNow;
      return v_flex()
        .py(6)
        .gap(5)
        .child(
          h_flex()
            .items_center()
            .justify_between()
            .text_size(12)
            .child(
              h_flex()
                .gap(4)
                .items_center()
                .child(div().font_semibold().text_color(t.foreground).child(label))
                .child(div().text_size(11).text_color(t.dim).child(`· ${rTxt}`)),
            )
            .child(div().font_semibold().text_color(t.foreground).child(`${pShown}%`)),
        )
        .child(meterBar(pctVal ?? 0, 404, 6, t, prefs.displayMode));
    };

    if (this.popView === "antigravity") {
      return v_flex()
        .w_full()
        .bg(t.popover)
        .text_color(t.foreground)
        .child(
          h_flex()
            .px(14)
            .pt(12)
            .pb(10)
            .border_b(1)
            .border_color(t.border)
            .items_center()
            .justify_between()
            .child(
              h_flex()
                .gap(8)
                .items_center()
                .child(
                  div()
                    .id("pop-back-agy")
                    .px(6)
                    .py(3)
                    .rounded(5)
                    .text_size(11.5)
                    .text_color(t.muted)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .on_click((_e, cx) => {
                      this.popView = "main";
                      cx.notify();
                    })
                    .child(`← ${L.backLabel}`),
                )
                .child(image("icons/antigravity.svg").size(15).flex_none())
                .child(
                  v_flex()
                    .gap(1)
                    .child(div().text_size(13).font_semibold().child("Antigravity"))
                    .when(Boolean(agTimeText), (e) =>
                      e.child(div().text_size(10.5).text_color(t.dim).child(agTimeText)),
                    ),
                ),
            )
            .child(
              h_flex()
                .id("pop-agy-mode")
                .gap(4)
                .px(6)
                .py(3)
                .rounded(5)
                .items_center()
                .text_size(11.5)
                .text_color(t.muted)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click(() =>
                  patchPrefs({ displayMode: prefs.displayMode === "used" ? "remaining" : "used" }),
                )
                .child(prefs.displayMode === "remaining" ? L.remaining : L.used)
                .child(svg("mods/usage-meter/arrows-up-down.svg").size(11.5)),
            ),
        )
        .child(
          v_flex()
            .px(16)
            .py(10)
            .gap(4)
            .when(Boolean(agGem?.weekly), (e) =>
              e.child(fullBarRow(`Gemini · ${L.weekShort}`, agGem.weekly.resetsAt, agGem.weekly.percent)),
            )
            .when(Boolean(agGem?.h5), (e) =>
              e.child(fullBarRow("Gemini · 5h", agGem.h5.resetsAt, agGem.h5.percent)),
            )
            .when(Boolean(agCl?.weekly), (e) =>
              e.child(fullBarRow(`Claude/GPT · ${L.weekShort}`, agCl.weekly.resetsAt, agCl.weekly.percent)),
            )
            .when(Boolean(agCl?.h5), (e) =>
              e.child(fullBarRow("Claude/GPT · 5h", agCl.h5.resetsAt, agCl.h5.percent)),
            ),
        )
        .child(
          h_flex()
            .border_t(1)
            .border_color(t.border)
            .px(12)
            .py(8)
            .justify_between()
            .items_center()
            .child(
              div()
                .text_size(11)
                .text_color(t.dim)
                .child(`${ag?.conversations ?? 0} ${L.conversationsLocal}`),
            )
            .child(
              div()
                .id("pop-agy-details")
                .px(8)
                .py(4)
                .rounded(6)
                .text_size(12)
                .text_color(t.muted)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => {
                  this.popView = "antigravity";
                  cx.notify();
                })
                .child(`${L.details} ›`),
            ),
        );
    }

    if (this.popView === "claude") {
      const oauthShown = clProfilesAll.filter((p) => !profileMeta(p, prefs).hidden);
      return v_flex()
        .w_full()
        .bg(t.popover)
        .text_color(t.foreground)
        .child(
          h_flex()
            .px(14)
            .pt(12)
            .pb(10)
            .border_b(1)
            .border_color(t.border)
            .items_center()
            .justify_between()
            .child(
              h_flex()
                .gap(8)
                .items_center()
                .child(
                  div()
                    .id("pop-back-cl")
                    .px(6)
                    .py(3)
                    .rounded(5)
                    .text_size(11.5)
                    .text_color(t.muted)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .on_click((_e, cx) => {
                      this.popView = "main";
                      cx.notify();
                    })
                    .child(`← ${L.backLabel}`),
                )
                .child(image("icons/claude.svg").size(15).flex_none())
                .child(div().text_size(13).font_semibold().child("Claude")),
            )
            .child(
              h_flex()
                .id("pop-cl-mode")
                .gap(4)
                .px(6)
                .py(3)
                .rounded(5)
                .items_center()
                .text_size(11.5)
                .text_color(t.muted)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click(() =>
                  patchPrefs({ displayMode: prefs.displayMode === "used" ? "remaining" : "used" }),
                )
                .child(prefs.displayMode === "remaining" ? L.remaining : L.used)
                .child(svg("mods/usage-meter/arrows-up-down.svg").size(11.5)),
            ),
        )
        .when(Boolean(d?.claude && d.claude.status === "ok"), (el) =>
          el.child(
            v_flex()
              .px(16)
              .py(10)
              .gap(2)
              .border_b(1)
              .border_color(t.border)
              .when(Boolean(d.claude.session), (e) =>
                e.child(fullBarRow("5h", d.claude.session.resetsAt, d.claude.session.percent)),
              )
              .when(Boolean(d.claude.weekly), (e) =>
                e.child(fullBarRow(L.weekShort, d.claude.weekly.resetsAt, d.claude.weekly.percent)),
              ),
          ),
        )
        .child(
          v_flex()
            .px(10)
            .py(8)
            .gap(2)
            .child(
              div()
                .px(6)
                .pb(4)
                .text_size(11)
                .font_semibold()
                .text_color(t.dim)
                .child(L.accountsSection.toUpperCase()),
            )
            .children(
              oauthShown.map((cp, idx) => {
                const pm = profileMeta(cp, prefs);
                const subRight =
                  cp.kind === "harness"
                    ? fmtTokens(cp.todayTokens || cp.d7Tokens || 0)
                    : cp.status === "ok" && cp.session
                      ? `${displayPct(cp.session.percent ?? 0, prefs.displayMode)}% 5h · ${displayPct(cp.weekly?.percent ?? 0, prefs.displayMode)}%`
                      : translateStatus(cp.status, L);
                return h_flex()
                  .id(`pop-acct-${idx}`)
                  .px(8)
                  .py(6)
                  .rounded(6)
                  .items_center()
                  .justify_between()
                  .hover((s) => s.bg(t.raised))
                  .child(
                    h_flex()
                      .gap(8)
                      .flex_1()
                      .min_w(0)
                      .items_center()
                      .child(providerIcon(pm.icon, 14, t.foreground))
                      .child(
                        div()
                          .text_size(12)
                          .text_color(t.foreground)
                          .truncate()
                          .child(
                            `${pm.label}${cp.email ? ` (${cp.email})` : cp.plan ? ` · ${cp.plan}` : ""}`,
                          ),
                      ),
                  )
                  .child(div().text_size(11.5).text_color(t.muted).flex_none().child(subRight));
              }),
            ),
        )
        .child(
          h_flex()
            .border_t(1)
            .border_color(t.border)
            .px(12)
            .py(6)
            .items_center()
            .justify_between()
            .child(
              div()
                .id("pop-cl-details")
                .px(8)
                .py(4)
                .rounded(6)
                .text_size(12)
                .text_color(t.muted)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click(() => {
                  if (overlayId) closeOverlay(overlayId);
                  patchPrefs({ overviewScope: "claude" });
                  this.openDetails("overview");
                })
                .child(L.usageDetailsHistory),
            )
            .child(
              div()
                .id("pop-cl-manage")
                .px(8)
                .py(4)
                .rounded(6)
                .text_size(12)
                .text_color(t.muted)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click(() => {
                  if (overlayId) closeOverlay(overlayId);
                  this.openDetails("settings");
                })
                .child(L.manageAccounts),
            ),
        );
    }

    return v_flex()
      .w_full()
      .bg(t.popover)
      .text_color(t.foreground)
      .child(
        h_flex()
          .px(14)
          .pt(12)
          .pb(8)
          .items_center()
          .justify_between()
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(div().text_size(13).font_semibold().child(L.usage))
              .child(div().text_size(12.5).text_color(t.dim).child(`· ${L.allAgents}`))
              .child(
                div()
                  .id("pop-refresh")
                  .p(4)
                  .rounded(5)
                  .text_color(t.dim)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => this.fetchUsage(cx, true))
                  .child(
                    svg("mods/usage-meter/refresh.svg")
                      .size(13)
                      .when(st.loading, (s) => s.spin(900)),
                  ),
              ),
          )
          .child(
            h_flex()
              .id("pop-toggle-mode")
              .gap(4)
              .px(6)
              .py(3)
              .rounded(5)
              .items_center()
              .text_size(12)
              .text_color(t.muted)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click(() =>
                patchPrefs({
                  displayMode: prefs.displayMode === "used" ? "remaining" : "used",
                }),
              )
              .child(prefs.displayMode === "remaining" ? L.remaining : L.used)
              .child(svg("mods/usage-meter/arrows-up-down.svg").size(12)),
          ),
      )
      .child(
        div()
          .px(14)
          .pb(8)
          .border_b(1)
          .border_color(t.border)
          .child(
            h_flex()
              .p(2)
              .gap(2)
              .rounded(8)
              .bg(t.chrome)
              .border(1)
              .border_color(t.border)
              .child(segBtn("seg-det", L.detailed, L.detailedTip, detailed))
              .child(segBtn("seg-cmp", L.compact, L.compactTip, !detailed)),
          ),
      )
      .child(
        v_flex()
          .px(10)
          .py(6)
          .gap(4)
          // Claude profiles
          .when(pv.claude, (el) =>
            el.children(
              clShown.map((cl, idx) => {
                const cm = profileMeta(cl, prefs);
                const resetText = cl?.session?.resetsAt
                  ? formatResetLong(cl.session.resetsAt, now, L)
                  : "";
                const title =
                  cl.profile && cl.profile !== ".claude"
                    ? cl.kind === "harness"
                      ? cm.label
                      : `Claude (${cm.label})`
                    : cm.label === "Padrão"
                      ? "Claude"
                      : `Claude (${cm.label})`;
                return v_flex()
                  .id(`pop-claude-${idx}`)
                  .px(8)
                  .py(7)
                  .gap(5)
                  .rounded(8)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => {
                    this.popView = "claude";
                    cx.notify();
                  })
                  .child(
                    h_flex()
                      .items_center()
                      .justify_between()
                      .child(
                        h_flex()
                          .gap(7)
                          .items_center()
                          .child(providerIcon(cm.icon, 15, t.foreground))
                          .child(div().text_size(12.5).font_semibold().child(title))
                          .when(Boolean(cl?.plan), (e) =>
                            e.child(div().text_size(11.5).text_color(t.muted).child(`· ${cl.plan}`)),
                          )
                          .when(Boolean(cl?.rateLimited && cl?.stale), (e) =>
                            e.child(div().text_size(10.5).text_color(t.blocked || t.dim).child(`(${L.staleCacheTag})`)),
                          )
                          .when(Boolean(resetText), (e) =>
                            e.child(div().text_size(11).text_color(t.dim).child(resetText)),
                          ),
                      )
                      .child(svg("mods/usage-meter/chevron-right.svg").size(13).text_color(t.dim)),
                  )
                  .when(cl?.kind === "harness", (e) =>
                    e.child(
                      div()
                        .pl(22)
                        .text_size(11)
                        .text_color(t.muted)
                        .child(
                          `${translateStatus(cl.status, L)} · ${L.today}: ${fmtTokens(cl.todayTokens || 0)} (${cl.todayMessages || 0} ${L.msgs}) · 7d: ${fmtTokens(cl.d7Tokens || 0)}`,
                        ),
                    ),
                  )
                  .when(cl?.status === "ok" && cl?.kind !== "harness" && detailed, (e) => {
                    const profCost = d?.costs?.byProfile7d?.find((x) => x.name === cl.label);
                    return e
                      .child(
                        h_flex()
                          .pl(22)
                          .gap(12)
                          .items_center()
                          .child(metricChip("5h", cl.session?.percent ?? 0))
                          .child(metricChip(L.weekShort, cl.weekly?.percent ?? 0))
                          .when(cl.fable !== null && cl.fable !== undefined, (x) =>
                            x.child(metricChip("Fable", cl.fable.percent ?? 0)),
                          ),
                      )
                      .when(prefs.showEstimatedCost && prefs.showCostInPopover && idx === 0 && todayCost !== undefined, (x) =>
                        x.child(
                          div()
                            .pl(22)
                            .text_size(10.5)
                            .text_color(t.dim)
                            .child(`${L.estApiCost}: ${fmtUsd(todayCost)} ${L.today.toLowerCase()} · ${fmtUsd(d7Cost)} (7d)`),
                        ),
                      )
                      .when(prefs.showEstimatedCost && prefs.showCostInPopover && idx > 0 && Boolean(profCost), (x) =>
                        x.child(
                          div()
                            .pl(22)
                            .text_size(10.5)
                            .text_color(t.dim)
                            .child(`${L.estApiCost}: ${fmtUsd(profCost.todayCost)} ${L.today.toLowerCase()} · ${fmtUsd(profCost.cost7d)} (7d)`),
                        ),
                      );
                  })
                  .when(cl?.status === "ok" && cl?.kind !== "harness" && !detailed, (e) =>
                    e.child(
                      h_flex()
                        .pl(22)
                        .gap(8)
                        .items_center()
                        .child(meterBar(cl.session?.percent ?? 0, 110, 5, t, prefs.displayMode))
                        .child(
                          div()
                            .text_size(11)
                            .text_color(t.muted)
                            .child(
                              `${displayPct(cl.session?.percent ?? 0, prefs.displayMode)}% 5h · ${displayPct(cl.weekly?.percent ?? 0, prefs.displayMode)}% ${L.weekShort}`,
                            ),
                        ),
                    ),
                  )
                  .when(cl?.status !== "ok" && cl?.kind !== "harness", (e) =>
                    e.child(
                      div()
                        .pl(22)
                        .text_size(11)
                        .text_color(t.dim)
                        .child(translateStatus(cl?.status, L)),
                    ),
                  );
              }),
            ),
          )
          // Antigravity
          .when(pv.antigravity, (el) =>
            el.child(
              v_flex()
                .id("pop-agy")
                .px(8)
                .py(7)
                .gap(5)
                .rounded(8)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => {
                  this.popView = "antigravity";
                  cx.notify();
                })
                .child(
                  h_flex()
                    .items_center()
                    .justify_between()
                    .child(
                      h_flex()
                        .gap(7)
                        .items_center()
                        .child(image("icons/antigravity.svg").size(15).flex_none())
                        .child(div().text_size(12.5).font_semibold().child("Antigravity"))
                        .when(Boolean(agResetText), (e) =>
                          e.child(div().text_size(11).text_color(t.dim).child(agResetText)),
                        ),
                    )
                    .child(svg("mods/usage-meter/chevron-right.svg").size(13).text_color(t.dim)),
                )
                .when(ag?.status === "ok" && detailed, (e) =>
                  e
                    .child(
                      h_flex()
                        .pl(22)
                        .gap(14)
                        .items_center()
                        .child(metricChip(`Gemini ${L.weekShort}`, agGem?.weekly?.percent ?? 0))
                        .child(metricChip("Gemini 5h", agGem?.h5?.percent ?? 0)),
                    )
                    .child(
                      h_flex()
                        .pl(22)
                        .gap(14)
                        .items_center()
                        .child(metricChip(`Claude/GPT ${L.weekShort}`, agCl?.weekly?.percent ?? 0))
                        .child(metricChip("Claude/GPT 5h", agCl?.h5?.percent ?? 0)),
                    ),
                )
                .when(ag?.status === "ok" && !detailed, (e) =>
                  e.child(
                    h_flex()
                      .pl(22)
                      .gap(8)
                      .items_center()
                      .child(meterBar(agGem?.h5?.percent ?? 0, 110, 5, t, prefs.displayMode))
                      .child(
                        div()
                          .text_size(11)
                          .text_color(t.muted)
                          .child(
                            `Gem ${displayPct(agGem?.h5?.percent ?? 0, prefs.displayMode)}%/${displayPct(agGem?.weekly?.percent ?? 0, prefs.displayMode)}% · Cl/GPT ${displayPct(agCl?.h5?.percent ?? 0, prefs.displayMode)}%`,
                          ),
                      ),
                  ),
                ),
            ),
          )
          // Codex
          .when(
            pv.codex && Boolean(cxData && (cxData.status === "ok" || cxData.status === "cached_session")),
            (el) =>
              el.child(
                h_flex()
                  .id("pop-codex")
                  .px(8)
                  .py(6)
                  .rounded(8)
                  .items_center()
                  .justify_between()
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click(() => {
                    if (overlayId) closeOverlay(overlayId);
                    this.openDetails("agents");
                  })
                  .child(
                    h_flex()
                      .gap(7)
                      .items_center()
                      .child(providerIcon("icons/codex.svg", 14, t.foreground))
                      .child(div().text_size(12).font_semibold().child("Codex"))
                      .child(
                        div()
                          .text_size(11)
                          .text_color(t.dim)
                          .child(`${translateStatus(cxData.status, L)} · ${fmtTokens(cxData.totalTokens)} tok`),
                      ),
                  )
                  .child(
                    h_flex()
                      .gap(6)
                      .items_center()
                      .when(Boolean(cxData.weekly), (e) =>
                        e.child(metricChip(L.weekShort, cxData.weekly.percent, 28)),
                      )
                      .child(svg("mods/usage-meter/chevron-right.svg").size(13).text_color(t.dim)),
                  ),
              ),
          )
          // OpenCode
          .when(pv.opencode && Boolean(oc && oc.status === "ok"), (el) =>
            el.child(
              h_flex()
                .id("pop-opencode")
                .px(8)
                .py(6)
                .rounded(8)
                .items_center()
                .justify_between()
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                  .on_click(() => {
                    if (overlayId) closeOverlay(overlayId);
                    this.openDetails("agents");
                  })
                  .child(
                    h_flex()
                      .gap(7)
                      .items_center()
                      .child(providerIcon("icons/opencode.svg", 14, t.foreground))
                    .child(div().text_size(12).font_semibold().child("OpenCode"))
                    .child(
                      div()
                        .text_size(11)
                        .text_color(t.dim)
                        .child(`${oc.sessionsCount} ${L.sessions} · ${oc.allTimeMessages} ${L.msgs}`),
                    ),
                )
                .child(
                  h_flex()
                    .gap(6)
                    .items_center()
                    .child(div().text_size(11).text_color(t.muted).child(fmtTokens(oc.allTimeTokens)))
                    .child(svg("mods/usage-meter/chevron-right.svg").size(13).text_color(t.dim)),
                ),
            ),
          )
          // Optional extra providers explicitly enabled in granular settings
          .when(othersShown.length > 0, (el) =>
            el.child(
              h_flex()
                .px(8)
                .py(4)
                .gap(6)
                .items_center()
                .children(
                  othersShown.map((o) =>
                    h_flex()
                      .id(`pop-oth-${o.id}`)
                      .gap(4)
                      .px(6)
                      .py(2)
                      .rounded(5)
                      .bg(t.surface)
                      .border(1)
                      .border_color(t.border)
                      .items_center()
                      .cursor_pointer()
                      .hover((s) => s.bg(t.hover))
                      .on_click(() => {
                        if (overlayId) closeOverlay(overlayId);
                        this.openDetails("agents");
                      })
                      .child(providerIcon(o.icon, 11, t.foreground))
                      .child(
                        div()
                          .text_size(10.5)
                          .text_color(o.authenticated ? t.foreground : t.dim)
                          .child(`${o.name.split(" ")[0]} · ${translateStatus(o.status, L)}`),
                      ),
                  ),
                ),
            ),
          ),
      )
      .child(
        v_flex()
          .border_t(1)
          .border_color(t.border)
          .px(8)
          .py(6)
          .gap(2)
          .child(
            h_flex()
              .id("pop-details-row")
              .h(30)
              .px(8)
              .rounded(7)
              .items_center()
              .justify_between()
              .text_size(12.5)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click(() => {
                if (overlayId) closeOverlay(overlayId);
                this.openDetails("overview");
              })
              .child(L.usageDetailsHistory)
              .child(svg("mods/usage-meter/chevron-right.svg").size(14).text_color(t.dim)),
          )
          .when(pv.ports || pv.system, (el) =>
            el.child(
              h_flex()
                .id("pop-sys-row")
                .h(30)
                .px(8)
                .rounded(7)
                .items_center()
                .justify_between()
                .text_size(12.5)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click(() => {
                  if (overlayId) closeOverlay(overlayId);
                  this.openDetails(pv.ports ? "ports" : "system");
                })
                .child(`${L.portsAndSystem} (${portsCount} · ${sys?.cpuPercent ?? 0}% CPU)`)
                .child(svg("mods/usage-meter/chevron-right.svg").size(14).text_color(t.dim)),
            ),
          )
          .child(
            h_flex()
              .id("pop-accounts-row")
              .h(30)
              .px(8)
              .rounded(7)
              .items_center()
              .justify_between()
              .text_size(12.5)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click(() => {
                if (overlayId) closeOverlay(overlayId);
                this.openDetails("settings");
              })
              .child(L.settingsAndAccounts)
              .child(svg("mods/usage-meter/chevron-right.svg").size(14).text_color(t.dim)),
          ),
      );
  }

  renderDetails(t, st, prefs) {
    const { L } = this.langStrings(st, prefs);
    const now = Date.now();
    const d = st.data;
    const costs = d?.costs;
    const totals = costs?.totals;
    const periodKey = prefs.period || prefs.defaultPeriod || "today";
    const activeBucket = totals?.[periodKey] || totals?.today;
    const cl = d?.claude;
    const pv = prefs.providers;
    const clProfilesAll = d?.claudeProfiles ?? (cl ? [cl] : []);
    const clProfiles = prefs.hideUnauthProfiles
      ? clProfilesAll.filter(
          (p) =>
            p.status === "ok" ||
            p.status === "rate_limited" ||
            (pv.harness && p.kind === "harness"),
        )
      : clProfilesAll;
    const ag = d?.antigravity;
    const cxData = d?.codex;
    const oc = d?.opencode;
    const others = d?.others ?? [];
    const ports = d?.ports ?? [];
    const sys = d?.system;
    const overlayId = props()?.overlay;
    const activeTab = prefs.tab || "overview";

    const sectionHeading = (title, right = null) =>
      h_flex()
        .pt(6)
        .pb(6)
        .items_center()
        .justify_between()
        .child(div().text_size(11).font_semibold().text_color(t.dim).child(title.toUpperCase()))
        .when(Boolean(right), (el) => el.child(div().text_size(11).text_color(t.dim).child(right)));

    const navBtn = (id, label, iconPath, badge = null) => {
      const on = activeTab === id;
      return h_flex()
        .id(`dt-${id}`)
        .gap(10)
        .px(10)
        .py(7)
        .items_center()
        .rounded(7)
        .cursor_pointer()
        .bg(on ? t.raised : "#00000000")
        .hover((s) => s.bg(t.raised))
        .on_click(() => {
          patchPrefs({ tab: id });
          if (id === "ports" || id === "system") {
            this.fetchSysOnly({ notify: () => {} });
          }
        })
        .child(svg(iconPath).size(14.5).flex_none().text_color(on ? t.accent : t.dim))
        .child(div().flex_1().text_size(13).text_color(on ? t.foreground : t.muted).child(label))
        .when(badge !== null && badge !== undefined, (el) =>
          el.child(div().text_size(11).text_color(on ? t.foreground : t.dim).child(String(badge))),
        );
    };

    const railBtn = (id, label, onClick, spinning = false) =>
      h_flex()
        .id(id)
        .w_full()
        .px(10)
        .py(6)
        .gap(6)
        .rounded(7)
        .border_1()
        .border_color(t.border)
        .bg(t.raised)
        .items_center()
        .justify_center()
        .cursor_pointer()
        .text_size(12)
        .text_color(t.foreground)
        .hover((s) => s.bg(t.hover))
        .on_click(onClick)
        .when(spinning, (el) =>
          el.child(svg("mods/usage-meter/refresh.svg").size(12).spin(900)),
        )
        .child(label);

    const periodPill = (id, label) => {
      const active = periodKey === id;
      return div()
        .id(`per-${id}`)
        .px(8)
        .py(3)
        .rounded(5)
        .text_size(11.5)
        .cursor_pointer()
        .bg(active ? t.raised : "#00000000")
        .text_color(active ? t.foreground : t.muted)
        .hover((s) => s.text_color(t.foreground))
        .on_click(() => patchPrefs({ period: id }))
        .child(label);
    };

    const kpiCell = (title, value, sub, hasRightBorder = true) =>
      v_flex()
        .flex_1()
        .min_w(0)
        .px(12)
        .py(10)
        .gap(3)
        .when(hasRightBorder, (el) => el.border_r(1).border_color(t.border))
        .child(div().text_size(11).text_color(t.dim).truncate().child(title))
        .child(div().text_size(17).font_semibold().text_color(t.foreground).truncate().child(value))
        .child(div().text_size(10.5).text_color(t.muted).truncate().child(sub));

    const shareBar = (pct, widthPx, heightPx, accent = false) => {
      const clamped = Math.max(0, Math.min(100, pct || 0));
      const fillW = clamped <= 0 ? 0 : Math.max(3, Math.round((clamped / 100) * widthPx));
      return div()
        .w(widthPx)
        .h(heightPx)
        .flex_none()
        .rounded(Math.ceil(heightPx / 2))
        .bg(t.border)
        .overflow_hidden()
        .when(fillW > 0, (el) =>
          el.child(
            div()
              .w(fillW)
              .h(heightPx)
              .rounded(Math.ceil(heightPx / 2))
              .bg(accent ? t.accent : t.muted),
          ),
        );
    };

    const overviewScope = prefs.overviewScope || "all";
    const daily14 =
      overviewScope === "harness"
        ? costs?.harness?.daily14 ?? []
        : costs?.daily14 ?? [];
    const maxDayTokens = Math.max(1, ...daily14.map((r) => r.tokens || 0));
    const harnessTotals = costs?.harness?.totals;
    const activeHarnessBucket = harnessTotals?.[periodKey] || harnessTotals?.today;
    const scopeBucket =
      overviewScope === "harness"
        ? activeHarnessBucket
        : activeBucket;
    const topModel = (costs?.byModel7d ?? [])[0];
    const topProject = (costs?.byProject7d ?? [])[0];
    const harnessModels = costs?.harness?.byModel7d ?? [];
    const models7d = costs?.byModel7d ?? [];
    const heatmap35 = costs?.heatmap35 ?? [];
    const hm30 = heatmap35.slice(-30);
    const hmRows = [];
    for (let i = 0; i < hm30.length; i += 10) {
      hmRows.push(hm30.slice(i, i + 10));
    }

    const combinedTokensAll =
      (activeBucket?.tokens || 0) +
      (activeHarnessBucket?.tokens || 0) +
      (periodKey === "today" ? oc?.todayTokens || 0 : periodKey === "d7" ? oc?.d7Tokens || 0 : oc?.d30Tokens || 0);
    const combIn = (activeBucket?.input || 0) + (activeHarnessBucket?.input || 0);
    const combOut = (activeBucket?.output || 0) + (activeHarnessBucket?.output || 0);
    const combCache =
      (activeBucket?.cacheRead || 0) +
      (activeBucket?.cacheWrite || 0) +
      (activeHarnessBucket?.cacheRead || 0) +
      (activeHarnessBucket?.cacheWrite || 0);
    const combSum = Math.max(1, combIn + combOut + combCache);

    const cInput = t.accent;
    const cOutput = t.done || t.ansi2 || t.accent;
    const cRead = t.working || t.ansi3 || t.muted;
    const cWrite = t.ansi5 || t.dim;

    const legendItem = (label, color) =>
      h_flex()
        .gap(5)
        .items_center()
        .child(div().size(6).rounded(3).bg(color))
        .child(div().text_size(11).text_color(t.muted).child(label));

    const scopePill = (id, label) => {
      const on = overviewScope === id;
      return div()
        .id(`scp-${id}`)
        .px(8)
        .py(3)
        .rounded(5)
        .text_size(11.5)
        .cursor_pointer()
        .bg(on ? t.raised : "#00000000")
        .text_color(on ? t.foreground : t.muted)
        .hover((s) => s.text_color(t.foreground))
        .on_click(() => patchPrefs({ overviewScope: id }))
        .child(label);
    };

    const orcaKpi = (title, value, sub = null) =>
      v_flex()
        .flex_1()
        .min_w(0)
        .p(12)
        .gap(3)
        .rounded(8)
        .bg(t.surface)
        .border_1()
        .border_color(t.border)
        .child(div().text_size(17).font_semibold().text_color(t.foreground).truncate().child(value))
        .child(div().text_size(11).text_color(t.muted).truncate().child(title))
        .when(Boolean(sub), (el) => el.child(div().text_size(10).text_color(t.dim).truncate().child(sub)));

    const heatColor = (lvl) =>
      lvl === 0
        ? t.chrome
        : lvl === 1
          ? t.border
          : lvl === 2
            ? t.dim
            : lvl === 3
              ? t.muted
              : t.accent;

    const providerCard = (id, name, iconPath, enabled, topText, leftText, metaText, rightText, onOpen) =>
      v_flex()
        .id(`ov-pv-${id}`)
        .flex_1()
        .min_w(0)
        .p(10)
        .gap(4)
        .rounded(8)
        .bg(t.surface)
        .border_1()
        .border_color(t.border)
        .cursor_pointer()
        .hover((s) => s.bg(t.raised))
        .on_click(onOpen)
        .child(
          h_flex()
            .items_center()
            .justify_between()
            .gap(6)
            .child(
              h_flex()
                .gap(6)
                .flex_1()
                .min_w(0)
                .items_center()
                .child(providerIcon(iconPath, 13, t.foreground))
                .child(div().text_size(12.5).font_semibold().text_color(t.foreground).truncate().child(name))
                .child(div().size(5).rounded(3).flex_none().bg(enabled ? (t.done || t.accent) : t.dim)),
            )
            .when(Boolean(rightText), (e) =>
              e.child(div().text_size(12).font_semibold().text_color(t.foreground).flex_none().child(rightText)),
            ),
        )
        .child(div().text_size(11).text_color(t.dim).truncate().child(topText || "—"))
        .child(
          h_flex()
            .items_center()
            .justify_between()
            .text_size(11)
            .child(div().text_color(t.muted).child(leftText))
            .child(div().text_color(t.dim).child(metaText || "")),
        );

    const showUsd = prefs.showEstimatedCost !== false;

    const overviewAllPane = () => {
      const bestLabel = costs?.bestDay?.date ? costs.bestDay.date.slice(5) : "—";
      const harnessProfFirst = clProfilesAll.find((p) => p.kind === "harness");
      const hCostCardTok = activeHarnessBucket?.tokens || 0;
      const cachePct = Math.round((combCache / combSum) * 100);
      return v_flex()
        .gap(12)
        // Single unified 4-cell KPI strip
        .child(
          h_flex()
            .w_full()
            .rounded(8)
            .bg(t.surface)
            .border_1()
            .border_color(t.border)
            .child(
              kpiCell(
                L.totalTokensLabel,
                fmtTokens(combinedTokensAll),
                periodKey === "today" ? L.today : periodKey === "d7" ? L.last7d : L.last30d,
              ),
            )
            .child(
              showUsd
                ? kpiCell(
                    L.estCostShort,
                    activeBucket ? fmtUsd(activeBucket.cost) : "—",
                    topModel ? `${L.topModelLabel} ${topModel.name.replace("claude-", "")}` : L.noData,
                  )
                : kpiCell(
                    L.sessionsTurnsLabel,
                    `${activeBucket?.sessions ?? 0} / ${activeBucket?.messages ?? 0}`,
                    topModel ? `${L.topModelLabel} ${topModel.name.replace("claude-", "")}` : L.noData,
                  ),
            )
            .child(
              kpiCell(
                L.activeDaysLabel,
                String(costs?.activeDays30 ?? 0),
                "30d",
              ),
            )
            .child(
              kpiCell(
                L.cacheShareLabel,
                `${cachePct}%`,
                `${fmtTokens(combCache)} cache`,
                false,
              ),
            ),
        )
        // Side-by-side: Intensidade diária (crisp 10x3 square heatmap) + Mistura de tokens
        .child(
          h_flex()
            .gap(10)
            .items_stretch()
            .child(
              v_flex()
                .flex_1()
                .min_w(0)
                .p(12)
                .gap(8)
                .rounded(8)
                .bg(t.surface)
                .border_1()
                .border_color(t.border)
                .child(
                  h_flex()
                    .items_center()
                    .justify_between()
                    .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(L.dailyIntensityTitle))
                    .child(
                      div()
                        .px(6)
                        .py(2)
                        .rounded(4)
                        .bg(t.chrome)
                        .text_size(10.5)
                        .text_color(t.muted)
                        .child(`${L.bestDayLabel} ${bestLabel}`),
                    ),
                )
                .child(div().text_size(11).text_color(t.dim).child(L.dailyIntensityDesc))
                .child(
                  v_flex()
                    .gap(5)
                    .pt(2)
                    .children(
                      hmRows.map((row, ri) =>
                        h_flex()
                          .gap(6)
                          .children(
                            row.map((cell, ci) =>
                              div()
                                .id(`hm-${ri}-${ci}`)
                                .size(19)
                                .rounded(3)
                                .bg(heatColor(cell.level))
                                .tooltip(
                                  showUsd
                                    ? `${cell.date}: ${fmtTokens(cell.tokens)} tok · ${fmtUsd(cell.cost)}`
                                    : `${cell.date}: ${fmtTokens(cell.tokens)} tok`,
                                ),
                            ),
                          ),
                      ),
                    ),
                )
                .child(div().flex_1())
                .child(
                  h_flex()
                    .pt(2)
                    .items_center()
                    .justify_between()
                    .text_size(10.5)
                    .text_color(t.dim)
                    .child(hm30[0]?.date?.slice(5) || "")
                    .child(
                      h_flex()
                        .gap(3)
                        .items_center()
                        .child(L.lessLabel)
                        .children([0, 1, 2, 3, 4].map((lv) => div().size(8).rounded(2).bg(heatColor(lv))))
                        .child(L.moreLabel),
                    )
                    .child(hm30.at(-1)?.date?.slice(5) || ""),
                ),
            )
            .child(
              v_flex()
                .flex_1()
                .min_w(0)
                .p(12)
                .gap(9)
                .rounded(8)
                .bg(t.surface)
                .border_1()
                .border_color(t.border)
                .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(L.tokenMixTitle))
                .child(div().text_size(11).text_color(t.dim).child(L.tokenMixDesc))
                .child(
                  (() => {
                    const barW = 258;
                    const wIn = combIn > 0 ? Math.max(4, Math.round((combIn / combSum) * barW)) : 0;
                    const wOut = combOut > 0 ? Math.max(4, Math.round((combOut / combSum) * barW)) : 0;
                    const wCa = Math.max(0, barW - wIn - wOut);
                    return h_flex()
                      .w(barW)
                      .h(8)
                      .rounded(4)
                      .bg(t.chrome)
                      .overflow_hidden()
                      .when(wIn > 0, (e) => e.child(div().w(wIn).h_full().bg(cInput)))
                      .when(wOut > 0, (e) => e.child(div().w(wOut).h_full().bg(cOutput)))
                      .when(wCa > 0, (e) => e.child(div().w(wCa).h_full().bg(cRead)));
                  })(),
                )
                .child(
                  v_flex()
                    .gap(5)
                    .child(
                      h_flex()
                        .justify_between()
                        .text_size(11.5)
                        .child(legendItem(L.inShort, cInput))
                        .child(div().text_color(t.foreground).child(fmtTokens(combIn))),
                    )
                    .child(
                      h_flex()
                        .justify_between()
                        .text_size(11.5)
                        .child(legendItem(L.outShort, cOutput))
                        .child(div().text_color(t.foreground).child(fmtTokens(combOut))),
                    )
                    .child(
                      h_flex()
                        .justify_between()
                        .text_size(11.5)
                        .child(legendItem("Cache", cRead))
                        .child(div().text_color(t.foreground).child(fmtTokens(combCache))),
                    ),
                ),
            ),
        )
        // Dynamic Provedores grid covering Claude, Harness, Antigravity (Gemini), Codex, OpenCode & active CLI agents
        .child(sectionHeading(L.providersSection, `${L.sessions}: ${activeBucket?.sessions ?? 0}`))
        .child(
          (() => {
            const agGemG = ag?.groups?.find((g) => g.shortName === "Gemini");
            const agClG = ag?.groups?.find((g) => g.shortName === "Claude/GPT");
            const cards = [
              providerCard(
                "claude",
                "Claude",
                "icons/claude.svg",
                Boolean(pv.claude),
                `${topModel?.name || "—"} · ${topProject?.name || "—"}`,
                fmtTokens(activeBucket?.tokens || 0),
                `${activeBucket?.sessions || 0} ${L.sessions} · ${activeBucket?.messages || 0} ${L.msgs}`,
                showUsd && activeBucket ? fmtUsd(activeBucket.cost) : `${activeBucket?.cacheReusePct ?? 0}% cache`,
                () => patchPrefs({ overviewScope: "claude" }),
              ),
              providerCard(
                "harness",
                "Harness (LiteLLM)",
                profileMeta(harnessProfFirst, prefs).icon,
                Boolean(pv.harness && harnessProfFirst?.gatewayUp),
                `${harnessModels[0]?.name || harnessProfFirst?.defaultModel || "LiteLLM"}`,
                fmtTokens(hCostCardTok),
                `${activeHarnessBucket?.sessions || 0} ${L.sessions} · ${activeHarnessBucket?.messages || 0} ${L.msgs}`,
                showUsd ? "$0.00" : `${activeHarnessBucket?.cacheReusePct ?? 0}% cache`,
                () => patchPrefs({ overviewScope: "harness" }),
              ),
              ...(ag && (pv.antigravity || ag.status === "ok")
                ? [
                    providerCard(
                      "antigravity",
                      "Antigravity (Gemini)",
                      profileMeta({ profile: "__antigravity__", defaultIcon: "icons/antigravity.svg" }, prefs).icon,
                      Boolean(pv.antigravity && ag.status === "ok"),
                      ag.model || "Gemini · Claude/GPT",
                      `${ag.conversations ?? 0} ${L.conversationsLocal}`,
                      agClG?.h5 ? `Cl/GPT ${displayPct(agClG.h5.percent, prefs.displayMode)}%` : "",
                      ag.status === "ok" && agGemG
                        ? `Gem ${displayPct(agGemG.h5?.percent ?? 0, prefs.displayMode)}% · ${displayPct(agGemG.weekly?.percent ?? 0, prefs.displayMode)}%`
                        : translateStatus(ag.status, L),
                      () => patchPrefs({ tab: "agents" }),
                    ),
                  ]
                : []),
              ...(cxData && (pv.codex || cxData.sessionsCount > 0)
                ? [
                    providerCard(
                      "codex",
                      "Codex",
                      profileMeta({ profile: "__codex__", defaultIcon: "icons/codex.svg" }, prefs).icon,
                      Boolean(pv.codex && cxData.status !== "unavailable"),
                      cxData.plan || "OpenAI Codex CLI",
                      fmtTokens(cxData.totalTokens || 0),
                      `${cxData.sessionsCount || 0} ${L.sessions}`,
                      cxData.weekly ? `${displayPct(cxData.weekly.percent, prefs.displayMode)}% ${L.weekShort}` : null,
                      () => patchPrefs({ tab: "agents" }),
                    ),
                  ]
                : []),
              ...(oc && (pv.opencode || oc.allTimeTokens > 0)
                ? [
                    providerCard(
                      "opencode",
                      "OpenCode",
                      profileMeta({ profile: "__opencode__", defaultIcon: "icons/opencode.svg" }, prefs).icon,
                      Boolean(pv.opencode && oc.status === "ok"),
                      oc.topModels7d?.[0]?.name || "OpenCode",
                      fmtTokens(oc.allTimeTokens || 0),
                      `${oc.sessionsCount || 0} ${L.sessions} · ${oc.allTimeMessages || 0} ${L.msgs}`,
                      showUsd && oc.allTimeCost ? fmtUsd(oc.allTimeCost) : null,
                      () => patchPrefs({ tab: "agents" }),
                    ),
                  ]
                : []),
              ...others
                .filter((o) => pv[o.id] || o.authenticated)
                .map((o) =>
                  providerCard(
                    `oth-${o.id}`,
                    o.name,
                    o.icon,
                    Boolean(o.authenticated),
                    o.detail || translateStatus(o.status, L),
                    translateStatus(o.status, L),
                    o.installed ? "CLI" : "",
                    null,
                    () => patchPrefs({ tab: "agents" }),
                  ),
                ),
            ];
            const cardRows = [];
            for (let i = 0; i < cards.length; i += 2) {
              const pair = cards.slice(i, i + 2);
              cardRows.push(
                h_flex()
                  .gap(10)
                  .children(pair)
                  .when(pair.length === 1, (row) => row.child(div().flex_1())),
              );
            }
            return v_flex().gap(8).children(cardRows);
          })(),
        );
    };

    const overviewProviderPane = () => {
      const isHarness = overviewScope === "harness";
      const listModels = isHarness ? harnessModels : models7d;
      const listProjects = isHarness ? [] : costs?.byProject7d ?? [];
      return v_flex()
        .gap(12)
        // Two aligned unified 4-cell KPI strips matching Overview precision
        .child(
          v_flex()
            .gap(8)
            .child(
              h_flex()
                .w_full()
                .rounded(8)
                .bg(t.surface)
                .border_1()
                .border_color(t.border)
                .items_stretch()
                .child(kpiCell(L.inputTokens, fmtTokens(scopeBucket?.input), periodKey === "today" ? L.today : periodKey === "d7" ? L.last7d : L.last30d))
                .child(kpiCell(L.outputTokens, fmtTokens(scopeBucket?.output), L.outShort))
                .child(kpiCell(L.cacheReadTokens, fmtTokens(scopeBucket?.cacheRead), L.crShort))
                .child(kpiCell(L.cacheWriteTokens, fmtTokens(scopeBucket?.cacheWrite), L.cwShort, false)),
            )
            .child(
              h_flex()
                .w_full()
                .rounded(8)
                .bg(t.surface)
                .border_1()
                .border_color(t.border)
                .items_stretch()
                .child(kpiCell(L.cacheReuse, `${scopeBucket?.cacheReusePct ?? 0}%`, "Read / (In + Read)"))
                .child(kpiCell(L.zeroCacheLabel, `${scopeBucket?.zeroCachePct ?? 0}%`, `${scopeBucket?.zeroCacheTurns ?? 0} ${L.msgs}`))
                .child(
                  kpiCell(
                    L.sessionsTurnsLabel,
                    `${scopeBucket?.sessions ?? 0} / ${scopeBucket?.messages ?? 0}`,
                    isHarness ? "Harness" : "Claude",
                  ),
                )
                .child(
                  showUsd
                    ? kpiCell(
                        L.estCostShort,
                        isHarness ? "$0.00" : scopeBucket ? fmtUsd(scopeBucket.cost) : "—",
                        L.excludesUnpriced,
                        false,
                      )
                    : kpiCell(
                        L.totalTokensLabel,
                        fmtTokens(scopeBucket?.tokens),
                        periodKey === "today" ? L.today : periodKey === "d7" ? L.last7d : L.last30d,
                        false,
                      ),
                ),
            ),
        )
        // Orca Uso diário stacked columns inside dark rounded tracks (Screenshot 3)
        .child(
          v_flex()
            .p(14)
            .gap(10)
            .rounded(8)
            .bg(t.surface)
            .border_1()
            .border_color(t.border)
            .child(
              v_flex()
                .gap(2)
                .child(div().text_size(13).font_semibold().text_color(t.foreground).child(L.dailyChart))
                .child(div().text_size(11).text_color(t.dim).child(L.dailyUsageDesc)),
            )
            .child(
              h_flex()
                .h(124)
                .pt(6)
                .gap(6)
                .items_end()
                .children(
                  daily14.map((r) => {
                    const tot = r.tokens || 0;
                    const trackH = 82;
                    const barH = tot > 0 ? Math.max(4, Math.round((tot / maxDayTokens) * trackH)) : 0;
                    const cw = r.cacheWrite || 0;
                    const cr = r.cacheRead || 0;
                    const out = r.output || 0;
                    const inp = r.input || 0;
                    const hCw = cw > 0 && barH > 0 ? Math.max(1, Math.round((cw / tot) * barH)) : 0;
                    const hOut = out > 0 && barH > 0 ? Math.max(1, Math.round((out / tot) * barH)) : 0;
                    const hIn = inp > 0 && barH > 0 ? Math.max(1, Math.round((inp / tot) * barH)) : 0;
                    const hCr = barH > 0 ? Math.max(0, barH - hCw - hOut - hIn) : 0;
                    const mmdd = r.date.slice(5);
                    const isToday = r.date === daily14.at(-1)?.date;
                    return v_flex()
                      .flex_1()
                      .items_center()
                      .justify_end()
                      .gap(4)
                      .tooltip(
                        `${r.date}${showUsd ? ` · ${isHarness ? "$0.00" : fmtUsd(r.cost)}` : ""} · ${r.messages} ${L.msgs}\n${L.inShort}: ${fmtTokens(inp)} · ${L.outShort}: ${fmtTokens(out)}\n${L.crShort}: ${fmtTokens(cr)} · ${L.cwShort}: ${fmtTokens(cw)}`,
                      )
                      .child(
                        div()
                          .text_size(9.5)
                          .text_color(t.dim)
                          .child(tot > 0 ? fmtTokens(tot) : ""),
                      )
                      .child(
                        v_flex()
                          .w_full()
                          .h(trackH)
                          .rounded(4)
                          .bg(t.chrome)
                          .overflow_hidden()
                          .justify_end()
                          .when(barH > 0, (b) =>
                            b
                              .when(hIn > 0, (x) => x.child(div().w_full().h(hIn).bg(cInput)))
                              .when(hOut > 0, (x) => x.child(div().w_full().h(hOut).bg(cOutput)))
                              .when(hCw > 0, (x) => x.child(div().w_full().h(hCw).bg(cWrite)))
                              .when(hCr > 0, (x) => x.child(div().w_full().h(hCr).bg(cRead))),
                          ),
                      )
                      .child(
                        div()
                          .text_size(9.5)
                          .text_color(isToday ? t.accent : t.dim)
                          .when(isToday, (x) => x.font_semibold())
                          .child(mmdd),
                      );
                  }),
                ),
            )
            .child(
              h_flex()
                .pt(4)
                .gap(12)
                .items_center()
                .child(legendItem(L.inShort, cInput))
                .child(legendItem(L.outShort, cOutput))
                .child(legendItem(L.crShort, cRead))
                .child(legendItem(L.cwShort, cWrite)),
            ),
        )
        // Orca 2-column Por modelo & Por projeto with sessions/turns
        .child(
          h_flex()
            .gap(14)
            .items_start()
            .child(
              v_flex()
                .flex_1()
                .min_w(0)
                .p(12)
                .gap(6)
                .rounded(8)
                .bg(t.surface)
                .border_1()
                .border_color(t.border)
                .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(L.byModelTitle))
                .children(
                  listModels.slice(0, 6).map((m) =>
                    v_flex()
                      .py(5)
                      .gap(2)
                      .border_b(1)
                      .border_color(t.border)
                      .child(
                        h_flex()
                          .justify_between()
                          .items_center()
                          .text_size(12)
                          .child(div().font_medium().text_color(t.foreground).truncate().child(m.name))
                          .child(
                            div()
                              .text_color(t.foreground)
                              .flex_none()
                              .child(m.ioTokens ? fmtTokens(m.ioTokens) : fmtTokens(m.tokens)),
                          ),
                      )
                      .child(
                        h_flex()
                          .justify_between()
                          .text_size(10.5)
                          .text_color(t.dim)
                          .child(`${m.sessions ?? 0} ${L.sessions} · ${m.messages ?? 0} ${L.msgs}`)
                          .when(showUsd, (x) => x.child(isHarness ? "$0.00" : fmtUsd(m.cost)))
                          .when(!showUsd, (x) => x.child(fmtTokens(m.tokens))),
                      ),
                  ),
                ),
            )
            .when(listProjects.length > 0, (el) =>
              el.child(
                v_flex()
                  .flex_1()
                  .min_w(0)
                  .p(12)
                  .gap(6)
                  .rounded(8)
                  .bg(t.surface)
                  .border_1()
                  .border_color(t.border)
                  .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(L.byProjectTitle))
                  .children(
                    listProjects.slice(0, 6).map((p) =>
                      v_flex()
                        .py(5)
                        .gap(2)
                        .border_b(1)
                        .border_color(t.border)
                        .child(
                          h_flex()
                            .justify_between()
                            .items_center()
                            .text_size(12)
                            .child(div().font_medium().text_color(t.foreground).truncate().child(p.name))
                            .child(
                              div()
                                .text_color(t.foreground)
                                .flex_none()
                                .child(showUsd ? fmtUsd(p.cost) : fmtTokens(p.tokens)),
                            ),
                        )
                        .child(
                          h_flex()
                            .justify_between()
                            .text_size(10.5)
                            .text_color(t.dim)
                            .child(`${p.sessions ?? 0} ${L.sessions} · ${p.messages ?? 0} ${L.msgs}`)
                            .when(showUsd, (x) => x.child(fmtTokens(p.tokens))),
                        ),
                    ),
                  ),
              ),
            ),
        );
    };

    const overviewPane = () => {
      const hasUnpriced = (activeHarnessBucket?.tokens || 0) > 0;
      const subtitle = hasUnpriced ? `${L.localLogsSource} · ${L.unpricedNote}` : L.localLogsSource;
      return v_flex()
        .gap(12)
        .child(
          v_flex()
            .gap(8)
            .child(
              h_flex()
                .items_center()
                .justify_between()
                .child(div().text_size(16).font_semibold().text_color(t.foreground).child(L.usageOverview))
                .child(
                  h_flex()
                    .p(2)
                    .gap(2)
                    .rounded(7)
                    .bg(t.chrome)
                    .border_1()
                    .border_color(t.border)
                    .child(periodPill("today", L.periodToday))
                    .child(periodPill("d7", L.period7d))
                    .child(periodPill("d30", L.period30d)),
                ),
            )
            .child(
              h_flex()
                .items_center()
                .justify_between()
                .gap(8)
                .child(div().text_size(11).text_color(t.dim).truncate().child(subtitle))
                .child(
                  h_flex()
                    .p(2)
                    .gap(2)
                    .rounded(7)
                    .bg(t.chrome)
                    .border_1()
                    .border_color(t.border)
                    .flex_none()
                    .child(scopePill("all", L.navUsage))
                    .child(scopePill("claude", "Claude"))
                    .child(scopePill("harness", "Harness")),
                ),
            ),
        )
        .child(overviewScope === "all" ? overviewAllPane() : overviewProviderPane());
    };

    const agentsPane = () =>
      v_flex()
        .gap(12)
        .child(div().text_size(16).font_semibold().text_color(t.foreground).child(L.navAgents))
        .when(pv.claude, (el) =>
          el
            .child(sectionHeading(L.claudeProfilesTitle))
            .children(
              clProfiles
                .filter((cp) => !profileMeta(cp, prefs).hidden)
                .map((cp) => {
                  const pm = profileMeta(cp, prefs);
                  return h_flex()
                    .py(10)
                    .border_b(1)
                    .border_color(t.border)
                    .items_center()
                    .justify_between()
                    .child(
                      h_flex()
                        .gap(10)
                        .items_center()
                        .child(providerIcon(pm.icon, 16, t.foreground))
                        .child(
                          v_flex()
                            .gap(2)
                            .child(
                              div()
                                .text_size(13)
                                .font_medium()
                                .child(`${pm.label}${pm.label !== cp.profile ? ` (${cp.profile})` : ""}${cp.plan ? ` · ${cp.plan}` : ""}`),
                            )
                            .child(
                              div()
                                .text_size(11.5)
                                .text_color(t.dim)
                                .child(
                                  cp.kind === "harness"
                                    ? `${cp.defaultModel || L.harnessDesc} · ${L.today}: ${fmtTokens(cp.todayTokens || 0)} (${cp.todayMessages || 0} ${L.msgs}) · 7d: ${fmtTokens(cp.d7Tokens || 0)}`
                                    : cp.kind === "bedrock"
                                      ? cp.source || L.st_bedrock
                                      : cp.status === "ok"
                                        ? `5h ${displayPct(cp.session?.percent ?? 0, prefs.displayMode)}% (${formatResetShort(cp.session?.resetsAt, now, L)}) · ${L.weekShort} ${displayPct(cp.weekly?.percent ?? 0, prefs.displayMode)}%${cp.fable ? ` · Fable ${displayPct(cp.fable.percent, prefs.displayMode)}%` : ""}${cp.rateLimited && cp.stale ? ` · ${L.staleCacheTag}` : ""}`
                                        : translateStatus(cp.status, L),
                                ),
                            ),
                        ),
                    )
                    .child(
                      statusPill(
                        translateStatus(cp.status, L),
                        cp.status === "ok" || cp.status === "gateway" ? t.done || t.accent : t.dim,
                        t,
                      ),
                    );
                }),
            ),
        )
        .when(pv.antigravity, (el) =>
          el
            .child(
              sectionHeading(
                "Antigravity (agy CLI)",
                `${ag?.conversations ?? 0} ${L.conversationsLocal}`,
              ),
            )
            .children(
              (ag?.groups ?? []).map((g) =>
                v_flex()
                  .py(9)
                  .border_b(1)
                  .border_color(t.border)
                  .gap(3)
                  .child(
                    h_flex()
                      .justify_between()
                      .items_center()
                      .child(
                        h_flex()
                          .gap(8)
                          .items_center()
                          .child(image("icons/antigravity.svg").size(15).flex_none())
                          .child(div().text_size(13).font_medium().child(g.name)),
                      )
                      .child(
                        div()
                          .text_size(12)
                          .text_color(t.muted)
                          .child(
                            `5h ${displayPct(g.h5?.percent ?? 0, prefs.displayMode)}%${g.h5?.resetsAt ? ` (${formatResetLong(g.h5.resetsAt, now, L)})` : ""} · ${L.weekShort} ${displayPct(g.weekly?.percent ?? 0, prefs.displayMode)}%`,
                          ),
                      ),
                  )
                  .when(Boolean(g.description), (e) =>
                    e.child(div().pl(23).text_size(11).text_color(t.dim).child(g.description)),
                  ),
              ),
            ),
        )
        .when(pv.codex || pv.opencode, (el) =>
          el
            .child(sectionHeading("CLI Agents"))
            .when(pv.codex, (x) =>
              x.child(
                h_flex()
                  .py(10)
                  .border_b(1)
                  .border_color(t.border)
                  .items_center()
                  .justify_between()
                  .child(
                    h_flex()
                      .gap(10)
                      .items_center()
                      .child(providerIcon("icons/codex.svg", 15, t.foreground))
                      .child(
                        v_flex()
                          .gap(2)
                          .child(div().text_size(13).font_medium().child("OpenAI Codex"))
                          .child(
                            div()
                              .text_size(11.5)
                              .text_color(t.dim)
                              .child(
                                cxData
                                  ? `${cxData.sessionsCount} ${L.sessions} · ${fmtTokens(cxData.totalTokens)} tok${cxData.weekly ? ` · ${L.weekShort}: ${displayPct(cxData.weekly.percent, prefs.displayMode)}%` : ""}`
                                  : L.noData,
                              ),
                          ),
                      ),
                  )
                  .child(
                    statusPill(
                      translateStatus(cxData?.status, L),
                      cxData?.status === "ok" || cxData?.status === "cached_session" ? t.accent : t.dim,
                      t,
                    ),
                  ),
              ),
            )
            .when(pv.opencode, (x) =>
              x.child(
                h_flex()
                  .py(10)
                  .border_b(1)
                  .border_color(t.border)
                  .items_center()
                  .justify_between()
                  .child(
                    h_flex()
                      .gap(10)
                      .items_center()
                      .child(providerIcon("icons/opencode.svg", 15, t.foreground))
                      .child(
                        v_flex()
                          .gap(2)
                          .child(div().text_size(13).font_medium().child("OpenCode"))
                          .child(
                            div()
                              .text_size(11.5)
                              .text_color(t.dim)
                              .child(
                                oc?.status === "ok"
                                  ? `${oc.sessionsCount} ${L.sessions} · ${oc.allTimeMessages} ${L.msgs} · ${fmtTokens(oc.allTimeTokens)} tok`
                                  : translateStatus(oc?.status, L),
                              ),
                          ),
                      ),
                  )
                  .child(
                    statusPill(
                      translateStatus(oc?.status, L),
                      oc?.status === "ok" ? t.done || t.accent : t.dim,
                      t,
                    ),
                  ),
              ),
            ),
        )
        .when(
          others.some((o) => !prefs.hideUnauthProfiles || o.authenticated || pv[o.id]),
          (el) =>
            el
              .child(sectionHeading(L.otherAgentsTitle))
              .children(
                others
                  .filter((o) => !prefs.hideUnauthProfiles || o.authenticated || pv[o.id])
                  .map((o) =>
                    h_flex()
                      .py(8)
                      .border_b(1)
                      .border_color(t.border)
                      .items_center()
                      .justify_between()
                      .child(
                        h_flex()
                          .gap(10)
                          .items_center()
                          .child(providerIcon(o.icon, 14, t.foreground))
                          .child(div().text_size(12.5).font_medium().child(o.name)),
                      )
                      .child(
                        statusPill(
                          translateStatus(o.status, L),
                          o.authenticated ? t.done || t.accent : o.installed ? t.working : t.dim,
                          t,
                        ),
                      ),
                  ),
              ),
        );

    const projects = costs?.byProject7d ?? [];
    const maxProjCost = Math.max(1, ...projects.map((p) => p.cost || 0));
    const maxProjTok = Math.max(1, ...projects.map((p) => p.tokens || 0));
    const projectsPane = () =>
      v_flex()
        .gap(8)
        .child(div().text_size(16).font_semibold().text_color(t.foreground).child(L.navProjects))
        .child(sectionHeading(L.projectsTitle, "7d"))
        .when(projects.length === 0, (el) =>
          el.child(div().py(10).text_size(12.5).text_color(t.dim).child(L.noProjectData)),
        )
        .children(
          projects.map((p, idx) =>
            v_flex()
              .py(8)
              .gap(5)
              .border_b(1)
              .border_color(t.border)
              .child(
                h_flex()
                  .items_center()
                  .justify_between()
                  .child(div().text_size(13).font_medium().text_color(t.foreground).child(p.name))
                  .child(
                    h_flex()
                      .gap(10)
                      .items_center()
                      .child(div().text_size(11).text_color(t.dim).child(`${p.sessions ?? 0} ${L.sessions}`))
                      .when(showUsd && p.todayCost > 0, (e) =>
                        e.child(
                          div()
                            .text_size(11.5)
                            .text_color(t.muted)
                            .child(`${L.today.toLowerCase()} ${fmtUsd(p.todayCost)}`),
                        ),
                      )
                      .child(
                        div()
                          .text_size(13)
                          .font_semibold()
                          .text_color(t.foreground)
                          .child(showUsd ? fmtUsd(p.cost) : fmtTokens(p.tokens)),
                      ),
                  ),
              )
              .child(
                shareBar(
                  showUsd
                    ? Math.round((p.cost / maxProjCost) * 100)
                    : Math.round((p.tokens / maxProjTok) * 100),
                  560,
                  4,
                  idx === 0,
                ),
              ),
          ),
        );

    const shownPorts = prefs.portsFilter === "local" ? ports.filter((p) => p.local) : ports;
    const portsPane = () =>
      v_flex()
        .gap(8)
        .child(
          h_flex()
            .items_center()
            .justify_between()
            .child(div().text_size(16).font_semibold().text_color(t.foreground).child(L.navPorts))
            .child(
              h_flex()
                .gap(8)
                .items_center()
                .child(
                  h_flex()
                    .p(2)
                    .gap(2)
                    .rounded(7)
                    .bg(t.chrome)
                    .border_1()
                    .border_color(t.border)
                    .child(
                      div()
                        .id("pf-local")
                        .px(8)
                        .py(3)
                        .rounded(5)
                        .text_size(11.5)
                        .cursor_pointer()
                        .bg(prefs.portsFilter === "local" ? t.raised : "#00000000")
                        .text_color(prefs.portsFilter === "local" ? t.foreground : t.muted)
                        .on_click(() => patchPrefs({ portsFilter: "local" }))
                        .child(`${L.portsLocal} (${ports.filter((p) => p.local).length})`),
                    )
                    .child(
                      div()
                        .id("pf-all")
                        .px(8)
                        .py(3)
                        .rounded(5)
                        .text_size(11.5)
                        .cursor_pointer()
                        .bg(prefs.portsFilter === "all" ? t.raised : "#00000000")
                        .text_color(prefs.portsFilter === "all" ? t.foreground : t.muted)
                        .on_click(() => patchPrefs({ portsFilter: "all" }))
                        .child(`${L.portsAll} (${ports.length})`),
                    ),
                )
                .child(
                  div()
                    .id("pf-refresh")
                    .px(9)
                    .py(4)
                    .rounded(7)
                    .bg(t.raised)
                    .border_1()
                    .border_color(t.border)
                    .text_size(12)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => this.fetchSysOnly(cx))
                    .child(L.rescanLsof),
                ),
            ),
        )
        .child(
          v_flex()
            .children(
              shownPorts.map((pt) => {
                const armed = this.confirmKillPid === pt.pid;
                return h_flex()
                  .id(`pt-${pt.port}-${pt.pid}`)
                  .px(4)
                  .py(7)
                  .border_b(1)
                  .border_color(t.border)
                  .items_center()
                  .justify_between()
                  .hover((s) => s.bg(t.hover))
                  .child(
                    h_flex()
                      .gap(10)
                      .items_center()
                      .child(
                        div()
                          .w(58)
                          .font_semibold()
                          .text_size(12.5)
                          .text_color(t.accent)
                          .child(`:${pt.port}`),
                      )
                      .child(div().w(140).truncate().text_size(12.5).child(pt.process))
                      .child(div().text_size(11.5).text_color(t.dim).child(`PID ${pt.pid} · ${pt.host}`)),
                  )
                  .child(
                    h_flex()
                      .gap(6)
                      .items_center()
                      .child(
                        div()
                          .id(`cp-${pt.port}-${pt.pid}`)
                          .px(7)
                          .py(3)
                          .rounded(5)
                          .bg(t.raised)
                          .border_1()
                          .border_color(t.border)
                          .text_size(11)
                          .text_color(t.muted)
                          .cursor_pointer()
                          .hover((s) => s.text_color(t.foreground))
                          .on_click(() => this.copyText(`http://localhost:${pt.port}`, L))
                          .child(L.copyUrl),
                      )
                      .child(
                        div()
                          .id(`kl-${pt.port}-${pt.pid}`)
                          .px(7)
                          .py(3)
                          .rounded(5)
                          .bg(armed ? t.blocked : t.raised)
                          .border_1()
                          .border_color(armed ? t.blocked : t.border)
                          .text_size(11)
                          .text_color(armed ? "#ffffff" : t.muted)
                          .cursor_pointer()
                          .hover((s) => s.text_color(armed ? "#ffffff" : t.blocked))
                          .on_click((_e, cx) => {
                            if (armed) this.killPortPid(pt.pid, pt.port, L, cx);
                            else {
                              this.confirmKillPid = pt.pid;
                              cx.notify();
                            }
                          })
                          .child(armed ? L.confirm : L.kill),
                      ),
                  );
              }),
            ),
        );

    const systemPane = () =>
      v_flex()
        .gap(12)
        .child(
          h_flex()
            .items_center()
            .justify_between()
            .child(div().text_size(16).font_semibold().text_color(t.foreground).child(L.navSystem))
            .child(
              div()
                .id("sys-rescan")
                .px(9)
                .py(4)
                .rounded(7)
                .bg(t.raised)
                .border_1()
                .border_color(t.border)
                .text_size(12)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => this.fetchSysOnly(cx))
                .child(L.refresh),
            ),
        )
        .child(
          h_flex()
            .rounded(8)
            .bg(t.surface)
            .border_1()
            .border_color(t.border)
            .child(
              v_flex()
                .flex_1()
                .p(12)
                .gap(6)
                .border_r(1)
                .border_color(t.border)
                .child(div().text_size(11).text_color(t.dim).child(L.cpuMachine))
                .child(div().text_size(18).font_semibold().child(`${sys?.cpuPercent ?? 0}%`))
                .child(meterBar(sys?.cpuPercent ?? 0, 240, 5, t, "used")),
            )
            .child(
              v_flex()
                .flex_1()
                .p(12)
                .gap(6)
                .child(div().text_size(11).text_color(t.dim).child(L.ramMemory))
                .child(
                  div()
                    .text_size(18)
                    .font_semibold()
                    .child(`${sys?.memUsedGb ?? 0} / ${sys?.memTotalGb ?? 0} GB (${sys?.memPercent ?? 0}%)`),
                )
                .child(meterBar(sys?.memPercent ?? 0, 240, 5, t, "used")),
            ),
        )
        .child(sectionHeading(`${L.agentProcesses} (${sys?.agentProcCount ?? 0})`))
        .children(
          (sys?.agentProcs ?? []).map((pr) =>
            h_flex()
              .py(7)
              .border_b(1)
              .border_color(t.border)
              .items_center()
              .justify_between()
              .text_size(12)
              .child(
                h_flex()
                  .gap(8)
                  .items_center()
                  .child(div().w(84).font_medium().text_color(t.accent).child(pr.name))
                  .child(div().w(62).text_size(11).text_color(t.dim).child(`PID ${pr.pid}`))
                  .child(div().w(240).truncate().text_size(11.5).text_color(t.muted).child(pr.cmd)),
              )
              .child(
                h_flex()
                  .gap(10)
                  .child(div().text_size(11.5).text_color(t.muted).child(`${pr.cpu}% CPU`))
                  .child(div().w(58).text_right().font_medium().child(`${pr.memMb} MB`)),
              ),
          ),
        );

    const settingHeading = (title) => sectionHeading(title);

    const settingRow = (title, desc, control) =>
      h_flex()
        .w_full()
        .gap(16)
        .py(10)
        .items_center()
        .border_b(1)
        .border_color(t.border)
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .gap(2)
            .child(div().text_size(13).text_color(t.foreground).child(title))
            .when(Boolean(desc), (el) =>
              el.child(div().text_size(11.5).text_color(t.dim).child(desc)),
            ),
        )
        .child(div().flex_none().child(control));

    const choiceGroup = (prefix, options, current, onPick) =>
      h_flex()
        .p(2)
        .gap(2)
        .rounded(7)
        .bg(t.chrome)
        .border(1)
        .border_color(t.border)
        .children(
          options.map((opt) => {
            const active = current === opt.id;
            return div()
              .id(`${prefix}-${opt.id}`)
              .px(8)
              .py(3)
              .rounded(5)
              .text_size(11.5)
              .cursor_pointer()
              .bg(active ? t.raised : "#00000000")
              .text_color(active ? t.foreground : t.muted)
              .hover((s) => s.text_color(t.foreground))
              .on_click(() => onPick(opt.id))
              .child(opt.label);
          }),
        );

    const providerList = [
      { id: "claude", label: "Claude Code" },
      { id: "harness", label: "Claude Harness (LiteLLM)" },
      { id: "antigravity", label: "Antigravity (agy)" },
      { id: "codex", label: "OpenAI Codex" },
      { id: "opencode", label: "OpenCode" },
      { id: "gemini", label: "Gemini CLI" },
      { id: "kimi", label: "Kimi Code" },
      { id: "grok", label: "Grok CLI" },
      { id: "cursor", label: "Cursor" },
      { id: "ports", label: L.tabPorts },
      { id: "system", label: L.tabSystem },
    ];

    const settingsPane = () =>
      v_flex()
        .w_full()
        .gap(2)
        .child(div().pb(6).text_size(16).font_semibold().text_color(t.foreground).child(L.navSettings))
        .child(settingHeading(L.secGeneral))
        .child(
          settingRow(
            L.setLangTitle,
            L.setLangDesc,
            choiceGroup("lang", LANGUAGES, prefs.language, (id) => patchPrefs({ language: id })),
          ),
        )
        .child(
          settingRow(
            L.setPctTitle,
            L.setPctDesc,
            choiceGroup(
              "pct",
              [
                { id: "used", label: L.used },
                { id: "remaining", label: L.remaining },
              ],
              prefs.displayMode,
              (id) => patchPrefs({ displayMode: id }),
            ),
          ),
        )
        .child(
          settingRow(
            L.setPopoverTitle,
            L.setPopoverDesc,
            choiceGroup(
              "det",
              [
                { id: "detailed", label: L.detailed },
                { id: "compact", label: L.compact },
              ],
              prefs.detailMode,
              (id) => patchPrefs({ detailMode: id }),
            ),
          ),
        )
        .child(
          settingRow(
            L.setShowEstCostTitle,
            L.setShowEstCostDesc,
            herdrToggle(t, "tg-est-cost", prefs.showEstimatedCost !== false, () =>
              patchPrefs({ showEstimatedCost: !(prefs.showEstimatedCost !== false) }),
            ),
          ),
        )
        .child(
          settingRow(
            L.setShowPopCostTitle,
            L.setShowPopCostDesc,
            herdrToggle(t, "tg-pop-cost", Boolean(prefs.showCostInPopover), () =>
              patchPrefs({ showCostInPopover: !prefs.showCostInPopover }),
            ),
          ),
        )
        .child(settingHeading(L.secSidebar))
        .child(
          settingRow(
            L.setStartCollapsedTitle,
            L.setStartCollapsedDesc,
            herdrToggle(t, "tg-start-col", prefs.alwaysStartCollapsed !== false, () =>
              patchPrefs({ alwaysStartCollapsed: !(prefs.alwaysStartCollapsed !== false) }),
            ),
          ),
        )
        .child(
          settingRow(
            L.setShowCostTitle,
            L.setShowCostDesc,
            herdrToggle(t, "tg-cost", prefs.showCostInSidebar, () =>
              patchPrefs({ showCostInSidebar: !prefs.showCostInSidebar }),
            ),
          ),
        )
        .child(
          settingRow(
            L.setShowActionsTitle,
            L.setShowActionsDesc,
            herdrToggle(t, "tg-actions", prefs.showBarActions, () =>
              patchPrefs({ showBarActions: !prefs.showBarActions }),
            ),
          ),
        )
        .child(
          settingRow(
            L.setShowBarsTitle,
            L.setShowBarsDesc,
            herdrToggle(t, "tg-bars", prefs.showBarsInSidebar, () =>
              patchPrefs({ showBarsInSidebar: !prefs.showBarsInSidebar }),
            ),
          ),
        )
        .child(
          settingRow(
            L.setShowResetTitle,
            L.setShowResetDesc,
            herdrToggle(t, "tg-reset", prefs.showResetInSidebar, () =>
              patchPrefs({ showResetInSidebar: !prefs.showResetInSidebar }),
            ),
          ),
        )
        .child(
          settingRow(
            L.setShowExtraTitle,
            null,
            herdrToggle(t, "tg-bar-extra", prefs.showExtraProfilesInBar, () =>
              patchPrefs({ showExtraProfilesInBar: !prefs.showExtraProfilesInBar }),
            ),
          ),
        )
        .child(
          settingRow(
            L.setShowHarnessTitle,
            null,
            herdrToggle(t, "tg-bar-harness", prefs.showHarnessInBar, () =>
              patchPrefs({ showHarnessInBar: !prefs.showHarnessInBar }),
            ),
          ),
        )
        .child(
          settingRow(
            L.setShowCodexTitle,
            null,
            herdrToggle(t, "tg-bar-codex", prefs.showCodexInBar, () =>
              patchPrefs({ showCodexInBar: !prefs.showCodexInBar }),
            ),
          ),
        )
        .child(
          settingRow(
            L.setShowOpencodeTitle,
            null,
            herdrToggle(t, "tg-bar-oc", prefs.showOpencodeInBar, () =>
              patchPrefs({ showOpencodeInBar: !prefs.showOpencodeInBar }),
            ),
          ),
        )
        .child(
          settingRow(
            L.setShowCpuTitle,
            null,
            herdrToggle(t, "tg-bar-cpu", prefs.showCpuInBar, () =>
              patchPrefs({ showCpuInBar: !prefs.showCpuInBar }),
            ),
          ),
        )
        .child(
          settingRow(
            L.setShowPortsTitle,
            null,
            herdrToggle(t, "tg-bar-ports", prefs.showPortsInBar, () =>
              patchPrefs({ showPortsInBar: !prefs.showPortsInBar }),
            ),
          ),
        )
        .child(
          settingRow(
            L.setHideUnauthTitle,
            L.setHideUnauthDesc,
            herdrToggle(t, "tg-hide-unauth", prefs.hideUnauthProfiles, () =>
              patchPrefs({ hideUnauthProfiles: !prefs.hideUnauthProfiles }),
            ),
          ),
        )
        .child(settingHeading(L.secPolling))
        .child(
          settingRow(
            L.setRangeTitle,
            L.setRangeDesc,
            choiceGroup(
              "rng",
              [
                { id: "today", label: L.periodToday },
                { id: "d7", label: L.period7d },
                { id: "d30", label: L.period30d },
              ],
              prefs.defaultPeriod,
              (id) => patchPrefs({ defaultPeriod: id, period: id }),
            ),
          ),
        )
        .child(
          settingRow(
            L.setPollTitle,
            L.setPollDesc,
            choiceGroup(
              "poll",
              [
                { id: 5, label: "5m" },
                { id: 15, label: "15m" },
                { id: 30, label: "30m" },
                { id: 60, label: "60m" },
                { id: 0, label: L.pollManual },
              ],
              prefs.pollMinutes,
              (id) => patchPrefs({ pollMinutes: id }),
            ),
          ),
        )
        .child(settingHeading(L.secProviders))
        .children(
          providerList.map((item) =>
            settingRow(
              item.label,
              null,
              herdrToggle(t, `tg-pv-${item.id}`, Boolean(pv[item.id]), () =>
                patchPrefs({ providers: { [item.id]: !pv[item.id] } }),
              ),
            ),
          ),
        )
        .child(settingHeading(L.secAccounts))
        .children(
          (() => {
            const detectedAccounts = [
              ...clProfilesAll.map((cp) => ({
                ...cp,
                barToggle: null,
              })),
              ...(ag
                ? [
                    {
                      profile: "__antigravity__",
                      label: "Antigravity (Gemini)",
                      defaultIcon: "icons/antigravity.svg",
                      plan: ag.model || "Gemini · Claude/GPT",
                      source: `~/.gemini/antigravity-cli · ${ag.conversations ?? 0} ${L.conversationsLocal}`,
                      status: ag.status || "unavailable",
                      barToggle: {
                        on: Boolean(pv.antigravity),
                        toggle: () => patchPrefs({ providers: { antigravity: !pv.antigravity } }),
                      },
                    },
                  ]
                : []),
              ...(cxData
                ? [
                    {
                      profile: "__codex__",
                      label: "OpenAI Codex",
                      defaultIcon: "icons/codex.svg",
                      plan: cxData.plan || "Codex CLI",
                      source: `~/.codex · ${cxData.sessionsCount ?? 0} ${L.sessions}`,
                      status: cxData.status || "unavailable",
                      barToggle: {
                        on: Boolean(prefs.showCodexInBar),
                        toggle: () => patchPrefs({ showCodexInBar: !prefs.showCodexInBar }),
                      },
                    },
                  ]
                : []),
              ...(oc
                ? [
                    {
                      profile: "__opencode__",
                      label: "OpenCode",
                      defaultIcon: "icons/opencode.svg",
                      plan: null,
                      source: `~/.local/share/opencode · ${oc.sessionsCount ?? 0} ${L.sessions}`,
                      status: oc.status || "unavailable",
                      barToggle: {
                        on: Boolean(prefs.showOpencodeInBar),
                        toggle: () => patchPrefs({ showOpencodeInBar: !prefs.showOpencodeInBar }),
                      },
                    },
                  ]
                : []),
            ];

            return detectedAccounts.map((cp, idx) => {
              const pm = profileMeta(cp, prefs);
              const iconOpen = this.editingIconProfile === cp.profile;
              const aliasOpen = this.editingAliasProfile === cp.profile;
              const inBarOn = cp.barToggle ? cp.barToggle.on : pm.showInBar;
              const isHealthy =
                cp.status === "ok" ||
                cp.status === "gateway" ||
                cp.status === "ready" ||
                cp.status === "cached_session";
              const subBadge = cp.plan ? ` (${cp.plan})` : "";
              const originTag =
                cp.profile && !cp.profile.startsWith("__") && pm.label !== cp.profile
                  ? ` · ${cp.profile}`
                  : "";
              return v_flex()
                .py(8)
                .gap(7)
                .border_b(1)
                .border_color(t.border)
                .child(
                  h_flex()
                    .gap(10)
                    .items_center()
                    .justify_between()
                    .child(
                      h_flex()
                        .gap(10)
                        .flex_1()
                        .min_w(0)
                        .items_center()
                        .child(
                          div()
                            .id(`acct-ico-${idx}`)
                            .w(30)
                            .h(30)
                            .flex()
                            .items_center()
                            .justify_center()
                            .flex_none()
                            .rounded(7)
                            .border_1()
                            .border_color(iconOpen ? t.accent : t.border)
                            .bg(t.raised)
                            .cursor_pointer()
                            .hover((s) => s.bg(t.hover))
                            .tooltip(L.pickIcon)
                            .on_click((_e, cx) => {
                              this.editingIconProfile = iconOpen ? null : cp.profile;
                              this.editingAliasProfile = null;
                              cx.notify();
                            })
                            .child(providerIcon(pm.icon, 15, t.foreground)),
                        )
                        .child(
                          v_flex()
                            .flex_1()
                            .min_w(0)
                            .gap(2)
                            .child(
                              div()
                                .text_size(12.5)
                                .font_medium()
                                .truncate()
                                .child(`${pm.label}${originTag}${subBadge}`),
                            )
                            .child(
                              div()
                                .text_size(11)
                                .text_color(t.dim)
                                .truncate()
                                .child(cp.source || cp.configDir || ""),
                            ),
                        ),
                    )
                    .child(
                      h_flex()
                        .gap(5)
                        .flex_none()
                        .items_center()
                        .child(
                          div()
                            .id(`acct-ren-${idx}`)
                            .w(68)
                            .py(3)
                            .rounded(5)
                            .border_1()
                            .border_color(aliasOpen ? t.accent : t.border)
                            .bg(t.raised)
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_size(11)
                            .text_color(t.muted)
                            .cursor_pointer()
                            .hover((s) => s.text_color(t.foreground).bg(t.hover))
                            .on_click((_e, cx) => {
                              if (aliasOpen) {
                                this.editingAliasProfile = null;
                                if (this.handle) this.handle.focus();
                              } else {
                                this.editingAliasProfile = cp.profile;
                                this.editingIconProfile = null;
                                this.aliasDraft = pm.label;
                                if (this.aliasInput) {
                                  this.aliasInput.set_value(pm.label);
                                  this.aliasInput.focus();
                                }
                              }
                              cx.notify();
                            })
                            .child(L.renameProfile),
                        )
                        .child(
                          div()
                            .id(`acct-bar-${idx}`)
                            .w(58)
                            .py(3)
                            .rounded(5)
                            .border_1()
                            .border_color(inBarOn ? t.accent : t.border)
                            .bg(inBarOn ? t.raised : t.chrome)
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_size(11)
                            .text_color(inBarOn ? t.foreground : t.dim)
                            .cursor_pointer()
                            .on_click((_e, cx) => {
                              if (cp.barToggle) cp.barToggle.toggle();
                              else this.updateProfileCustom(cp.profile, { showInBar: !pm.showInBar });
                              cx.notify();
                            })
                            .child(L.showInBarLabel),
                        )
                        .child(
                          div()
                            .id(`acct-act-${idx}`)
                            .w(46)
                            .py(3)
                            .rounded(5)
                            .border_1()
                            .border_color(!pm.hidden ? (t.done || t.accent) : t.border)
                            .bg(!pm.hidden ? t.raised : t.chrome)
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_size(11)
                            .text_color(!pm.hidden ? t.foreground : t.dim)
                            .cursor_pointer()
                            .on_click((_e, cx) => {
                              this.updateProfileCustom(cp.profile, { hidden: !pm.hidden });
                              cx.notify();
                            })
                            .child(L.activeLabel),
                        )
                        .child(
                          statusPill(
                            translateStatus(cp.status, L),
                            isHealthy ? t.done || t.accent : t.dim,
                            t,
                            96,
                          ),
                        ),
                    ),
                )
                .when(aliasOpen && Boolean(this.aliasInput), (el) =>
                  el.child(
                    h_flex()
                      .pl(40)
                      .gap(6)
                      .items_center()
                      .child(
                        Input.new(this.aliasInput)
                          .flex_1()
                          .min_w(0)
                          .h(28)
                          .px(8)
                          .rounded(6)
                          .border_1()
                          .border_color(t.accent)
                          .bg(t.background)
                          .text_size(12.5)
                          .text_color(t.foreground),
                      )
                      .child(
                        div()
                          .id(`acct-save-${idx}`)
                          .px(9)
                          .py(4)
                          .rounded(6)
                          .bg(t.raised)
                          .border_1()
                          .border_color(t.border)
                          .text_size(11.5)
                          .cursor_pointer()
                          .hover((s) => s.bg(t.hover))
                          .on_click((_e, cx) => this.saveProfileAlias(cp.profile, this.aliasInput.value(), cx))
                          .child(L.saveLabel),
                      )
                      .child(
                        div()
                          .id(`acct-rst-${idx}`)
                          .px(8)
                          .py(4)
                          .rounded(6)
                          .text_size(11.5)
                          .text_color(t.muted)
                          .cursor_pointer()
                          .hover((s) => s.bg(t.hover).text_color(t.foreground))
                          .on_click((_e, cx) => this.saveProfileAlias(cp.profile, "", cx))
                          .child(L.resetLabel),
                      )
                      .child(
                        div()
                          .id(`acct-can-${idx}`)
                          .px(8)
                          .py(4)
                          .rounded(6)
                          .text_size(11.5)
                          .text_color(t.dim)
                          .cursor_pointer()
                          .hover((s) => s.bg(t.hover).text_color(t.foreground))
                          .on_click((_e, cx) => {
                            this.editingAliasProfile = null;
                            if (this.handle) this.handle.focus();
                            cx.notify();
                          })
                          .child(L.cancelLabel),
                      ),
                  ),
                )
                .when(iconOpen, (el) =>
                  el.child(
                    h_flex()
                      .pl(40)
                      .gap(6)
                      .flex_wrap()
                      .children(
                        PROFILE_ICONS.map((ic, icIdx) => {
                          const selected = pm.icon === ic.id;
                          return h_flex()
                            .id(`acct-pick-${idx}-${icIdx}`)
                            .gap(5)
                            .px(7)
                            .py(4)
                            .rounded(6)
                            .border_1()
                            .border_color(selected ? t.accent : t.border)
                            .bg(selected ? t.raised : t.chrome)
                            .items_center()
                            .cursor_pointer()
                            .hover((s) => s.bg(t.hover))
                            .on_click((_e, cx) => {
                              this.updateProfileCustom(cp.profile, { icon: ic.id });
                              this.editingIconProfile = null;
                              cx.notify();
                            })
                            .child(providerIcon(ic.id, 13, t.foreground))
                            .child(div().text_size(10.5).text_color(t.muted).child(ic.label));
                        }),
                      ),
                  ),
                );
            });
          })(),
        )
        .child(div().pt(8).text_size(11).text_color(t.dim).child(L.accountsHint));

    const updatedLabel = st.updatedAt
      ? `${L.updatedAgo} ${new Date(st.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : "";

    const nav = v_flex()
      .flex_none()
      .w(196)
      .h_full()
      .p(10)
      .gap(2)
      .bg(t.chrome)
      .border_r(1)
      .border_color(t.border)
      .child(
        div()
          .px(10)
          .pt(6)
          .pb(10)
          .text_size(15)
          .font_semibold()
          .text_color(t.foreground)
          .child(L.inspectorTitle),
      )
      .child(navBtn("overview", L.navUsage, "mods/usage-meter/chart.svg"))
      .child(navBtn("agents", L.navAgents, "frame/settings/server.svg"))
      .child(navBtn("projects", L.navProjects, "frame/settings/palette.svg"))
      .when(pv.ports, (el) =>
        el.child(navBtn("ports", L.navPorts, "mods/usage-meter/ports.svg", ports.length)),
      )
      .when(pv.system, (el) =>
        el.child(navBtn("system", L.navSystem, "mods/usage-meter/cpu.svg", `${sys?.cpuPercent ?? 0}%`)),
      )
      .child(div().my(4).border_t(1).border_color(t.border))
      .child(navBtn("settings", L.navSettings, "mods/usage-meter/sliders.svg"))
      .child(div().flex_1())
      .when(Boolean(updatedLabel), (el) =>
        el.child(div().px(10).pb(4).text_size(10.5).text_color(t.dim).child(updatedLabel)),
      )
      .child(
        v_flex()
          .gap(6)
          .child(
            railBtn(
              "dt-refresh",
              st.loading ? L.refreshing : L.refresh,
              (_e, cx) => this.fetchUsage(cx, true),
              st.loading,
            ),
          )
          .child(
            div()
              .id("dt-close")
              .w_full()
              .py(5)
              .rounded(7)
              .flex()
              .items_center()
              .justify_center()
              .text_size(12)
              .text_color(t.muted)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => overlayId && closeOverlay(overlayId))
              .child(L.close),
          ),
      );

    return h_flex()
      .id("usage-details")
      .when(Boolean(this.handle), (el) => el.track_focus(this.handle))
      .w_full()
      .h(616)
      .min_h(0)
      .items_start()
      .bg(t.popover)
      .text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          if (this.editingAliasProfile || this.editingIconProfile) {
            this.editingAliasProfile = null;
            this.editingIconProfile = null;
            if (this.handle) this.handle.focus();
            cx.stop_propagation();
            cx.notify();
            return;
          }
          if (overlayId) {
            closeOverlay(overlayId);
            cx.stop_propagation();
          }
        }
      })
      .child(nav)
      .child(
        div()
          .relative()
          .flex_1()
          .min_w(0)
          .h_full()
          .child(
            div()
              .id("dt-body")
              .size_full()
              .overflow_y_scroll()
              .child(
                div()
                  .px(26)
                  .py(20)
                  .child(
                    activeTab === "agents"
                      ? agentsPane()
                      : activeTab === "projects"
                        ? projectsPane()
                        : activeTab === "ports"
                          ? portsPane()
                          : activeTab === "system"
                            ? systemPane()
                            : activeTab === "settings"
                              ? settingsPane()
                              : overviewPane(),
                  ),
              ),
          )
          .child(Scrollbar.vertical("dt-body").mode("always").absolute().inset_0()),
      );
  }

  render() {
    const t = theme();
    const st = this.getState();
    const prefs = readPrefs();
    const p = props();
    const mode = p?.mode || (p?.overlay ? "details" : "status");

    if (mode === "status") return this.renderStatusBar(t, st, prefs);
    if (mode === "popover") return this.renderPopover(t, st, prefs);
    if (mode === "details") return this.renderDetails(t, st, prefs);
    return this.renderSidebar(t, st, prefs);
  }
}
