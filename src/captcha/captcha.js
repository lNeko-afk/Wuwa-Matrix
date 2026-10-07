'use strict';
/**
 * 极验 v4 人机校验小窗的逻辑。
 *
 * 为什么单独开一个窗口、还必须走 http://127.0.0.1：
 *   - 极验只认 http(s) 源，在 file:// 下 initGeetest4 会静默不回调（实测）；
 *   - 把它隔离在一个空窗口里，第三方脚本就够不到主界面的任何数据。
 *
 * captcha_id 由主进程通过 URL 参数传进来（只有一处定义，见 main.cjs 的 CAPTCHA_ID）。
 * 它来自 Kuro-API-Collection 中库街区 getSmsCode 的请求示例，2026-10-07 实测仍有效。
 */
const CAPTCHA_ID = new URLSearchParams(location.search).get('captchaId') || '';

const statusEl = document.getElementById('status');
const capEl = document.getElementById('cap');

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind ? ` is-${kind}` : '');
}

document.getElementById('cancel').addEventListener('click', () => {
  window.captchaBridge.cancel();
});

if (typeof window.initGeetest4 !== 'function') {
  setStatus('校验脚本没能加载（网络不通或被拦截）。可以在库街区 App 里手动获取验证码。', 'error');
} else {
  initGeetest4({ captchaId: CAPTCHA_ID, product: 'popup', language: 'zho' }, (captcha) => {
    captcha.appendTo('#cap');
    setStatus('请点击上方按钮并拖动滑块完成校验。');

    captcha
      .onSuccess(() => {
        const v = captcha.getValidate() || {};
        setStatus('校验通过，正在发送验证码…', 'ok');
        window.captchaBridge.solved({
          lot_number: v.lot_number,
          pass_token: v.pass_token,
          gen_time: v.gen_time,
          captcha_output: v.captcha_output,
        });
      })
      .onError((err) => {
        setStatus('校验出错，请重试。' + (err ? ` (${JSON.stringify(err).slice(0, 120)})` : ''), 'error');
      })
      .onClose(() => {
        window.captchaBridge.cancel();
      });
  });
}
