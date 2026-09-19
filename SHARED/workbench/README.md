# OpenStarry IDE 与预览源码

这是 OpenStarry 的实际共享工作台源码，桌面和手机使用同一套组件。不是 Codex 桌面客户端的内部源码。示例直接挂载这些组件，包含真实编辑器、主题菜单和 HTML 预览。

遵循项目根目录的 GPL-3.0 许可证；独立源码压缩包包含该许可证。

## 独立运行

需要 Node.js 22.12+（或 20.19+）。解压后在本目录执行：

```sh
npm ci
npm run dev -- --host 127.0.0.1 --port 5180
```

打开终端显示的本地地址。点击「网页预览」运行示例；可以修改 HTML、CSS、JavaScript，再次预览。此示例保存在该本地地址的浏览器存储中。它没有预置模型、API 密钥或服务器连接；连接 Agent 时由宿主通过 `mountWorkbench` 的 `getModel`、`getModels`、`selectModel` 提供配置。

```sh
npm test
npm run build
```

## 源码位置

| 文件 | 用途 |
| --- | --- |
| `src/index.js` | 项目树、编辑器、输出、Agent 及预览的组装入口 |
| `src/picker.js` | 自定义下拉菜单；键盘选择、选中标记、视口避让、销毁清理 |
| `src/picker.css` | 菜单外观和轻量动效 |
| `src/workbench-ui.css` | IDEA 风格工作区、深浅主题与手机布局 |
| `src/runtime.js` | HTML 拼装、预览握手、JavaScript 运行和服务器调用 |
| `public/ide-runtime.html` | 在隔离 iframe 中展示网页 / 启动执行环境 |
| `src/model.js` | 项目、草稿、修改提案、IndexedDB 保存 |
| `demo/main.js` | 用同一组件启动独立示例 |

## 类似 Codex 的预览如何实现

从可观察行为看，Codex 能在面板中打开网页、文件与终端。这里给出的是同类实现思路，不推断它的私有组件结构：

1. 前端工程由 Vite 等开发服务器提供 `http://127.0.0.1:端口` 页面；桌面应用可通过内嵌浏览器面板打开该地址。Vite 的热更新让保存后的代码及时反映到页面。
2. OpenStarry 目前的「网页预览」是项目内 HTML 预览：读取 HTML，把同项目 JS/CSS 内联，再送入 `sandbox="allow-scripts"` 的 iframe。
3. iframe 发出带随机 ID 的就绪消息；父页面核对消息来源及 ID 后发送内容。预览允许执行项目脚本，但与应用自己的存储和页面隔离。
4. CodeMirror 提供代码编辑，CSS Grid/Flex 提供工具窗口布局。Agent 提案通过差异编辑器显示，接受之后才写回项目。

当前预览入口在输出面板中；任意网站的完整内嵌浏览器、独立浏览器标签栏属于后续功能。不要给这个 HTML iframe 增加 `allow-same-origin` 来省略隔离。
