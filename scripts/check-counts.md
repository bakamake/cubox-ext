// 在 about:debugging → 检查 → Console 粘贴运行（扩展上下文）
// 注意：服务端分页上限约 250~300 行，limit 超过会报 -2004，统一用 250

// ① 期望值：书签去重后，不在 Cubox 全库里的 = 应该同步进 sync 的数量
(async () => {
  const tk = "ahdlHc0gDsM";
  const t = await browser.bookmarks.getTree();
  const marks = new Set();
  const w = (ns) => ns.forEach((x) => { if (x.url) marks.add(x.url.split("#")[0]); if (x.children) w(x.children); });
  w(t);
  const lib = new Set(); let last = "";
  for (;;) {
    const d = await fetch("https://cubox.pro/c/api/cli/card/filter", {
      method: "POST",
      headers: { Authorization: "Bearer " + tk, "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 250, ...(last ? { last_card_id: last } : {}) }),
    }).then((r) => r.json());
    if (d.code !== 200) { console.log("全库查询失败:", d.message); return; }
    d.data.forEach((c) => lib.add(c.url.split("#")[0]));
    if (d.data.length < 250) break;
    last = d.data[d.data.length - 1].id;
  }
  const missing = [...marks].filter((u) => !lib.has(u));
  console.log(`书签去重后=${marks.size}  全库去重后=${lib.size}  应同步(书签不在库里)=${missing.length}`);
  console.log("应同步但还没进库的:\n" + missing.join("\n"));
})();

// ② 实际值：sync 文件夹真实卡数 + 里面有没有残留重复 URL
(async () => {
  const tk = "ahdlHc0gDsM";
  const flds = await fetch("https://cubox.pro/c/api/cli/folder/list", { headers: { Authorization: "Bearer " + tk } }).then((r) => r.json());
  const syncs = flds.data.filter((f) => f.nested_name === "sync" || f.nested_name.startsWith("sync-"));
  console.log("sync 文件夹:", syncs.map((f) => f.nested_name).join(", ") || "(无)");
  for (const f of syncs) {
    const urls = []; let last = "";
    for (;;) {
      const d = await fetch("https://cubox.pro/c/api/cli/card/filter", {
        method: "POST",
        headers: { Authorization: "Bearer " + tk, "Content-Type": "application/json" },
        body: JSON.stringify({ folder_filters: [f.id], limit: 250, ...(last ? { last_card_id: last } : {}) }),
      }).then((r) => r.json());
      if (d.code !== 200) { console.log(f.nested_name, "查询失败:", d.message); break; }
      urls.push(...d.data.map((c) => c.url.split("#")[0]));
      if (d.data.length < 250) break;
      last = d.data[d.data.length - 1].id;
    }
    console.log(`${f.nested_name}: 卡=${urls.length} 去重后=${new Set(urls).size}`);
  }
})();
