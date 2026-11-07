'use strict';

/**
 * Preload script: exposes a minimal, safe API to the renderer via contextBridge.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('statusLight', {
  /** Returns the current serialized agent list. */
  getState: () => ipcRenderer.invoke('state:get'),

  /**
   * Subscribes to state broadcasts from the main process.
   * @param {(agents: Array<object>) => void} callback
   * @returns {() => void} unsubscribe function
   */
  onState: (callback) => {
    const listener = (_event, agents) => callback(agents);
    ipcRenderer.on('state:update', listener);
    return () => ipcRenderer.removeListener('state:update', listener);
  },

  /** Requests the overlay window be resized to the given content height. */
  setHeight: (height) => ipcRenderer.send('window:setHeight', height),

  /**
   * Requests a specific window width. Pass 0 to revert to the default
   * (computeWidth = agent count based). Used by the renderer to widen the
   * window when the settings or detail panel is open.
   */
  setWidth: (width) => ipcRenderer.send('window:setWidth', width),

  /** Adds (or renames) an agent. Optional payload.process sets its watcher. Returns {ok, error?}. */
  addAgent: (agent) => ipcRenderer.invoke('agents:add', agent),

  /** Returns the process watchers array [{agent, process, task}]. */
  getWatchers: () => ipcRenderer.invoke('watchers:get'),

  /** Sets (or removes, when process is '') an agent's process watcher. Returns {ok, watchers}. */
  setWatcher: (agent, process) => ipcRenderer.invoke('watchers:set', { agent, process }),

  /** Removes an agent by id. Returns {ok}. */
  removeAgent: (id) => ipcRenderer.invoke('agents:remove', id),

  /**
   * Acknowledges an "assist" alert: resets the agent to idle and stops the
   * purple blinking light. Returns {ok}.
   */
  ackAgent: (id) => ipcRenderer.invoke('agents:ack', id),

  /** Returns persisted user settings, e.g. {soundOn: boolean}. */
  getSettings: () => ipcRenderer.invoke('settings:get'),

  /** Persists user settings (partial update for known keys). Returns {ok, settings}. */
  setSettings: (settings) => ipcRenderer.invoke('settings:set', settings),

  /**
   * Shows the hover tooltip window for an agent.
   * @param {{agent: object, anchorX: number, anchorTop: number, anchorBottom: number}} payload
   *   anchor* are screen coordinates of the hovered light.
   */
  showTooltip: (payload) => ipcRenderer.send('tooltip:show', payload),

  /** Hides the hover tooltip window. */
  hideTooltip: () => ipcRenderer.send('tooltip:hide'),

  /** Begins an IPC-driven window drag. pos: {cursorX, cursorY} screen coords. */
  dragStart: (pos) => ipcRenderer.send('window:dragStart', pos),

  /** Moves the window during a drag. pos: {cursorX, cursorY} screen coords. */
  dragMove: (pos) => ipcRenderer.send('window:dragMove', pos),

  /** Ends the drag and persists the window position. */
  dragEnd: () => ipcRenderer.send('window:dragEnd'),

  /**
   * Asks the main process to pop the native right-click menu at the cursor.
   * Called from the renderer's contextmenu handler (which must preventDefault
   * first, otherwise Chromium's own menu would race it). The main process owns
   * the menu because "quit" has to be able to terminate the app cleanly.
   */
  showContextMenu: () => ipcRenderer.send('window:contextMenu'),

  /**
   * Subscribes to "open the settings panel" requests coming from the native
   * context menu. The menu lives in the main process, so it reaches the React
   * UI through this channel.
   * @param {() => void} callback
   * @returns {() => void} unsubscribe
   */
  onMenuOpenSettings: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('menu:openSettings', listener);
    return () => ipcRenderer.removeListener('menu:openSettings', listener);
  },

  /**
   * Subscribes to the main process asking the renderer to collapse any open
   * detail/settings panel. Fired when the user starts dragging the strip
   * while a panel is open, so the renderer drops its panel state and stops
   * pushing a stretched height back through ResizeObserver.
   * @param {() => void} callback
   * @returns {() => void} unsubscribe
   */
  onCollapsePanels: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('window:collapsePanels', listener);
    return () => ipcRenderer.removeListener('window:collapsePanels', listener);
  },

  /**
   * Debug-only: subscribes to "force open this agent's detail panel".
   * Used by automated tests that need the panel-open drag path without
   * needing a reliable simulated mouse click in the sandbox.
   * @param {(payload: {id: string}) => void} callback
   * @returns {() => void} unsubscribe
   */
  onDebugExpandPanel: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('debug:expandPanel', listener);
    return () => ipcRenderer.removeListener('debug:expandPanel', listener);
  },

  /** Debug-only: subscribes to "force close the panel". */
  onDebugCollapsePanel: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('debug:collapsePanel', listener);
    return () => ipcRenderer.removeListener('debug:collapsePanel', listener);
  },

  /**
   * Subscribes to auto-discovery notifications (v1.4.0): the main process
   * found a new AI app on this machine and added it to the strip.
   * @param {(discovered: Array<{id: string, name: string}>) => void} callback
   * @returns {() => void} unsubscribe
   */
  onAgentDiscovered: (callback) => {
    const listener = (_event, discovered) => callback(discovered);
    ipcRenderer.on('agent:discovered', listener);
    return () => ipcRenderer.removeListener('agent:discovered', listener);
  },

  /**
   * Subscribes to UI language changes (v1.5.0): the settings panel persisted
   * a new language and the main process broadcasts the RESOLVED pack id
   * ('zh-CN' | 'en-US') so the strip switches immediately.
   * @param {(lang: string) => void} callback
   * @returns {() => void} unsubscribe
   */
  onLanguageChange: (callback) => {
    const listener = (_event, lang) => callback(lang);
    ipcRenderer.on('language:change', listener);
    return () => ipcRenderer.removeListener('language:change', listener);
  },

  /**
   * 齿轮下拉菜单动作（v1.6.0 功能二）。
   * @param {'agents'|'settings'|'refresh'|'quit'} action 主进程白名单校验
   */
  gearAction: (action) => ipcRenderer.send('gear:action', action),

  /**
   * 订阅绿色版「有新版本」横幅（v1.6.0 功能五）。
   * @param {(info: {version: string, url: string}) => void} callback
   * @returns {() => void} unsubscribe
   */
  onUpdateAvailable: (callback) => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on('update:available', listener);
    return () => ipcRenderer.removeListener('update:available', listener);
  },

  /** 主进程代开外部链接（https 白名单，v1.6.0）。 */
  openExternal: (url) => ipcRenderer.send('shell:openExternal', url),

  /**
   * 订阅显示模式变化广播（v1.7.0）：主进程在 displayMode 切换（按钮/
   * 设置窗口/自动收起）并完成窗口尺寸换算后推送，渲染层据此重排 DOM。
   * @param {('classic' | 'compact' | 'mini') => void} callback
   * @returns {() => void} unsubscribe
   */
  onDisplayModeChange: (callback) => {
    const listener = (_event, mode) => callback(mode);
    ipcRenderer.on('displayMode:change', listener);
    return () => ipcRenderer.removeListener('displayMode:change', listener);
  },
});
