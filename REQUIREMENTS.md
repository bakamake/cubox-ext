# cubox-ext 需求与决策汇总

版本：v1.0　日期：2026-09-10

> 本文记录设计决策及其依据。每项决策对应一次实际事故或一条明确需求。修改代码前应先核对本文，确认变更不与既有决策冲突。

## 1. 目标

浏览器收藏夹为唯一数据源，单向实时同步至 Cubox 根目录下 `sync` 文件夹。浏览器书签内容即 Cubox 同步目标内容；Cubox 侧存量数据（历史迁移约 1k+ 张）仅用于查重，不得删改。

## 2. 环境

- 浏览器：Firefox 系 fork（Zen），书签经 Firefox 账号在多台设备间同步；Chrome 系构建存在但不使用
- Cubox 账号：单个；API Key 在 popup 填写一次，存于 `storage.local`（浏览器重启后临时扩展存储被清空，需重新填写）
- 数据规模：书签 2k+，Cubox 库 1k+

## 3. 功能需求（原始）

1. 监听书签 created/removed/changed/moved 事件，debounce 2s 触发增量对账；启动、安装、token 变更触发全量对账
2. 前校验：全库查重——URL 已存在于 Cubox 任何位置时不重复收藏
3. 后校验：保存后渐进回查（1.5s/2.5s/4s/6s），确认入库
4. 增删走增量 diff，批量提交、批量后校验
5. GUI 最小化：仅 popup（填 Key + 保存当前页）；同步流程全部位于 background，popup 关闭不影响执行
6. 重复收藏提示：新书签 URL 已在 Cubox 时，经系统通知栏提示——不抢焦点、不打扰页面操作、4s 自动消失。采用 `browser.notifications`（OS 级通知），禁用浏览器内 messagebox 类实现
7. 卡片名直接采用书签名提交；不做 name 校验与改名（服务端会将标题覆盖为 `WebPage: host`，属已知且接受的行为）

## 4. 关键设计决策

| 决策 | 依据 |
|---|---|
| 仅校验 URL | 需求方明确要求最小逻辑；name 同步不可靠（服务端覆盖） |
| `stripHash`：比对与保存前去除 URL `#` 片段 | `#` 后内容不会发送至服务器；去除前出现 add/del 无限循环（实测 add=8 del=8） |
| 文件夹名双轨：Firefox 系固定 `sync`；Chrome 构建 `sync-<hex>` 存于 local | Firefox 系判据为支持 `runtime.getBrowserInfo`（覆盖 Zen 等 fork，不看浏览器名称）；Firefox 同账号多设备天然同名；Chrome 各厂不互通，采用本机随机名。需求方原话："firefox fork+同账号里简单就行，我只用 firefox fork"；查重逻辑须同时识别两种形态 |
| 对账队列串行化 | 重载同时触发顶层 run 与 onInstalled run，并发 flush 曾产生两个 sync 文件夹 |
| `PAGE_SIZE = 200` | 服务端分页存在隐形行数上限（250 可行、300 报错），报错信息为误导性的 `-2004 id parameter error` |
| `buildFullIndex` 降级：无过滤全库查询失败时，逐文件夹聚合（间隔 100ms，单文件夹失败跳过） | 无过滤查询间歇性返回 -2004（疑似批量删除后服务端孤儿数据，curl 可复现，与浏览器无关）；folder 维度查询稳定 |
| save 批次间隔 400ms | 连续 10 批无间隔提交时，服务端静默丢弃（HTTP 200 但不落库），曾一次丢失 192 张 |
| 渐进回查 + 丢卡重试预算（每 URL 3 次） | 服务端异步落库延迟 1~数秒；全部缺席方判丢，超预算后不再主动重试，留待下次全量对账 |
| sync 文件夹内去重：去旧留新 | 调试期产生大量重复收藏；按 `create_time` 保留最新 |
| 卡片 id 全程按字符串处理，delete 请求体手工拼 JSON | id 为 int64，进入 JS Number 会丢失精度 |
| 重复收藏提示采用系统通知 | 需求方要求"不带焦点、不干扰页面操作、自动消失"；`browser.notifications` 满足全部条件 |

## 5. Cubox 服务端实测结论

详见 `../cubox-api/docs/API.md`。要点：

- `-2004` 报错文案不可信：行数超限、数据损坏均返回该码
- `cards/save` 的 `folder_nested_name` 必须置于顶层（per-card folder 字段无效）；自动建目录非幂等（服务端允许同名文件夹）
- `cards/delete` 请求体为裸 JSON 数组；包装为对象返回 `-5000 illegal json`
- `filter` 的 `folder_filters` 仅接受文件夹 id；`url_filter` 为全库精确匹配；无过滤即全库查询，但存在第 4 条所述的不稳定性
- 服务端拒收 `cubox.pro/c/api/save/...` 自身链接（返回 200 但不建卡）

## 6. 开发约定（需求方偏好）

- 最小改动、最少请求、最少错误处理分支；先运行，待实测暴露问题后再补
- 禁止主动、反复以 curl/node 探测服务端（需求方明确要求）
- 诊断依据：需求方提供 `about:debugging → 检查` 的 Console 日志；每次修改后须提醒重新载入扩展
- 文档从简：README 仅放一行备注，细节集中于本文与 `../cubox-api/docs/API.md`

## 7. 调试工具

- `scripts/check-counts.md`：Console 粘贴脚本。① 计算"应同步数量"（书签去重后不在全库中的 URL 数）；② 统计 sync 文件夹实际卡数与重复情况。已适配 `sync` 与 `sync-hex` 两种命名
- `scripts/test-api.mts`：node 直接执行 API 封装测试；保存前经 `url_filter` 查重，防止调试期刷入重复卡

## 8. 未决事项

| 事项 | 现状 | 下一步 |
|---|---|---|
| sync 卡数 193 的构成 | 推测为旧 503 张中需求方测试期间删除约 310 个书签后的剩余量 | 需求方实测验证 |
| 无过滤查询的服务端"损坏带" | 仍在游动，降级逻辑兜底中 | 若触发频繁，评估改为永久逐文件夹聚合 |
| 回收站是否参与查重索引 | 按 193 推测不参与（删除文件夹后旧 URL 被重新加入 sync） | 待最终确认 |
