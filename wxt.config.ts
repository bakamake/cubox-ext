import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: "src",
  suppressWarnings: {
    // 本扩展不采集任何数据；Firefox 自 2025-11-03 起要求新扩展声明
    // data_collection_permissions，现有扩展暂时豁免，无需处理
    firefoxDataCollection: true,
  },
  manifest: {
    name: "Cubox Ext",
    description: "Save the current page to Cubox",
    permissions: ["storage", "activeTab", "tabs", "bookmarks", "notifications"],
    host_permissions: ["https://cubox.pro/*"],
    icons: {
      16: "icon/16.png",
      32: "icon/32.png",
      48: "icon/48.png",
      128: "icon/128.png",
    },
    action: {
      default_icon: {
        16: "icon/16.png",
        32: "icon/32.png",
        48: "icon/48.png",
        128: "icon/128.png",
      },
    },
    // WXT 将 action 转为 MV2 browser_action 时会丢弃 default_icon，
    // 显式声明保证 Firefox 系工具栏图标来源明确
    browser_action: {
      default_icon: {
        16: "icon/16.png",
        32: "icon/32.png",
        48: "icon/48.png",
        128: "icon/128.png",
      },
    },
    browser_specific_settings: {
      gecko: { id: "cubox-ext@example.com" },
    },
  },
});
