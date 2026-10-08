'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wuwa', {
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (data) => ipcRenderer.invoke('config:save', data),
  credStatus: () => ipcRenderer.invoke('kuro:credStatus'),
  login: (payload) => ipcRenderer.invoke('kuro:login', payload),
  sendSmsCode: (payload) => ipcRenderer.invoke('kuro:sendSmsCode', payload),
  logout: () => ipcRenderer.invoke('kuro:logout'),
  fetchRoster: () => ipcRenderer.invoke('kuro:roster'),
  fetchIcons: () => ipcRenderer.invoke('kuro:icons'),
  captureShare: (payload) => ipcRenderer.invoke('share:capture', payload),
  revealPath: (filePath) => ipcRenderer.invoke('share:reveal', filePath),
});
