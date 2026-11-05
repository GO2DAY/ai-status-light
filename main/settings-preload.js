'use strict';

/**
 * 设置窗口（main/settings.html）的 preload。
 * 只暴露三个白名单通道，contextIsolation 保持开启，页面无任何 node 能力。
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('aslSettings', {
  /**
   * 读取当前完整配置快照。
   * @returns {Promise<{agents, watchers, soundOn, cloudRelay, screenWatch, openAtLogin, packaged}>}
   */
  load: () => ipcRenderer.invoke('settingsPanel:get'),

  /**
   * 整包保存。主进程用 settings-ops 校验通过后才落盘。
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  save: (payload) => ipcRenderer.invoke('settingsPanel:save', payload),

  /** 关闭设置窗口（「取消」按钮）。 */
  close: () => ipcRenderer.send('settingsPanel:close'),

  /** 解除自动发现黑名单（v1.4.1）。返回 {ok, error?}。 */
  unblacklist: (id) => ipcRenderer.invoke('settingsPanel:unblacklist', id),

  /**
   * 取拖入 File 对象的绝对路径（v1.4.3）。
   * Electron 31 起 File.path 已移除，必须用 webUtils.getPathForFile。
   * @param {File} file drop 事件里的 File 对象
   * @returns {string} 绝对路径；取不到时返回空串
   */
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch (_err) {
      return '';
    }
  },

  /**
   * 让主进程解析 .lnk / exe，提取名称与进程名（v1.4.3）。
   * 返回 {ok, displayName?, processName?, targetPath?, partial?, error?}。
   */
  resolveShortcut: (path) => ipcRenderer.invoke('settingsPanel:resolveShortcut', path),

  /**
   * 重新生成 MQTT 主题前缀（v1.5.0 脱敏）。旧主题立即失效（桥重启），
   * 返回 {ok, topic?, error?}，topic 为新主题（面板展示给云端脚本抄录）。
   */
  regenerateTopic: () => ipcRenderer.invoke('settingsPanel:regenerateTopic'),

  /** 主进程代开外部链接（https 白名单，v1.6.0：预设官网/Ko-fi）。 */
  openExternal: (url) => ipcRenderer.send('shell:openExternal', url),

  /**
   * 手动「检查更新」（v1.6.1 功能三）。
   * 返回 {state:'new'|'latest'|'not-ready', version?, url?}——三态必有一回响。
   */
  checkUpdate: () => ipcRenderer.invoke('update:checkNow'),

  /**
   * 订阅「滚动到某区」请求（v1.6.0：设置窗口已开时，齿轮菜单
   * 再点「AI 源管理」经此定位到灯源管理区）。
   * @param {(section: string) => void} callback
   * @returns {() => void} unsubscribe
   */
  onScrollTo: (callback) => {
    const listener = (_event, section) => callback(section);
    ipcRenderer.on('settingsPanel:scrollTo', listener);
    return () => ipcRenderer.removeListener('settingsPanel:scrollTo', listener);
  },
});
