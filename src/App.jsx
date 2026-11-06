import React, { useEffect, useMemo, useRef, useState } from 'react';
import StatusLight from './components/StatusLight';
import DetailPanel from './components/DetailPanel';
import SettingsPanel from './components/SettingsPanel';
import { setUiLanguage, t as uiT, GEAR_MENU } from './statusMeta';

/**
 * Plays a short alert tone via the Web Audio API (no audio files needed).
 * @param {'stuck' | 'assist' | 'discover'} kind assist = urgent high triple beep,
 *   discover = pleasant two-tone chime for a newly auto-discovered AI.
 * @param {'low' | 'medium' | 'high'} volume 音量档位（v1.4.0，默认 high；
 *   主进程 settings-ops.js 的 SOUND_VOLUMES 有同名约束，改这里要同步）
 */
const VOLUME_GAIN = { low: 0.25, medium: 0.55, high: 0.9 };
let audioCtx = null;
function playAlertTone(kind, volume = 'high') {
  try {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const peak = VOLUME_GAIN[volume] || VOLUME_GAIN.high;
    const beeps =
      kind === 'assist' ? [988, 988, 988] : kind === 'discover' ? [659, 880] : [523, 523];
    const gap = kind === 'assist' ? 0.22 : kind === 'discover' ? 0.18 : 0.3;
    beeps.forEach((freq, i) => {
      const t0 = audioCtx.currentTime + i * gap;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.18);
    });
  } catch {
    /* audio unavailable - visual blink is still there */
  }
}

/**
 * Root overlay component: a narrow always-on-top strip of status lights,
 * plus expandable detail / settings panels below the strip.
 */
