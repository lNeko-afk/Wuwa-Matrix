'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wuwa', {
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (data) => ipcRenderer.invoke('config:save', data),
  credStatus: () => ipcRenderer.invoke('kuro:credStatus'),
  login: (payload) => ipcRenderer.invoke('kuro:login', payload),
  logout: () => ipcRenderer.invoke('kuro:logout'),
  fetchRoster: () => ipcRenderer.invoke('kuro:roster'),
  fetchIcons: () => ipcRenderer.invoke('kuro:icons'),
});
