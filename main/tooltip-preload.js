'use strict';

/**
 * Preload for the tooltip window: exposes a one-way data channel.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tooltipApi', {
  /**
   * Subscribes to tooltip payload pushes from the main process.
   * @param {(agent: object) => void} callback
   * @returns {() => void} unsubscribe function
   */
  onData: (callback) => {
    const listener = (_event, agent) => callback(agent);
    ipcRenderer.on('tooltip:data', listener);
    return () => ipcRenderer.removeListener('tooltip:data', listener);
  },
});
