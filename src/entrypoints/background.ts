import {
  listFolders,
  filterCards,
  saveCards,
  deleteCards,
  type Card,
} from "../sync/cubox";

const SAVE_BATCH = 20;
const DELETE_BATCH = 50;
// 服务端分页行数上限约 250~300，超限报 -2004，取值保留余量
const PAGE_SIZE = 200;
const DEBOUNCE_MS = 2000;
// 服务端会静默丢弃无间隔连发的批量（HTTP 200 但不落库）
const BATCH_INTERVAL_MS = 400;
const RETRY_MS = 15000;
// 服务端异步落库，渐进回查；全部缺席才判丢
const SETTLE_STEPS = [1500, 2500, 4000, 6000];

interface CardInfo {
  id: string;
  title: string;
}

function chunks<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// URL 的 # 片段仅存于浏览器本地，服务端入库 URL 不含 fragment；
// 比对与保存前统一去除，保证两侧口径一致
function stripHash(url: string): string {
  return url.split("#")[0];
}

function collectBookmarks(
  nodes: Browser.bookmarks.BookmarkTreeNode[],
  out = new Map<string, string>(),
): Map<string, string> {
  for (const node of nodes) {
    if (node.url) out.set(stripHash(node.url), node.title ?? "");
    if (node.children) collectBookmarks(node.children, out);
  }
  return out;
}

