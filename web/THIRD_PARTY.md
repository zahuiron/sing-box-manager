# 第三方资源

- `src/vendor` 的样式来自 [sing-box-dashboard](https://github.com/SagerNet/sing-box-dashboard/tree/3e4bf08e5bf5b9417cf9c36e5a2d5abcb21bdd34)，GPL-3.0-or-later；保留原许可证，品牌已替换。
- `src/vendor/PreferenceControls.tsx`、`uiHooks.ts`、设置与登录页样式及 `src/theme.ts` 复用同版本的通用 UI 源码，适配本项目状态和翻译；导航行、页面标题和 SVG 图标组件采用相同结构。
- 图标来自同版本 Material Design Icons，Apache-2.0；字体采用参考项目相同的 Schibsted Grotesk、Source Serif 4、IBM Plex Mono，OFL-1.1。
- 构建时将运行依赖许可证一并输出到 `/licenses/`。
- `src/schema/sing-box.schema.json` 由 sing-box 的 `schema` 命令生成，GPL-3.0-or-later；原始版权和附加声明见 `../licenses/sing-box-LICENSE.txt`。
- 上述复用代码的适配日期为 2026-11-05、2026-11-06；修改范围见源码文件头和根目录 `NOTICE`。
- Go 运行时和标准库采用 BSD 许可，版权和专利授权见根目录 `licenses/Go-LICENSE.txt`、`licenses/Go-PATENTS.txt`。
