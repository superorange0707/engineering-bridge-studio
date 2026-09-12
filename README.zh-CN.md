# Engineering Bridge Studio

**ChatGPT Web 做研究和规划，Codex 写代码、跑实验，Bridge 把工作串起来。**

[English README](README.md) · [安装指南](docs/installation.md) · [研究工作流](docs/chatgpt-codex-workflow.md) · [上游与许可证](docs/upstreams.md)

## 安装

目前支持 macOS。先安装 Node.js 22+、Git 和 Codex CLI，并登录 Codex。

```sh
curl -fsSL https://raw.githubusercontent.com/superorange0707/engineering-bridge-studio/main/install.mjs | node --input-type=module -
```

安装器会下载发行包、校验 SHA-256，并装入 Codex。重启应用后，打开 **Plugins → Installed**，找到 **Engineering Bridge Studio**。项目选择和 ChatGPT Web 连接步骤见[安装指南](docs/installation.md)。

目前通过这个安装器和 [GitHub Releases](https://github.com/superorange0707/engineering-bridge-studio/releases) 分发，公共 Codex 目录收录需要单独提交审核。

## 如何配合

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
