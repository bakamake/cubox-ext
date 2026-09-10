const $token = document.getElementById("token") as HTMLInputElement;
const $save = document.getElementById("save") as HTMLButtonElement;
const $status = document.getElementById("status") as HTMLDivElement;

const setStatus = (s: string) => {
  $status.textContent = s;
};

// 按钮监听优先注册：初始化失败不影响点击响应
$save.addEventListener("click", async () => {
  setStatus("① 点击已响应");
  try {
    const token = $token.value.trim();
    if (!token) {
      setStatus("请先填 API Key");
      return;
    }
    setStatus("② 读取当前标签页…");
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) {
      setStatus("当前页面没有 URL，无法收藏");
      return;
    }
    setStatus("③ 检查/创建原生书签…");
    const existing = await browser.bookmarks.search({ url: tab.url });
    // 卡片名复用已有书签名；无书签名时使用页面标题
    const name = existing[0]?.title || tab.title || tab.url;
    if (existing.length === 0) {
      await browser.bookmarks.create({ url: tab.url, title: name });
    }
    setStatus("④ 书签已创建，立即同步当前页…");
    // 即时保存通道：直连 background 保存并答复；失败则退回状态轮询
    try {
      const res = await browser.runtime.sendMessage({ type: "save-now", url: tab.url, title: name });
      if (res?.text) {
        setStatus(res.text);
        return;
      }
    } catch {
      // background 重载中或版本不兼容：退回轮询
    }
    pollStatus(tab.url);
  } catch (err) {
    setStatus("错误：" + String(err));
  }
});

// token 异步加载，失败不阻塞按钮
(async () => {
  try {
    $token.value = (await storage.getItem<string>("local:token")) ?? "";
  } catch (err) {
    console.error("[cubox-ext] load token failed", err);
  }
})();

$token.addEventListener("change", () => {
  storage.setItem("local:token", $token.value.trim());
  void browser.runtime.sendMessage({ type: "token-changed" });
});

// 状态轮询：popup 关闭即停止；同步流程在 background 中继续，不受 popup 生命周期影响
function pollStatus(url: string): void {
  let tries = 0;
  const timer = setInterval(async () => {
    tries++;
    try {
      setStatus(`⑤ 第 ${tries} 次查询…`);
      const res = await browser.runtime.sendMessage({ type: "query-url", url });
      if (res?.found) {
        setStatus(res.text);
        clearInterval(timer);
      } else if (tries >= 20) {
        setStatus("同步较慢，卡片稍后可在 Cubox 查看");
        clearInterval(timer);
      }
    } catch {
      // background 重载等原因断连：停止轮询，同步流程不受影响
      clearInterval(timer);
    }
  }, 1500);
  window.addEventListener("unload", () => clearInterval(timer));
}