export default defineBackground(() => {
  let folderId: string | null = null;
  // 全库索引：前校验查重用，URL 已存在库内任何位置时不重复收藏
  let globalIndex = new Map<string, CardInfo>();
  // sync 文件夹内的卡片：删除与去重仅作用于该范围，不影响库内其他卡片
  let syncCards: Card[] = [];
  // 丢卡重试预算：同一 URL 最多重试 3 次，超出后留待全量对账
  const retryBudget = new Map<string, number>();

  async function getToken(): Promise<string> {
    return ((await storage.getItem<string>("local:token")) ?? "").trim();
  }

  // sync 文件夹名：Firefox 系（含 Zen 等 fork，判据为支持 runtime.getBrowserInfo）
  // 固定 "sync"（同账号多设备同名）；Chrome 系构建使用本机随机 sync-<hex>。
  // 查重同时识别 "sync" 与 "sync-<hex>" 两种形态
  let folderNameCache: Promise<string> | null = null;
  function syncFolderName(): Promise<string> {
    if (typeof browser.runtime.getBrowserInfo === "function") return Promise.resolve("sync");
    folderNameCache ??= (async () => {
      let name = await storage.getItem<string>("local:syncFolder");
      if (!name) {
        name = `sync-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
        await storage.setItem("local:syncFolder", name);
      }
      return name;
    })();
    return folderNameCache;
  }

  async function refreshFolder(tk: string): Promise<void> {
    const name = await syncFolderName();
    const folders = await listFolders(tk);
    folderId =
      folders.find((f) => f.nested_name === name)?.id ??
      folders.find((f) => f.nested_name === "sync" || f.nested_name.startsWith("sync-"))?.id ??
      null;
  }

  async function fetchAllCards(
    tk: string,
    base: { folder_filters?: string[] },
  ): Promise<Card[]> {
    const out: Card[] = [];
    let last = "";
    for (;;) {
      const data = await filterCards(tk, {
        ...base,
        limit: PAGE_SIZE,
        ...(last ? { last_card_id: last } : {}),
      });
      out.push(...data);
      if (data.length < PAGE_SIZE) break;
      last = data[data.length - 1].id;
    }
    return out;
  }

  // filter 对失效文件夹 id 报 -2004（folder/list 可能残留已删除的 id）；
  // 按文件夹不存在处理：清空 folderId 与 syncCards，等待下次对账重建
  async function refetchSyncCards(tk: string): Promise<void> {
    try {
      syncCards = folderId ? await fetchAllCards(tk, { folder_filters: [folderId] }) : [];
    } catch {
      folderId = null;
      syncCards = [];
    }
  }

  async function buildFullIndex(tk: string): Promise<void> {
    await refreshFolder(tk);
    let all: Card[];
    try {
      all = await fetchAllCards(tk, {});
    } catch {
      // 无过滤全库查询间歇性返回 -2004（服务端数据异常）：
      // 降级为按 folder/list 逐文件夹聚合；单文件夹失败跳过，不阻塞整体索引
      all = [];
      for (const f of await listFolders(tk)) {
        try {
          all.push(...(await fetchAllCards(tk, { folder_filters: [f.id] })));
        } catch { /* 跳过查询失败的文件夹 */ }
        await new Promise((r) => setTimeout(r, 100)); // 避免读取请求连发触发限流
      }
    }
    globalIndex = new Map(all.map((c) => [stripHash(c.url), { id: c.id, title: c.title }]));
    await refetchSyncCards(tk);
  }

  // 对账主流程：full 模式重建全库索引；增量模式复用内存索引（MV2 常驻后台）。
  // 后校验仅拉取 sync 文件夹，不做全库重建
  async function flush(tk: string, full: boolean): Promise<void> {
    const marks = collectBookmarks(await browser.bookmarks.getTree());
    const folderName = await syncFolderName();
    if (full) await buildFullIndex(tk);

    // diff：新增经全库查重，删除仅作用于 sync 文件夹范围；仅校验 URL
    const toAdd = [...marks].filter(([url]) => !globalIndex.has(url));
    const toDel = syncCards.filter((c) => !marks.has(c.url)).map((c) => c.id);

    // 前校验：索引实时合并，批量内及并发产生的重复 URL 不重复提交
    let added = 0;
    for (const batch of chunks(toAdd, SAVE_BATCH)) {
      await saveCards(tk, folderName, batch.map(([url, title]) => ({ url, title })));
      for (const [url, title] of batch) globalIndex.set(url, { id: "", title });
      added += batch.length;
      await new Promise((r) => setTimeout(r, BATCH_INTERVAL_MS));
    }

    let deleted = 0;
    for (const batch of chunks(toDel, DELETE_BATCH)) {
      await deleteCards(tk, batch);
      deleted += batch.length;
    }
    if (toDel.length) {
      const delIds = new Set(toDel);
      syncCards = syncCards.filter((c) => !delIds.has(c.id));
    }

    // 后校验：服务端异步落库（延迟 1~数秒），渐进回查；全部缺席判为丢卡
    let missing = toAdd.map(([url]) => url);
    if (missing.length) {
      for (const wait of SETTLE_STEPS) {
        await new Promise((r) => setTimeout(r, wait));
        await refreshFolder(tk); // 首次 save 可能刚自动建出目录
        await refetchSyncCards(tk);
        const urls = new Set(syncCards.map((c) => c.url));
        missing = missing.filter((url) => !urls.has(url));
        if (!missing.length) break;
      }
    } else {
      await refreshFolder(tk);
      await refetchSyncCards(tk);
    }
    // 乐观写入索引但服务端未落库的 URL：移出索引并计入重试预算
    if (missing.length) {
      console.warn(`[cubox-sync] server dropped ${missing.length}/${toAdd.length} cards, retrying`, missing.join(" "));
      let retryCount = 0;
      for (const url of missing) {
        globalIndex.delete(url);
        const n = (retryBudget.get(url) ?? 0) + 1;
        retryBudget.set(url, n);
        if (n <= 3) retryCount++;
      }
      // 延迟增量重试；超预算 URL 不再主动重试，留待全量对账
      if (retryCount) setTimeout(() => void run(false), RETRY_MS);
    } else if (toAdd.length) {
      for (const [url] of toAdd) retryBudget.delete(url); // 入库成功清除预算
    }

    // sync 文件夹内同 URL 去重：按 create_time 保留最新
    const groups = new Map<string, Card[]>();
    for (const c of syncCards) {
      const g = groups.get(c.url) ?? [];
      g.push(c);
      groups.set(c.url, g);
    }
    const dupIds: string[] = [];
    for (const g of groups.values()) {
      if (g.length > 1) {
        g.sort((a, b) => (b.create_time ?? "").localeCompare(a.create_time ?? ""));
        dupIds.push(...g.slice(1).map((c) => c.id));
      }
    }
    for (const batch of chunks(dupIds, DELETE_BATCH)) {
      await deleteCards(tk, batch);
      deleted += batch.length;
    }
    if (dupIds.length) {
      const dupSet = new Set(dupIds);
      syncCards = syncCards.filter((c) => !dupSet.has(c.id));
    }

    if (added || deleted) {
      console.info(`[cubox-sync] add=${added} del=${deleted}${full ? " (full)" : ""}`);
    }
  }

  // 对账串行化：重载会同时触发顶层 run(true) 与 onInstalled run(true)，
  // 并发 flush 会导致重复保存或重复建目录；所有 run 排队执行
  let queue: Promise<void> = Promise.resolve();
  function run(full: boolean): Promise<void> {
    queue = queue.then(async () => {
      const tk = await getToken();
      if (!tk) return;
      console.info(`[cubox-sync] run ${full ? "full" : "incr"}`);
      try {
        await flush(tk, full);
      } catch (err) {
        console.error("[cubox-sync]", err);
      }
    });
    return queue;
  }

  // 状态查询：返回库内该 URL 的现有卡片，供 popup 展示；保存由同步引擎负责
  async function queryUrl(url: string): Promise<{ found: number; text: string }> {
    const tk = await getToken();
    if (!tk) return { found: 0, text: "未配置 API Key" };
    const cards = await filterCards(tk, { url_filter: url });
    const unique = [...new Map(cards.map((c) => [c.id, c])).values()];
    return {
      found: unique.length,
      text: unique.length
        ? `库里已有 ${unique.length} 张：\n` +
          unique.map((c) => `${c.title || c.url}（${c.domain || new URL(c.url).host}）`).join("\n")
        : "",
    };
  }

  // popup 即时保存通道：立即保存当前页，不并入批量管线；与批量管线共享
  // globalIndex，重复保存由去旧留新兜底
  async function saveNow(url: string, title: string): Promise<{ found: number; text: string }> {
    url = stripHash(url);
    const tk = await getToken();
    if (!tk) return { found: 0, text: "未配置 API Key" };
    if (globalIndex.has(url)) return queryUrl(url); // 库内已有，直接展示现状
    try {
      await saveCards(tk, await syncFolderName(), [{ url, title }]);
      globalIndex.set(url, { id: "", title });
      for (const wait of [1200, 2000, 3500]) {
        await new Promise((r) => setTimeout(r, wait));
        const cards = await filterCards(tk, { url_filter: url });
        if (cards.length) {
          const unique = [...new Map(cards.map((c) => [c.id, c])).values()];
          return {
            found: unique.length,
            text: `已保存 ${unique.length} 张：\n` +
              unique.map((c) => `${c.title || c.url}（${c.domain || new URL(c.url).host}）`).join("\n"),
          };
        }
      }
      return { found: 0, text: "服务端暂未确认入库，引擎稍后自动重试" };
    } catch (err) {
      return { found: 0, text: "错误：" + String(err) };
    }
  }

  // 重复收藏提示：系统通知不抢焦点、不干扰页面操作，4s 自动消失
  async function notifyDup(title: string, url: string): Promise<void> {
    try {
      const id = await browser.notifications.create({
        type: "basic",
        iconUrl: browser.runtime.getURL("/icon/128.png"),
        title: "Cubox 同步",
        message: `已在 Cubox，跳过重复收藏：${title || url}`,
      });
      setTimeout(() => void browser.notifications.clear(id), 4000);
    } catch { /* 通知不可用时静默，不影响同步 */ }
  }

  // MV3 service worker 可能被回收，debounce 丢失由 onStartup/onInstalled 全量对账自愈
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void run(false), DEBOUNCE_MS);
  };

  browser.runtime.onStartup.addListener(() => void run(true));
  browser.runtime.onInstalled.addListener(() => void run(true));
  browser.bookmarks.onCreated.addListener((_id, node) => {
    schedule();
    // 重复收藏轻提示；索引未建成时跳过（由全库查重兜底）
    if (node.url && globalIndex.has(stripHash(node.url))) {
      void notifyDup(node.title ?? "", stripHash(node.url));
    }
  });
  browser.bookmarks.onRemoved.addListener(schedule);
  browser.bookmarks.onChanged.addListener(schedule);
  browser.bookmarks.onMoved.addListener(schedule);
  browser.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "token-changed") {
      void run(true);
      return; // 无需应答
    }
    if (msg?.type === "save-now") return saveNow(msg.url, msg.title); // popup 即时保存请求
    if (msg?.type === "query-url") return queryUrl(msg.url); // 状态查询，Promise 应答 popup
  });

  void run(true);
});
