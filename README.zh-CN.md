# Engineering Bridge Studio

**ChatGPT Web 做研究和规划，Codex 写代码、跑实验，Bridge 把工作串起来。**

[English README](README.md) · [安装指南](docs/installation.md) · [研究工作流](docs/chatgpt-codex-workflow.md) · [上游与许可证](docs/upstreams.md)

## 安装

目前支持 macOS。先安装 Node.js 22+、Git 和 Codex CLI，并登录 Codex。

通过 Codex 安装：

```sh
codex plugin marketplace add superorange0707/engineering-bridge-studio --ref marketplace
codex plugin add engineering-bridge@engineering-bridge-studio
```

安装后在新任务中打开插件，选择 **Open Engineering Bridge Studio**，即可在 Codex 的浏览器面板中进入工作台并完成项目 setup。

也可以使用会自动打开浏览器的安装脚本：

```sh
curl -fsSL https://raw.githubusercontent.com/superorange0707/engineering-bridge-studio/main/install.mjs | node --input-type=module -
```

安装器会装好插件并打开 **Studio 工作台**，按页面提示选择项目、完成 setup。在 Codex 中说 **“打开 Engineering Bridge Studio”**，工作台就会在当前任务的浏览器面板打开，也可以点击插件卡片上的启动提示。新安装的插件如果没有出现在列表里，重启一次 Codex。

目前通过这个安装器和 [GitHub Releases](https://github.com/superorange0707/engineering-bridge-studio/releases) 分发，公共 Codex 目录收录需要单独提交审核。

## 如何配合

工作台提供项目 setup、研究交接、实验编辑、运行状态、文件下载和结果审阅，支持英文和中文。首次打开进入 setup；已有安装继续使用原来的项目和实验记录。

在 **研究** 页面关联 ChatGPT 对话、准备项目 brief，在 **实验** 页面把具体计划交给原生 Codex，再查看结果。ChatGPT 在独立浏览器标签中打开。配置好 Bridge connector 后，Web 可以直接下发计划和读取结果；也可以使用页面上的复制操作手动交接。

Engineering Bridge Studio 把 ChatGPT Web 的规划能力和本地原生 Codex 的执行能力连接到同一个项目中。

- **你** 提供 idea、产品目标、研究问题，并做最终决定。
- **ChatGPT Web** 研究领域和文献，整理假设与实验，搭建大纲，写论文，并根据结果做复盘。
- **原生 Codex** 写代码、跑实验，产出文件、指标和日志。
- **Bridge** 保存项目、实验计划、结果和审阅记录，让不同对话可以接着做。

论文也可以按产品来迭代：先定义问题，再跑一轮规模适中的可复核实验，查看真实发生了什么，然后决定下一步要构建什么、验证什么、写什么。

## 工作循环

1. 从一个 idea 和明确的问题开始。
2. ChatGPT Web 整理计划，确定基线、数据、指标和实验步骤。
3. Codex 在本地执行，返回脚本、结果和日志。
4. ChatGPT Web 审阅结果，推进下一轮实验或论文段落。
5. 换一个对话，也能找到同一个项目，从上次审阅继续。

在 ChatGPT Web 或 Codex 中打开同一个项目，两个入口连接同一个 Bridge 服务，共享实验、文件和审阅记录。

## 开发

```bash
git clone https://github.com/superorange0707/engineering-bridge-studio.git
cd engineering-bridge-studio
npm ci
npm test
node bin/bridge.mjs --help
```

## 致谢

本发行版建立在 [Engineering Bridge](https://github.com/wudy29/engineering-bridge) 和 [codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web) companion 之上。固定版本和许可证说明见[上游说明](docs/upstreams.md)与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

开发说明和安全问题反馈请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [SECURITY.md](SECURITY.md)。
