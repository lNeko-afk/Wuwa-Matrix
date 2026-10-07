'use strict';
/**
 * 人机校验小窗的 preload。
 * 只暴露两个动作：告诉主进程校验通过（带极验的校验数据）／取消。
 * 刻意不暴露任何应用数据 —— 这个窗口对第三方脚本而言是「空的」。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('captchaBridge', {
  solved: (data) => ipcRenderer.invoke('captcha:solved', data),
  cancel: () => ipcRenderer.invoke('captcha:cancel'),
});
