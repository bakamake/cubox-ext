# cubox-ext

跨浏览器 Cubox 同步扩展，基于 [WXT](https://wxt.dev) 构建。业务代码单份维护，Chrome（MV3）与 Firefox（MV2）产物由框架按目标自动生成。

## 常用命令

```bash
npm install          # 首次安装依赖
npm run dev          # Chrome 开发模式（HMR，自动打开浏览器加载）
npm run dev:firefox  # Firefox 开发模式
npm run build        # 产出 .output/chrome-mv3
npm run build:firefox# 产出 .output/firefox-mv2（自动携带 gecko id）
npm run zip          # 打分发包（上传应用商店用）
```

## 功能：收藏夹 → Cubox 单向实时同步

- 监听 `browser.bookmarks` 的 created/removed/changed/moved 事件，debounce 2s 合并触发增量对账；启动、安装、token 变更时触发全量对账
- 浏览器收藏夹为唯一数据源，向 Cubox 根目录下 `sync` 文件夹节点单向同步（不存在时由 save 接口自动创建）
- 增量 diff：比对书签树与 Cubox 全库索引，仅差异部分产生操作
- 前校验：全库查重，URL 已存在 Cubox 任何位置时不重复收藏；本地索引实时合并，批量内及并发重复 URL 不重复提交
- 批量：save 每批 20 张（批次间隔 400ms）、delete 每批 50 张
- 后校验：保存后渐进回查（1.5s/2.5s/4s/6s）确认入库；全部缺席判为服务端丢卡，移出索引并按每 URL 3 次预算安排重试
- 同步范围内（sync 文件夹内）重复卡片按 `create_time` 去旧留新
- MV3 service worker 可能被回收：debounce 丢失由 onStartup/onInstalled 全量对账自愈
- 重复收藏提示：新书签 URL 已在 Cubox 时，经系统通知栏提示（不抢焦点，4s 自动消失）
- 无额外 GUI；API Key 存于 popup（`storage.local`），首次使用先在 popup 填写

### 请求逻辑测试

```bash
node scripts/test-api.mts   # 在真实 API 上验证 cubox.ts 的 save/filter/update/delete（保存前查重）
```

## 结构

```
wxt.config.ts              # 唯一配置处：manifest 差异在此声明
src/entrypoints/
  background.ts            # 同步引擎（监听 + diff + 批量 + 校验 + 重复提示）
  content.ts               # defineContentScript() 占位
  popup/index.html+main.ts # 弹窗：填写 API Key、保存当前页
src/sync/cubox.ts          # Cubox API 封装（零 WXT 依赖，node 可直接执行）
scripts/test-api.mts       # 请求逻辑实测脚本
scripts/check-counts.md    # Console 粘贴用对账核验脚本
tools/gen_icon.py          # 图标生成：官方 logo → Material You 风格（语义分区/Monet 映射/轮廓清理）
assets/cubox_logo_src.png  # 图标源素材（Cubox 官方 logo）
```

## 跨内核特性

- `browser.*` API 由 WXT 统一 polyfill，直接写 `browser.tabs.query(...)` 
- `storage` 自动导入（unstorage 风格：`local:token`）
- manifest 差异（service_worker vs scripts、action vs browser_action、host_permissions 合并）由 `wxt build -b <browser>` 自动处理
- gecko id 位于 `wxt.config.ts` 的 `browser_specific_settings`，更换正式 id 时修改该处

## 备注

- popup 中的 API Key 存于 `storage.local`，不会上送；浏览器重启后临时扩展的存储被清空，需重新填写
- sync 文件夹命名：Firefox 系固定为 `sync`（运行时判据：支持 `runtime.getBrowserInfo`，覆盖 Zen 等 fork；同账号多设备天然同名）；Chrome 系为本机随机 `sync-<hex>`（存 `storage.local`）；查重逻辑同时识别两种形态
- 国际版账号需将 `wxt.config.ts` 中的 `cubox.pro` 改为 `cubox.cc`
- API 细节见 `../cubox-api/docs/API.md`；需求与决策依据见 `REQUIREMENTS.md`；协作规范见 `REQUIREMENTS_PROCESS.md`
- 分发包：`npm run zip` 产出 `.output/` 下 chrome/firefox 两个 zip；`.crx` 需经 `npx crx pack .output/chrome-mv3` 签名打包（生成 key.pem）；firefox 的 `.xpi` 由 firefox zip 改名得到，未签名，仅支持 about:debugging 临时载入或关闭签名的环境安装
