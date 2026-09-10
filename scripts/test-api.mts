// 用 node 直接执行 cubox.ts 的请求与解析逻辑（node 24 原生 type stripping）
// 顺带清理遗留的 example.com 测试卡片
import {
  listFolders,
  filterCards,
  saveCards,
  updateCardTitle,
  deleteCards,
} from "../src/sync/cubox.ts";

const TOKEN = "ahdlHc0gDsM";
let failed = 0;
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
};

const folders = await listFolders(TOKEN);
const syncId = folders.find((f) => f.nested_name === "sync")?.id ?? null;
console.log("sync folder id:", syncId);

// 0. 清理遗留测试卡片
const leftover: string[] = [];
for (const u of ["wxt-sync-test1", "wxt-sync-test2", "wxt-sync-test3", "wxt-sync-test4", "wxt-sync-test5"]) {
  const found = await filterCards(TOKEN, { url_filter: `https://example.com/${u}` });
  if (found[0]) leftover.push(found[0].id);
}
await deleteCards(TOKEN, leftover);
console.log("cleaned leftovers:", leftover.length);

// 1. 批量保存：保存前查重，URL 已在库内则跳过
const testUrls = [
  { url: "https://example.com/js-test-a", title: "JSTestA" },
  { url: "https://example.com/js-test-b", title: "JSTestB" },
];
let skipped = 0;
for (const t of testUrls) {
  const found = await filterCards(TOKEN, { url_filter: t.url });
  if (found.length) { skipped++; continue; } // 已存在，跳过
  await saveCards(TOKEN, "sync", [t]);
  await new Promise((r) => setTimeout(r, 400)); // 控制提交频率
}
console.log("skipped (already in library):", skipped);
await new Promise((r) => setTimeout(r, 2000));
let cards = await filterCards(TOKEN, { folder_filters: syncId ? [syncId] : [], limit: 50 });
const a = cards.find((c) => c.url === "https://example.com/js-test-a");
const b = cards.find((c) => c.url === "https://example.com/js-test-b");
check("batch save 2 cards into sync folder", !!a && !!b);
check("card id kept as string", typeof a?.id === "string" && a.id.length >= 15);

// 2. 标题一致性修正
if (a) {
  await updateCardTitle(TOKEN, a.id, "JSTestA-Renamed");
  await new Promise((r) => setTimeout(r, 2000));
  cards = await filterCards(TOKEN, { url_filter: "https://example.com/js-test-a" });
  check("update title", cards[0]?.title === "JSTestA-Renamed");
}

// 3. 批量删除
await deleteCards(TOKEN, [a?.id ?? "", b?.id ?? ""].filter(Boolean));
await new Promise((r) => setTimeout(r, 2000));
cards = await filterCards(TOKEN, { url_filter: "https://example.com/js-test" });
check("batch delete", !cards.some((c) => c.url.includes("js-test")));

process.exit(failed ? 1 : 0);
