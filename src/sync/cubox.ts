// Cubox CLI HTTP API 封装。零依赖、无 WXT 引用，可直接用 node 执行测试。
// 卡片 id 为 int64，超出 JS Number 安全范围，请求体须以原始数字字面量拼接，不可经 JSON.stringify 转为数值。

export const BASE_URL = "https://cubox.pro";

export interface Folder {
  id: string;
  nested_name: string;
}

export interface Card {
  id: string;
  title: string;
  url: string;
  domain?: string;
  create_time?: string;
}

async function request(token: string, method: string, path: string, body?: string): Promise<unknown> {
  const resp = await fetch(BASE_URL + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body,
  });
  const json = await resp.json();
  if (json.code !== 200) throw new Error(`cubox ${path}: ${json.code} ${json.message}`);
  return json.data;
}

export async function listFolders(token: string): Promise<Folder[]> {
  return (await request(token, "GET", "/c/api/cli/folder/list")) as Folder[];
}

export async function filterCards(
  token: string,
  query: { folder_filters?: string[]; url_filter?: string; limit?: number; last_card_id?: string },
): Promise<Card[]> {
  return (await request(token, "POST", "/c/api/cli/card/filter", JSON.stringify(query))) as Card[];
}

// folder_nested_name 放顶层；文件夹不存在时服务端会自动创建
export async function saveCards(
  token: string,
  folderNestedName: string,
  cards: { url: string; title: string }[],
): Promise<void> {
  await request(
    token,
    "POST",
    "/c/api/cli/cards/save",
    JSON.stringify({ folder_nested_name: folderNestedName, cards }),
  );
}

// id 为十进制字符串，直接拼进 JSON 保证 int64 精度
export async function updateCardTitle(token: string, id: string, title: string): Promise<void> {
  await request(token, "POST", "/c/api/cli/card/update", `{"id":${id},"title":${JSON.stringify(title)}}`);
}

// 请求体为裸 JSON 数组；包装为对象时服务端返回 -5000 illegal json
export async function deleteCards(token: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await request(token, "POST", "/c/api/cli/cards/delete", JSON.stringify(ids));
}