export default function App() {
  const [agents, setAgents] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState({
    soundOn: true,
    soundVolume: 'high',
    repeatAlert: true,
    showStatusText: true, // v1.6.3 灯下状态文字（缺省开）
  });
  // v1.5.0 界面语言：状态存在这里只为触发重渲染（文案本身由 statusMeta
  // 模块级 currentLang 提供，setUiLanguage 先行再 setLanguage 触发重绘）。
  const [language, setLanguage] = useState('zh-CN');
  // v1.6.0 功能二：齿轮单击改下拉菜单（不再直接开内嵌面板）
  const [gearOpen, setGearOpen] = useState(false);
  // v1.6.0 功能五：绿色版「有新版本」小横幅 {version, url}
  const [updateInfo, setUpdateInfo] = useState(null);
  const rootRef = useRef(null);

  // Subscribe to state pushes from the main process.
  useEffect(() => {
    let cancelled = false;
    window.statusLight.getState().then((state) => {
      if (!cancelled) setAgents(state);
    });
    const unsubscribe = window.statusLight.onState((state) => setAgents(state));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Load persisted user settings (sound toggle etc.).
  useEffect(() => {
    let cancelled = false;
    window.statusLight.getSettings().then((s) => {
      if (!cancelled && s) {
        setSettings(s);
        // v1.5.0：主进程附带已解析语言（auto 已按系统 locale 折算）
        if (s.resolvedLanguage) {
          setUiLanguage(s.resolvedLanguage);
          setLanguage(s.resolvedLanguage);
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // v1.5.0：设置窗口保存了新语言 → 主进程广播，灯条即时切换
  useEffect(() => {
    if (!window.statusLight.onLanguageChange) return undefined;
    const unsubscribe = window.statusLight.onLanguageChange((lang) => {
      setUiLanguage(lang);
      setLanguage(lang);
    });
    return unsubscribe;
  }, []);

  // Main process tells us a drag started while a panel was open: drop the
  // panel state so React stops feeding the tall ResizeObserver height back
  // through IPC (otherwise the strip would stay stretched after dragging).
  useEffect(() => {
    const unsubscribe = window.statusLight.onCollapsePanels(() => {
      setSelectedId(null);
      setSettingsOpen(false);
      setGearOpen(false);
    });
    return unsubscribe;
  }, []);

  // v1.6.0 功能五：主进程派「有新版本」横幅（仅绿色版会收到）
  useEffect(() => {
    if (!window.statusLight.onUpdateAvailable) return undefined;
    const unsubscribe = window.statusLight.onUpdateAvailable((info) => {
      if (info && typeof info.version === 'string') setUpdateInfo(info);
    });
    return unsubscribe;
  }, []);

  // Native right-click menu: the menu itself is built and popped by the main
  // process (it owns the only clean exit path). We only have to suppress
  // Chromium's own menu — otherwise the two race and ours never shows up.
  const handleContextMenu = (event) => {
    event.preventDefault();
    window.statusLight.showContextMenu();
  };

  // The native menu's "设置" entry asks us to open the settings panel.
  useEffect(() => {
    const unsubscribe = window.statusLight.onMenuOpenSettings(() => {
      setSelectedId(null);
      setSettingsOpen(true);
    });
    return unsubscribe;
  }, []);

  // Debug-only: let automated tests open / close a panel without a real
  // mouse click (sandbox-friendly). Production users still click lights.
  useEffect(() => {
    const unsubExpand = window.statusLight.onDebugExpandPanel(({ id }) => {
      setSettingsOpen(false);
      setSelectedId(id);
    });
    const unsubCollapse = window.statusLight.onDebugCollapsePanel(() => {
      setSelectedId(null);
      setSettingsOpen(false);
    });
    return () => {
      unsubExpand();
      unsubCollapse();
    };
  }, []);

  // Keep the window height in sync with the rendered content height.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(() => {
      const height = Math.ceil(el.getBoundingClientRect().height);
      window.statusLight.setHeight(height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // When a settings or detail panel is open, the narrow agent strip (224px
  // for 3 lights) cramps the panel text. Widen the window to a comfortable
  // 380px while a panel is shown; revert to the default agent-count width
  // (handled by main when setWidth(0) is called) once both panels are closed.
  const PANEL_WIDTH = 380;
  useEffect(() => {
    const panelOpen = settingsOpen || !!selectedId;
    window.statusLight.setWidth(panelOpen ? PANEL_WIDTH : 0);
  }, [settingsOpen, selectedId]);

  const selectedAgent = useMemo(
    () => agents.find((a) => a.id === selectedId) || null,
    [agents, selectedId]
  );

  // IPC-driven window dragging. We deliberately avoid -webkit-app-region:
  // drag because its OS modal move loop can freeze the main process.
  //
  // Pointer events + setPointerCapture: with plain mousemove listeners the
  // events stop arriving as soon as the cursor leaves the 56px-tall window
  // (e.g. fast vertical drags). Pointer capture keeps the events flowing to
  // the drag source even when the cursor is outside the window bounds.
  //
  // Click vs drag: the same pointerdown can become a drag (move the window)
  // or a click (toggle the detail panel). We decide on pointerup based on
  // whether the cursor moved more than DRAG_THRESHOLD_PX.
  const DRAG_THRESHOLD_PX = 4;
  const dragState = useRef({
    active: false,
    pointerId: null,
    pressedId: null,
    startX: 0,
    startY: 0,
    startScreenX: 0,
    startScreenY: 0,
    dragStarted: false,
    moved: false,
  });
  const dragRaf = useRef(0);

  const handleDragPointerDown = (event) => {
    if (event.button !== 0) return;
    // v1.6.0：点菜单外任意处关闭齿轮菜单（菜单/齿轮自身除外）。
    if (
      gearOpen &&
      !event.target.closest('.asl-gear-menu') &&
      !event.target.closest('.asl-gear-btn')
    ) {
      setGearOpen(false);
    }
    // The settings/panels opt out of drag.
    if (event.target.closest('.asl-no-drag')) return;
    // Only respond to pointerdowns on (or inside) a status-light button.
    const lightEl = event.target.closest('button[data-agent-id]');
    const lightId = lightEl ? lightEl.getAttribute('data-agent-id') : null;
    dragState.current = {
      active: true,
      pointerId: event.pointerId,
      pressedId: lightId,
      startX: event.clientX,
      startY: event.clientY,
      // Screen coords at press time: only sent to the main process once the
      // gesture is confirmed to be a real drag (see handleDragPointerMove).
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      dragStarted: false,
      moved: false,
    };
    // Capture on the root so we keep receiving moves even if the cursor
    // leaves the window (vertical drags into the screen below).
    event.currentTarget.setPointerCapture(event.pointerId);
    // NOTE: we deliberately do NOT send dragStart here. The main process
    // pins the window size while a dragContext exists; a plain click (press
    // + release without movement) never sends dragEnd, which would leave
    // dragContext stuck forever and block every later panel height update
    // (panels rendered but clipped outside the 56px window). dragStart is
    // sent only after the movement threshold is exceeded.
  };

  const handleDragPointerMove = (event) => {
    if (!dragState.current.active || event.pointerId !== dragState.current.pointerId) return;
    if (
      !dragState.current.moved &&
      (Math.abs(event.clientX - dragState.current.startX) > DRAG_THRESHOLD_PX ||
        Math.abs(event.clientY - dragState.current.startY) > DRAG_THRESHOLD_PX)
    ) {
      dragState.current.moved = true;
    }
    if (!dragState.current.moved) return;
    // The gesture is now confirmed to be a real drag (not a click): only now
    // tell the main process, so its dragContext (size-pinning guard) is never
    // set by a click that would never be followed by a dragEnd.
    if (!dragState.current.dragStarted) {
      dragState.current.dragStarted = true;
      window.statusLight.dragStart({
        cursorX: dragState.current.startScreenX,
        cursorY: dragState.current.startScreenY,
      });
    }
    if (dragRaf.current) return;
    const { screenX, screenY } = event;
    dragRaf.current = requestAnimationFrame(() => {
      dragRaf.current = 0;
      window.statusLight.dragMove({ cursorX: screenX, cursorY: screenY });
    });
  };

  const handleDragPointerEnd = (event) => {
    if (!dragState.current.active || event.pointerId !== dragState.current.pointerId) return;
    const { moved, pressedId, dragStarted } = dragState.current;
    dragState.current = { active: false, pointerId: null, pressedId: null, startX: 0, startY: 0, startScreenX: 0, startScreenY: 0, dragStarted: false, moved: false };
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (dragRaf.current) {
      cancelAnimationFrame(dragRaf.current);
      dragRaf.current = 0;
    }
    if (moved && dragStarted) {
      window.statusLight.dragEnd();
    } else if (pressedId) {
      // Treat as a click on the light that received the press.
      window.statusLight.hideTooltip();
      setSettingsOpen(false);
      setSelectedId((current) => (current === pressedId ? null : pressedId));
    }
  };

  const handleLightClick = (id) => {
    setSettingsOpen(false);
    setSelectedId((current) => (current === id ? null : id));
  };

  // handleLightClick is also invoked from the unified pointer handler above
  // when a light button receives a press that did not move enough to be a
  // drag. Kept here for any future explicit callers.
  void handleLightClick;

  const handleRemove = (id) => {
    if (selectedId === id) setSelectedId(null);
    window.statusLight.removeAgent(id);
  };

  // Human acknowledges a purple assist light -> back to idle.
  const handleAck = (id) => {
    window.statusLight.ackAgent(id);
  };

  const toggleSound = (soundOn) => {
    // 合并更新：soundVolume / repeatAlert 等其他键不能被覆盖丢回默认
    setSettings((prev) => ({ ...prev, soundOn }));
    window.statusLight.setSettings({ soundOn });
  };

  // -------------------------------------------------------------------------
  // Audible alert: beep when an agent *enters* stuck (red) or assist (purple).
  // assist gets a more urgent, higher-pitched triple beep than stuck.
  // v1.4.0: volume follows the 低/中/高 setting; while any agent stays in
  // assist/stuck, the alert repeats every 30s until ack / status clears
  // (repeatAlert toggle, default on) — one missed beep no longer means a
  // missed phone-call-level emergency.
  // -------------------------------------------------------------------------
  const prevStatusRef = useRef({});
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  useEffect(() => {
    const prev = prevStatusRef.current;
    const next = {};
    let sound = null;
    for (const agent of agents) {
      next[agent.id] = agent.status;
      if (agent.status === 'assist' && prev[agent.id] !== 'assist') sound = 'assist';
      else if (!sound && agent.status === 'stuck' && prev[agent.id] !== 'stuck') sound = 'stuck';
    }
    prevStatusRef.current = next;
    if (sound && settingsRef.current.soundOn) {
      playAlertTone(sound, settingsRef.current.soundVolume);
    }
  }, [agents]);

  // Repeat alert: every 30s, if anything is still assist/stuck, beep again.
  const REPEAT_ALERT_MS = 30_000;
  useEffect(() => {
    const timer = setInterval(() => {
      const s = settingsRef.current;
      if (!s.soundOn || s.repeatAlert === false) return;
      const list = agentsRef.current || [];
      const hasAssist = list.some((a) => a.status === 'assist');
      const hasStuck = list.some((a) => a.status === 'stuck');
      if (hasAssist) playAlertTone('assist', s.soundVolume);
      else if (hasStuck) playAlertTone('stuck', s.soundVolume);
    }, REPEAT_ALERT_MS);
    return () => clearInterval(timer);
  }, []);

  // Auto-discovery chime: main process found a new AI app and put it on the
  // strip. One pleasant chime per discovery batch (never repeats).
  useEffect(() => {
    if (!window.statusLight.onAgentDiscovered) return undefined;
    const unsubscribe = window.statusLight.onAgentDiscovered(() => {
      const s = settingsRef.current;
      if (s.soundOn) playAlertTone('discover', s.soundVolume);
    });
    return unsubscribe;
  }, []);

  return (
    <div
      ref={rootRef}
      className="asl-drag w-full cursor-move"
      data-lang={language}
      onPointerDown={handleDragPointerDown}
      onPointerMove={handleDragPointerMove}
      onPointerUp={handleDragPointerEnd}
      onPointerCancel={handleDragPointerEnd}
      onContextMenu={handleContextMenu}
    >
      {/* Light strip — v1.6.3 行高 56→72px（h-14→h-[72px]）：灯下新增一行
          状态词，主进程 ROW_HEIGHT 同步 56→72，两侧必须一致（拖动收起、
          启动初始高都以 ROW_HEIGHT 为准）。 */}
      <div className="flex h-[72px] items-stretch bg-[#111827]">
        <div className="flex items-center px-1.5">
          {agents.map((agent) => (
            <StatusLight
              key={agent.id}
              agent={agent}
              selected={agent.id === selectedId}
              showStatusText={settings.showStatusText !== false}
            />
          ))}
          {agents.length === 0 ? (
            <span className="px-2 text-[11px] text-gray-500">{uiT('strip.empty')}</span>
          ) : null}
        </div>
        <button
          type="button"
          // Stop the outer strip's drag handler from ever seeing this press,
          // even if a future pointer-event quirks made the .asl-no-drag check
          // fail. Without this, in some Chrome/Electron + frameless +
          // alwaysOnTop combos the click was being eaten before it reached
          // the gear's onClick handler.
          onPointerDown={(e) => e.stopPropagation()}
          // v1.6.0 功能二：单击改弹灯条内下拉菜单（不再直接开内嵌面板）
          onClick={() => {
            setSelectedId(null);
            setSettingsOpen(false);
            setGearOpen((open) => !open);
          }}
          className={`asl-no-drag asl-gear-btn ml-auto flex w-8 items-center justify-center text-sm text-gray-400 transition-colors hover:bg-white/5 hover:text-gray-100 ${
            gearOpen ? 'bg-white/10 text-gray-100' : ''
          }`}
          aria-label={uiT('strip.gearAria')}
          title={uiT('strip.gearTitle')}
        >
          ⚙
        </button>
      </div>

      {/* v1.6.0 齿轮下拉菜单：灯条内浮层，宽度 << 灯条宽，不调 setWidth
          —— 不裁灯契约（panelWindowWidth max 语义）天然满足 */}
      {gearOpen ? (
        <div className="asl-no-drag asl-gear-menu flex flex-col border-t border-white/10 bg-[#1f2937] py-1">
          {GEAR_MENU.gearMenuLabels(uiT).map((item) => (
            <button
              key={item.id}
              type="button"
              data-gear-action={item.id}
              className="asl-no-drag px-3 py-1.5 text-left text-[12px] text-gray-200 transition-colors hover:bg-white/10"
              onClick={() => {
                setGearOpen(false);
                window.statusLight.gearAction(item.id);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}

      {/* v1.6.0 功能五：绿色版「有新版本」小横幅（主进程派发；点击开 Releases） */}
      {updateInfo ? (
        <button
          type="button"
          className="asl-no-drag w-full border-t border-amber-500/30 bg-amber-500/10 px-2 py-1 text-left text-[11px] text-amber-300 transition-colors hover:bg-amber-500/20"
          onClick={() => {
            window.statusLight.openExternal(updateInfo.url);
            setUpdateInfo(null);
          }}
        >
          {uiT('update.banner', { version: updateInfo.version })}
        </button>
      ) : null}

      {/* Expandable panels */}
      {selectedAgent ? (
        <DetailPanel
          agent={selectedAgent}
          onClose={() => setSelectedId(null)}
          onRemove={handleRemove}
          onAck={handleAck}
        />
      ) : null}
      {settingsOpen ? (
        <SettingsPanel
          agents={agents}
          settings={settings}
          onToggleSound={toggleSound}
          onAdd={(agent) => window.statusLight.addAgent(agent)}
          onRemove={handleRemove}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </div>
  );
}
