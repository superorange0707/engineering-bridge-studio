(() => {
  "use strict";

  const TOKEN_KEY = "engineering-bridge-studio.token";
  const LANGUAGE_KEY = "engineering-bridge-studio.language";
  const PROJECT_KEY = "engineering-bridge-studio.project";
  const REQUEST_KEY = "engineering-bridge-studio.request";
  const ARTIFACT_PAGE_BYTES = 64 * 1024;
  const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
  const ACTIVE_STATES = new Set(["queued", "running", "interrupting"]);
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

  const I18N = {
    en: {
      "brand.studio": "STUDIO",
      "status.checking": "Checking connection…",
      "status.connected": "Workspace configured",
      "status.chooseProject": "Choose a project",
      "status.error": "Connection needs attention",
      "actions.refresh": "Refresh status",
      "actions.dismiss": "Dismiss",
      "workspace.kicker": "WORKSPACE",
      "workspace.label": "Project",
      "workspace.choose": "Choose a project",
      "workspace.none": "Choose a project to begin.",
      "workspace.execution": "Isolated execution enabled",
      "workspace.readOnly": "Read-only session",
      "nav.overview": "Overview",
      "nav.research": "Research handoff",
      "nav.experiments": "Experiments",
      "companion.title": "ChatGPT Web companion",
      "companion.checking": "Checking…",
      "companion.install": "Install",
      "companion.launch": "Open Launcher",
      "companion.reinstall": "Reinstall",
      "companion.installed": "Installed · {release}",
      "companion.notInstalled": "Not installed",
      "sidebar.setup": "Connection setup",
      "setup.eyebrow": "FIRST CONNECTION",
      "setup.title": "Choose where your Bridge work should live.",
      "setup.lede": "Start with a project, or pick up an existing workspace.",
      "setup.create": "Create a local stack",
      "setup.createCopy": "Use one explicit project as the starting workspace.",
      "setup.connect": "Connect an existing stack",
      "setup.connectCopy": "Reuse its configuration, runs and review history.",
      "setup.projectPath": "Absolute project path",
      "setup.projectPlaceholder": "/Users/you/Projects/my-project",
      "setup.projectHelp": "Choose the source project explicitly. The folder is not modified by setup.",
      "setup.experiments": "Enable isolated experiments",
      "setup.experimentsHelp": "Allow collaboration runs to write only inside their private scratch directories.",
      "setup.configPath": "Existing workspaces.json path",
      "setup.configPlaceholder": "/Users/you/.local/share/engineering-bridge/config/workspaces.json",
      "setup.configHelp": "Bridge will use this stack in place and keep its existing history.",
      "setup.continue": "Continue to project selection",
      "setup.saving": "Saving setup…",
      "overview.eyebrow": "ENGINEERING BRIDGE STUDIO",
      "overview.title": "A clear path from idea to evidence.",
      "overview.lede": "Plan and write with ChatGPT Web. Run the work with native Codex. Keep every round attached to the project.",
      "overview.activeProject": "ACTIVE PROJECT",
      "overview.newExperiment": "New experiment",
      "project.emptyTitle": "Choose a project to open the workbench.",
      "project.emptyCopy": "Select a project to see its experiments and continue the work.",
      "project.choose": "Choose project",
      "stats.rounds": "RESEARCH ROUNDS",
      "stats.execution": "EXECUTION",
      "stats.web": "WEB CONNECTION",
      "stats.executionReady": "Ready for an explicit run",
      "stats.executionOff": "Enable isolated experiments in setup",
      "stats.webNote": "ChatGPT Web",
      "status.notVerified": "Not verified",
      "handoff.kicker": "RESEARCH HANDOFF",
      "handoff.title": "Keep Web thinking tied to this workspace.",
      "handoff.copy": "Save a ChatGPT conversation for this project, then copy a ready brief with the workspace ID and Bridge tool sequence.",
      "handoff.manage": "Manage handoff",
      "handoff.openChat": "Open ChatGPT",
      "handoff.copyBrief": "Copy research brief",
      "loop.kicker": "THE LOOP",
      "loop.title": "Think → run → review → write.",
      "loop.plan": "Plan a question",
      "loop.run": "Run a bounded round",
      "loop.review": "Review real artifacts",
      "recent.kicker": "PROJECT HISTORY",
      "recent.title": "Recent rounds",
      "recent.seeAll": "View all",
      "research.eyebrow": "RESEARCH HANDOFF",
      "research.title": "Give Web and Codex the same starting point.",
      "research.lede": "Keep the ChatGPT conversation link with the selected workspace, then carry a precise brief into the next turn.",
      "research.conversationKicker": "CONVERSATION LINK",
      "research.conversationTitle": "Selected ChatGPT conversation",
      "research.conversationCopy": "Use a real https://chatgpt.com/c/… page. Bridge opens it in a separate tab.",
      "research.urlLabel": "ChatGPT conversation URL",
      "research.urlPlaceholder": "https://chatgpt.com/c/...",
      "research.save": "Save for this workspace",
      "research.clear": "Clear saved link",
      "research.saved": "Saved conversation: {url}",
      "research.loading": "Loading saved conversation…",
      "research.briefKicker": "WEB → CODEX",
      "research.briefTitle": "Copy a precise handoff",
      "research.briefCopy": "The brief names this workspace and the tools Web should use, ready to paste into the next turn.",
      "research.workflowKicker": "A REPEATABLE ROUND",
      "research.workflowTitle": "Keep the research loop small enough to inspect.",
      "research.step1Title": "Web frames the question",
      "research.step1Copy": "Question, hypothesis, baseline, data split, seeds, metrics and protocol.",
      "research.step2Title": "Codex runs the round",
      "research.step2Copy": "Native execution stays bounded and returns scripts, metrics, logs and declared files.",
      "research.step3Title": "Web reviews the evidence",
      "research.step3Copy": "Read the real artifacts, record a review and decide what the next contract should test.",
      "research.setupKicker": "WEB SETUP",
      "research.setupTitle": "Keep the handoff in the same browser loop.",
      "research.setupStep1": "Open ChatGPT in a separate tab and start or select the conversation for this project.",
      "research.setupStep2": "Copy the conversation URL from the browser, paste it above and save it here.",
      "research.setupStep3": "Copy the brief into your Web turn. Use the returned run ID and artifact hashes when you write the next review.",
      "research.help": "OpenAI help",
      "research.codexHelp": "Codex documentation",
      "experiments.eyebrow": "EXPERIMENTS",
      "experiments.title": "Make the next round explicit.",
      "experiments.lede": "Describe the work, start it when ready, then inspect the exact run and artifacts returned by Codex.",
      "experiments.reset": "Clear form",
      "experiments.contractKicker": "RUN CONTRACT",
      "experiments.contractTitle": "What should Codex do?",
      "experiments.request": "REQUEST",
      "experiments.domain": "Domain",
      "experiments.research": "Research",
      "experiments.engineering": "Engineering",
      "experiments.parent": "Parent run ID {optional}",
      "experiments.objective": "Objective",
      "experiments.objectivePlaceholder": "What should this round establish?",
      "experiments.plan": "Plan {onePerLine}",
      "experiments.planPlaceholder": "Prepare the baseline\nRun the evaluation\nWrite metrics.json",
      "experiments.acceptance": "Acceptance criteria {onePerLine}",
      "experiments.acceptancePlaceholder": "Metrics file exists\nResults include all seeds",
      "experiments.researchKicker": "RESEARCH CONTEXT",
      "experiments.researchTitle": "Make the hypothesis testable.",
      "experiments.outputs": "Expected artifacts {onePerLine}",
      "experiments.outputsPlaceholder": "experiment.mjs\nmetrics.json\nrun.log",
      "experiments.inputs": "Input files {optionalOnePerLine}",
      "experiments.inputsPlaceholder": "data/fixture.json",
      "experiments.footnote": "Starting a round creates a durable run. Retrying the same unchanged form reuses its request ID.",
      "experiments.start": "Start experiment",
      "experiments.starting": "Starting…",
      "experiments.disabled": "Enable isolated experiments for this project during setup to start a collaboration run.",
      "experiments.readOnly": "This session is read-only. Choose a writable Bridge session to start or review a run.",
      "experiments.newRequest": "new ID on start",
      "experiments.editedRequest": "new ID for edited contract",
      "experiments.requestRetry": "retry ID {id}",
      "researchFields.question": "Question",
      "researchFields.hypothesis": "Hypothesis",
      "researchFields.baselines": "Baselines {onePerLine}",
      "researchFields.dataset": "Dataset",
      "researchFields.split": "Data split",
      "researchFields.seeds": "Seeds {onePerLine}",
      "researchFields.metrics": "Metrics {onePerLine}",
      "researchFields.protocol": "Protocol",
      "researchFields.sources": "Sources {optional}",
      "researchFields.citations": "Citations {optional}",
      "common.optional": "optional",
      "common.onePerLine": "one per line",
      "common.optionalOnePerLine": "optional, one relative path per line",
      "history.kicker": "PROJECT HISTORY",
      "history.title": "Rounds",
      "history.loadMore": "Load more",
      "run.emptyTitle": "Select a round",
      "run.emptyCopy": "Its contract, state, artifacts and review will appear here.",
      "run.contract": "Contract",
      "run.artifacts": "Declared artifacts",
      "run.evidence": "Execution evidence",
      "run.output": "Codex report",
      "run.partialOutput": "Partial output",
      "run.review": "Evidence review",
      "run.reviewPending": "Review this run",
      "run.reviewHelp": "Record what the artifacts support before using the result in the paper.",
      "run.decision": "Decision",
      "run.feedback": "Feedback",
      "run.feedbackPlaceholder": "What did the evidence establish, leave open or require next?",
      "run.saveReview": "Save review",
      "run.savingReview": "Saving review…",
      "run.cancel": "Cancel run",
      "run.cancelling": "Cancelling…",
      "run.copyResult": "Copy handoff result",
      "run.iterate": "Iterate this run",
      "run.download": "Download",
      "run.view": "View",
      "run.loadingArtifact": "Reading and verifying artifact…",
      "run.artifactVerified": "SHA-256 verified · {bytes}",
      "run.artifactUnverified": "Hash verification unavailable",
      "run.noArtifacts": "No declared artifacts were returned.",
      "run.noEvidence": "No execution evidence was recorded.",
      "run.ready": "ready",
      "run.pending": "pending",
      "run.created": "Created {date}",
      "run.completed": "Completed {date}",
      "run.reviewed": "Reviewed {date}",
      "run.parent": "Parent {id}",
      "run.metadata": "Executor metadata",
      "run.hash": "SHA-256",
      "run.bytes": "bytes",
      "run.reviewDecision": "Decision: {decision}",
      "run.reviewNone": "Awaiting Web review",
      "history.empty": "No rounds yet. Start an explicit experiment when a contract is ready.",
      "history.choose": "Choose a project to see its rounds.",
      "history.loading": "Loading project history…",
      "history.loadError": "History could not be loaded.",
      "errors.auth": "This connection needs authentication. Open the link with its session token and try again.",
      "errors.network": "Bridge is not reachable. Check that the local service is running, then refresh.",
      "errors.unknown": "Bridge could not complete that request.",
      "errors.chooseProject": "Choose a project before using this view.",
      "errors.invalidPath": "Use an absolute path.",
      "errors.invalidUrl": "Save a ChatGPT conversation URL beginning with https://chatgpt.com/c/.",
      "errors.copy": "Clipboard access was unavailable. Select and copy the text manually.",
      "errors.readOnly": "This Bridge session is read-only.",
      "toast.saved": "Saved for this workspace.",
      "toast.copied": "Copied to clipboard.",
      "toast.setup": "Setup saved. Choose a project to continue.",
      "toast.companion": "Launcher action sent.",
      "toast.started": "Run started. Codex is working in its bounded scratch directory.",
      "toast.reviewed": "Review saved.",
      "toast.cancelled": "Cancellation requested.",
      "brief.title": "Engineering Bridge research handoff",
      "brief.workspace": "Workspace ID: {id}",
      "brief.project": "Project: {name}",
      "brief.url": "ChatGPT conversation: {url}",
      "brief.tools": "Use these Bridge tools in order:",
      "brief.history": "1. collaboration_history — recover prior rounds for this workspace.",
      "brief.run": "2. collaboration_run — submit the next explicit engineering or research contract.",
      "brief.result": "3. collaboration_result — poll the durable run until execution returns.",
      "brief.artifact": "4. collaboration_artifact — read every artifact page to EOF and check its whole-file SHA-256.",
      "brief.review": "5. collaboration_review — record accept, revise or reject with evidence-based feedback.",
      "brief.research": "Research contracts include question, hypothesis, baselines, dataset, split, seeds, metrics and protocol.",
      "result.title": "Engineering Bridge run handoff",
      "result.run": "Run ID: {id}",
      "result.status": "Status: {status}",
      "result.artifacts": "Artifacts:",
      "result.review": "Review: {decision}",
      "result.none": "No declared artifacts.",
      "state.queued": "Queued",
      "state.running": "Running",
      "state.interrupting": "Cancelling",
      "state.awaiting_review": "Awaiting review",
      "state.accepted": "Accepted",
      "state.revision_requested": "Revision requested",
      "state.rejected": "Rejected",
      "state.failed": "Failed",
      "state.interrupted": "Interrupted",
      "decision.accept": "Accept",
      "decision.revise": "Request revision",
      "decision.reject": "Reject"
    },
    zh: {
      "brand.studio": "STUDIO",
      "status.checking": "正在检查连接…",
      "status.connected": "Workspace 已配置",
      "status.chooseProject": "请选择项目",
      "status.error": "连接需要处理",
      "actions.refresh": "刷新状态",
      "actions.dismiss": "关闭提示",
      "workspace.kicker": "工作区",
      "workspace.label": "项目",
      "workspace.choose": "选择项目",
      "workspace.none": "选择一个项目开始。",
      "workspace.execution": "已启用隔离执行",
      "workspace.readOnly": "只读会话",
      "nav.overview": "概览",
      "nav.research": "研究交接",
      "nav.experiments": "实验",
      "companion.title": "ChatGPT Web companion",
      "companion.checking": "正在检查…",
      "companion.install": "安装",
      "companion.launch": "打开 Launcher",
      "companion.reinstall": "重新安装",
      "companion.installed": "已安装 · {release}",
      "companion.notInstalled": "尚未安装",
      "sidebar.setup": "连接设置",
      "setup.eyebrow": "首次连接",
      "setup.title": "选择 Bridge 工作要放在哪里。",
      "setup.lede": "从一个项目开始，或接入已有 workspace。",
      "setup.create": "创建本地 stack",
      "setup.createCopy": "明确指定一个项目作为起始工作区。",
      "setup.connect": "连接已有 stack",
      "setup.connectCopy": "复用它的配置、run 和审阅历史。",
      "setup.projectPath": "项目绝对路径",
      "setup.projectPlaceholder": "/Users/you/Projects/my-project",
      "setup.projectHelp": "明确选择源项目。设置过程不会修改该目录。",
      "setup.experiments": "启用隔离实验",
      "setup.experimentsHelp": "允许 collaboration run 只在私有 scratch 目录中写入。",
      "setup.configPath": "已有 workspaces.json 路径",
      "setup.configPlaceholder": "/Users/you/.local/share/engineering-bridge/config/workspaces.json",
      "setup.configHelp": "Bridge 会原地使用这份 stack，并保留已有历史。",
      "setup.continue": "继续选择项目",
      "setup.saving": "正在保存设置…",
      "overview.eyebrow": "ENGINEERING BRIDGE STUDIO",
      "overview.title": "从 idea 到证据，有一条清晰路径。",
      "overview.lede": "用 ChatGPT Web 规划和写作，用原生 Codex 执行，把每一轮都连接回项目。",
      "overview.activeProject": "当前项目",
      "overview.newExperiment": "新建实验",
      "project.emptyTitle": "选择一个项目打开工作台。",
      "project.emptyCopy": "选择一个项目，查看它的实验并继续工作。",
      "project.choose": "选择项目",
      "stats.rounds": "研究轮次",
      "stats.execution": "执行",
      "stats.web": "Web 连接",
      "stats.executionReady": "可以启动明确的 run",
      "stats.executionOff": "请在设置中启用隔离实验",
      "stats.webNote": "ChatGPT Web",
      "status.notVerified": "未验证",
      "handoff.kicker": "研究交接",
      "handoff.title": "让 Web 的思考始终连着这个工作区。",
      "handoff.copy": "为项目保存一个 ChatGPT 对话，再复制包含 workspace ID 和 Bridge 工具顺序的交接简报。",
      "handoff.manage": "管理交接",
      "handoff.openChat": "打开 ChatGPT",
      "handoff.copyBrief": "复制研究简报",
      "loop.kicker": "工作循环",
      "loop.title": "思考 → 执行 → 审阅 → 写作。",
      "loop.plan": "规划问题",
      "loop.run": "执行一轮有边界的实验",
      "loop.review": "审阅真实产物",
      "recent.kicker": "项目历史",
      "recent.title": "最近轮次",
      "recent.seeAll": "查看全部",
      "research.eyebrow": "研究交接",
      "research.title": "让 Web 和 Codex 从同一个起点开始。",
      "research.lede": "把 ChatGPT 对话链接保存在当前 workspace，再把精确的简报带进下一轮对话。",
      "research.conversationKicker": "对话链接",
      "research.conversationTitle": "选中的 ChatGPT 对话",
      "research.conversationCopy": "使用真实的 https://chatgpt.com/c/… 页面。Bridge 会在独立标签页打开它。",
      "research.urlLabel": "ChatGPT 对话 URL",
      "research.urlPlaceholder": "https://chatgpt.com/c/...",
      "research.save": "保存到当前 workspace",
      "research.clear": "清除已保存链接",
      "research.saved": "已保存对话：{url}",
      "research.loading": "正在读取已保存对话…",
      "research.briefKicker": "WEB → CODEX",
      "research.briefTitle": "复制精确的交接简报",
      "research.briefCopy": "简报会写明 workspace 和 Web 应使用的工具，可直接粘贴到下一轮对话。",
      "research.workflowKicker": "可重复的一轮",
      "research.workflowTitle": "让研究循环小到可以认真检查。",
      "research.step1Title": "Web 定义问题",
      "research.step1Copy": "问题、假设、基线、数据划分、种子、指标和规程。",
      "research.step2Title": "Codex 执行实验",
      "research.step2Copy": "原生执行有明确边界，并返回脚本、指标、日志和声明的文件。",
      "research.step3Title": "Web 审阅证据",
      "research.step3Copy": "读取真实产物，保存审阅，再决定下一份 contract 要验证什么。",
      "research.setupKicker": "WEB 设置",
      "research.setupTitle": "让交接留在同一个浏览器循环里。",
      "research.setupStep1": "在独立标签页打开 ChatGPT，开始或选择这个项目对应的对话。",
      "research.setupStep2": "从浏览器复制对话 URL，粘贴到上方并保存。",
      "research.setupStep3": "把简报复制到 Web 对话中。写下一轮审阅时，使用返回的 run ID 和产物哈希。",
      "research.help": "OpenAI 帮助",
      "research.codexHelp": "Codex 文档",
      "experiments.eyebrow": "实验",
      "experiments.title": "把下一轮写清楚。",
      "experiments.lede": "描述工作，准备好后明确启动，然后检查 Codex 返回的真实 run 和产物。",
      "experiments.reset": "清空表单",
      "experiments.contractKicker": "RUN CONTRACT",
      "experiments.contractTitle": "希望 Codex 做什么？",
      "experiments.request": "REQUEST",
      "experiments.domain": "领域",
      "experiments.research": "研究",
      "experiments.engineering": "工程",
      "experiments.parent": "父 run ID {optional}",
      "experiments.objective": "目标",
      "experiments.objectivePlaceholder": "这一轮要建立什么？",
      "experiments.plan": "计划 {onePerLine}",
      "experiments.planPlaceholder": "准备基线\n运行评估\n写入 metrics.json",
      "experiments.acceptance": "验收条件 {onePerLine}",
      "experiments.acceptancePlaceholder": "指标文件存在\n结果包含所有种子",
      "experiments.researchKicker": "研究上下文",
      "experiments.researchTitle": "让假设可以被检验。",
      "experiments.outputs": "预期产物 {onePerLine}",
      "experiments.outputsPlaceholder": "experiment.mjs\nmetrics.json\nrun.log",
      "experiments.inputs": "输入文件 {optionalOnePerLine}",
      "experiments.inputsPlaceholder": "data/fixture.json",
      "experiments.footnote": "启动一轮会创建持久 run。没有改变表单时重试，会复用相同的 request ID。",
      "experiments.start": "启动实验",
      "experiments.starting": "正在启动…",
      "experiments.disabled": "请在设置中为当前项目启用隔离实验，才能启动 collaboration run。",
      "experiments.readOnly": "当前会话是只读的。请使用可写的 Bridge 会话来启动或审阅 run。",
      "experiments.newRequest": "启动时生成新 ID",
      "experiments.editedRequest": "编辑后会生成新 ID",
      "experiments.requestRetry": "重试 ID {id}",
      "researchFields.question": "问题",
      "researchFields.hypothesis": "假设",
      "researchFields.baselines": "基线 {onePerLine}",
      "researchFields.dataset": "数据集",
      "researchFields.split": "数据划分",
      "researchFields.seeds": "种子 {onePerLine}",
      "researchFields.metrics": "指标 {onePerLine}",
      "researchFields.protocol": "实验规程",
      "researchFields.sources": "来源 {optional}",
      "researchFields.citations": "引用 {optional}",
      "common.optional": "可选",
      "common.onePerLine": "每行一项",
      "common.optionalOnePerLine": "可选，每行一个相对路径",
      "history.kicker": "项目历史",
      "history.title": "轮次",
      "history.loadMore": "加载更多",
      "run.emptyTitle": "选择一轮",
      "run.emptyCopy": "这里会显示 contract、状态、产物和 review。",
      "run.contract": "Contract",
      "run.artifacts": "声明的产物",
      "run.evidence": "执行证据",
      "run.output": "Codex 报告",
      "run.partialOutput": "部分输出",
      "run.review": "证据审阅",
      "run.reviewPending": "审阅这一轮",
      "run.reviewHelp": "先记录产物支持什么，再把结果用于论文。",
      "run.decision": "决定",
      "run.feedback": "反馈",
      "run.feedbackPlaceholder": "证据建立了什么、留下了什么问题、下一步需要什么？",
      "run.saveReview": "保存审阅",
      "run.savingReview": "正在保存审阅…",
      "run.cancel": "取消 run",
      "run.cancelling": "正在取消…",
      "run.copyResult": "复制交接结果",
      "run.iterate": "基于此轮迭代",
      "run.download": "下载",
      "run.view": "查看",
      "run.loadingArtifact": "正在读取并校验产物…",
      "run.artifactVerified": "SHA-256 已校验 · {bytes}",
      "run.artifactUnverified": "无法完成哈希校验",
      "run.noArtifacts": "没有返回声明的产物。",
      "run.noEvidence": "没有记录执行证据。",
      "run.ready": "已就绪",
      "run.pending": "处理中",
      "run.created": "创建于 {date}",
      "run.completed": "完成于 {date}",
      "run.reviewed": "审阅于 {date}",
      "run.parent": "父 run {id}",
      "run.metadata": "执行器信息",
      "run.hash": "SHA-256",
      "run.bytes": "字节",
      "run.reviewDecision": "决定：{decision}",
      "run.reviewNone": "等待 Web 审阅",
      "history.empty": "还没有轮次。准备好 contract 后，明确启动一次实验。",
      "history.choose": "选择项目后查看它的轮次。",
      "history.loading": "正在加载项目历史…",
      "history.loadError": "项目历史加载失败。",
      "errors.auth": "当前连接需要认证。请使用带 session token 的链接打开，再重试。",
      "errors.network": "无法连接 Bridge。请检查本地服务是否运行，再刷新页面。",
      "errors.unknown": "Bridge 无法完成这次请求。",
      "errors.chooseProject": "请先选择项目。",
      "errors.invalidPath": "请输入绝对路径。",
      "errors.invalidUrl": "请输入以 https://chatgpt.com/c/ 开头的 ChatGPT 对话 URL。",
      "errors.copy": "无法访问剪贴板，请手动选择并复制文字。",
      "errors.readOnly": "当前 Bridge 会话是只读的。",
      "toast.saved": "已保存到当前 workspace。",
      "toast.copied": "已复制到剪贴板。",
      "toast.setup": "设置已保存，请选择项目继续。",
      "toast.companion": "Launcher 操作已发送。",
      "toast.started": "run 已启动，Codex 正在私有 scratch 目录中执行。",
      "toast.reviewed": "review 已保存。",
      "toast.cancelled": "已请求取消。",
      "brief.title": "Engineering Bridge 研究交接",
      "brief.workspace": "Workspace ID：{id}",
      "brief.project": "项目：{name}",
      "brief.url": "ChatGPT 对话：{url}",
      "brief.tools": "请按顺序使用这些 Bridge 工具：",
      "brief.history": "1. collaboration_history — 恢复这个 workspace 的历史轮次。",
      "brief.run": "2. collaboration_run — 提交下一份明确的工程或研究 contract。",
      "brief.result": "3. collaboration_result — 轮询持久 run，直到执行返回。",
      "brief.artifact": "4. collaboration_artifact — 读取每个产物页面直到 EOF，并校验完整文件 SHA-256。",
      "brief.review": "5. collaboration_review — 根据证据记录 accept、revise 或 reject。",
      "brief.research": "研究 contract 需要包含 question、hypothesis、baselines、dataset、split、seeds、metrics 和 protocol。",
      "result.title": "Engineering Bridge run 交接",
      "result.run": "Run ID：{id}",
      "result.status": "状态：{status}",
      "result.artifacts": "产物：",
      "result.review": "Review：{decision}",
      "result.none": "没有声明产物。",
      "state.queued": "排队中",
      "state.running": "执行中",
      "state.interrupting": "取消中",
      "state.awaiting_review": "等待审阅",
      "state.accepted": "已接受",
      "state.revision_requested": "请求修改",
      "state.rejected": "已拒绝",
      "state.failed": "失败",
      "state.interrupted": "已中断",
      "decision.accept": "接受",
      "decision.revise": "请求修改",
      "decision.reject": "拒绝"
    }
  };

  const state = {
    language: sessionStorage.getItem(LANGUAGE_KEY) === "zh" ? "zh" : "en",
    status: null,
    statusRequestToken: 0,
    selectedWorkspaceId: null,
    selectedProject: null,
    view: "overview",
    history: [],
    historyNext: null,
    historyTotal: 0,
    historyLoading: false,
    historyRequestToken: 0,
    selectedRunId: null,
    selectedRun: null,
    runLoading: false,
    runError: null,
    runRequestToken: 0,
    pollTimer: null,
    artifactPath: null,
    artifact: null,
    artifactLoading: false,
    artifactError: null,
    artifactObjectUrl: null,
    artifactRequestToken: 0,
   handoffUrl: "",
   handoffLoading: false,
    handoffRequestToken: 0,
   companionBusy: false,
    setupBusy: false,
    reviewBusy: false,
    startBusy: false,
    cancelBusy: false,
    formDirty: false,
    lastRequestFingerprint: null,
    requestId: null,
    toastTimer: null
  };

  class ApiError extends Error {
    constructor(message, status, payload) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.payload = payload;
    }
  }

  const $ = (id) => document.getElementById(id);

 function t(key, values = {}) {
   const dictionary = I18N[state.language] || I18N.en;
   let value = dictionary[key] ?? I18N.en[key] ?? key;
    return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name) => {
      const nested = dictionary[`common.${name}`] ?? I18N.en[`common.${name}`];
      return String(values[name] ?? nested ?? `{${name}}`);
    });
 }

  function make(tag, className, label) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (label !== undefined) node.textContent = String(label);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function readTokenFromHash() {
    if (!window.location.hash) return;
    const params = new URLSearchParams(window.location.hash.slice(1));
    const token = params.get("token");
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    window.history.replaceState(null, document.title, `${window.location.pathname}${window.location.search}`);
  }

  function token() {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("Accept", "application/json");
    let body = options.body;
    if (body !== undefined && typeof body !== "string") {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(body);
    }
    const auth = token();
    if (auth) headers.set("Authorization", `Bearer ${auth}`);
    let response;
    try {
      response = await fetch(path, { ...options, headers, body, credentials: "same-origin" });
    } catch (error) {
      throw new ApiError(t("errors.network"), 0, error);
    }
    const raw = await response.text();
    let payload = null;
    if (raw) {
      try { payload = JSON.parse(raw); } catch { payload = { message: raw.slice(0, 600) }; }
    }
    if (!response.ok) {
      const message = payload?.error?.message || payload?.message || payload?.error || `HTTP ${response.status}`;
      throw new ApiError(String(message), response.status, payload);
    }
    return payload;
  }

  function unwrap(value) {
    if (typeof value === "string") {
      try { return unwrap(JSON.parse(value)); } catch { return value; }
    }
    if (value && Array.isArray(value.content)) {
      const textBlock = value.content.find((item) => item && item.type === "text");
      if (textBlock?.text !== undefined) return unwrap(textBlock.text);
    }
    if (value && value.result && Object.keys(value).length === 1) return unwrap(value.result);
    return value;
  }

  async function callTool(name, argumentsValue) {
    const result = unwrap(await api("/api/tools", { method: "POST", body: { name, arguments: argumentsValue } }));
    if (result?.isError && !result.state) {
      throw new ApiError(result.error?.message || result.message || t("errors.unknown"), 400, result);
    }
    if (result?.error && !result.state && !(name === "collaboration_result" && result.run_id)) {
      const message = typeof result.error === "string" ? result.error : result.error.message;
      throw new ApiError(message || t("errors.unknown"), 400, result);
    }
    return result;
  }

  function formatError(error) {
    if (error instanceof ApiError) {
      if (error.status === 401) return t("errors.auth");
      if (error.status === 0) return t("errors.network");
      return error.message || t("errors.unknown");
    }
    return error instanceof Error ? error.message : t("errors.unknown");
  }

  function showPageError(error) {
    const box = $("page-error");
    $("page-error-text").textContent = formatError(error);
    box.hidden = false;
  }

  function hidePageError() {
    $("page-error").hidden = true;
    $("page-error-text").textContent = "";
  }

  function showFormError(id, message) {
    const node = $(id);
    node.textContent = message || "";
    node.hidden = !message;
  }

  function toast(message) {
    const node = $("toast");
    node.textContent = message;
    node.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { node.hidden = true; }, 3600);
  }

  function applyLanguage() {
    document.documentElement.lang = state.language === "zh" ? "zh-CN" : "en";
    document.body.dataset.language = state.language;
    document.querySelectorAll("[data-i18n]").forEach((node) => {
      node.textContent = t(node.dataset.i18n);
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
      node.setAttribute("placeholder", t(node.dataset.i18nPlaceholder));
    });
    document.querySelectorAll("[data-i18n-aria]").forEach((node) => {
      node.setAttribute("aria-label", t(node.dataset.i18nAria));
      node.setAttribute("title", t(node.dataset.i18nAria));
    });
    $("language-toggle").textContent = state.language === "zh" ? "English" : "中文";
    renderSetupMode();
    renderStatus();
    renderWorkbench();
    renderRequestPreview();
  }

  function setConnectionState(kind, label) {
    const root = $("connection-state");
    root.dataset.state = kind;
    $("connection-label").textContent = label;
    $("connection-dot").className = `status-dot status-${kind}`;
  }

  function normalizeStatus(value) {
    return {
      version: typeof value?.version === "string" ? value.version : "—",
      setup_required: Boolean(value?.setup_required),
      read_only: Boolean(value?.read_only || value?.readonly),
      config_path: typeof value?.config_path === "string" ? value.config_path : "",
      projects: Array.isArray(value?.projects) ? value.projects.filter((project) => project && typeof project.workspace_id === "string") : [],
      companion: value?.companion && typeof value.companion === "object" ? value.companion : { installed: false },
      web_connection: typeof value?.web_connection === "string" ? value.web_connection : "not_verified"
    };
  }

  function readOnly() {
    return Boolean(state.status?.read_only);
  }

  function runIsCurrent(runId, requestToken) {
    return runId === state.selectedRunId && requestToken === state.runRequestToken;
  }

  async function refreshStatus() {
    const requestToken = ++state.statusRequestToken;
    setConnectionState("checking", t("status.checking"));
    try {
      const previousId = state.selectedWorkspaceId;
      const previousConfigPath = state.status?.config_path;
      const nextStatus = normalizeStatus(await api("/api/status"));
      if (requestToken !== state.statusRequestToken) return;
      const configurationChanged = state.status !== null && previousConfigPath !== nextStatus.config_path;
      state.status = nextStatus;
      hidePageError();
      if (configurationChanged) clearSelectedWorkspaceState();
      renderStatus();
      if (state.status.setup_required) {
        clearSelectedWorkspaceState();
        showView("setup");
        renderWorkbench();
        return;
      }
      const savedId = sessionStorage.getItem(PROJECT_KEY);
      if (!state.selectedWorkspaceId && savedId && state.status.projects.some((project) => project.workspace_id === savedId)) {
        state.selectedWorkspaceId = savedId;
      }
      if (state.selectedWorkspaceId && !state.status.projects.some((project) => project.workspace_id === state.selectedWorkspaceId)) {
        clearSelectedWorkspaceState();
      }
      renderStatus();
      if (state.selectedWorkspaceId && state.selectedWorkspaceId !== previousId) {
        await chooseProject(state.selectedWorkspaceId, false);
      } else {
        state.selectedProject = state.status.projects.find((project) => project.workspace_id === state.selectedWorkspaceId) || null;
        renderWorkbench();
      }
      if (state.view === "setup") showView("overview");
    } catch (error) {
      if (requestToken !== state.statusRequestToken) return;
      state.status = null;
      clearSelectedWorkspaceState();
      setConnectionState("error", t("status.error"));
      showPageError(error);
      renderStatus();
      renderWorkbench();
    }
  }

  function renderStatus() {
    if (state.status) {
      setConnectionState(state.status.setup_required ? "setup" : "online", state.status.setup_required ? t("status.chooseProject") : t("status.connected"));
    }
    const select = $("project-select");
    clear(select);
    const placeholder = make("option", null, t("workspace.choose"));
    placeholder.value = "";
    placeholder.disabled = true;
    placeholder.selected = !state.selectedWorkspaceId;
    select.appendChild(placeholder);
    for (const project of state.status?.projects || []) {
      const option = make("option", null, project.display_name || project.workspace_id);
      option.value = project.workspace_id;
      option.selected = project.workspace_id === state.selectedWorkspaceId;
      select.appendChild(option);
    }
    select.disabled = !state.status || state.status.setup_required || !(state.status.projects || []).length;
    renderCompanion();
  }

  function projectById(id) {
    return state.status?.projects?.find((project) => project.workspace_id === id) || null;
  }

  function clearSelectedWorkspaceState() {
    clearPoll();
    state.historyRequestToken += 1;
    state.runRequestToken += 1;
    state.artifactRequestToken += 1;
    state.handoffRequestToken += 1;
    if (state.artifactObjectUrl) URL.revokeObjectURL(state.artifactObjectUrl);
    state.artifactObjectUrl = null;
    state.selectedWorkspaceId = null;
    state.selectedProject = null;
    state.history = [];
    state.historyNext = null;
    state.historyTotal = 0;
    state.historyLoading = false;
    state.selectedRunId = null;
    state.selectedRun = null;
    state.runLoading = false;
    state.runError = null;
    state.artifactPath = null;
    state.artifact = null;
    state.artifactLoading = false;
    state.artifactError = null;
    state.handoffUrl = "";
    state.handoffLoading = false;
    state.reviewBusy = false;
    state.cancelBusy = false;
    state.requestId = null;
    state.lastRequestFingerprint = null;
    sessionStorage.removeItem(PROJECT_KEY);
  }

 async function chooseProject(id, persist = true) {
    if (!id || !projectById(id)) {
      showPageError(new Error(t("errors.chooseProject")));
      return;
    }
    clearPoll();
    state.historyRequestToken += 1;
    state.runRequestToken += 1;
    state.artifactRequestToken += 1;
    state.selectedWorkspaceId = id;
    state.selectedProject = projectById(id);
    if (persist) sessionStorage.setItem(PROJECT_KEY, id);
    state.history = [];
    state.historyNext = null;
    state.historyTotal = 0;
    state.selectedRunId = null;
    state.selectedRun = null;
    state.runLoading = false;
    state.runError = null;
    state.reviewBusy = false;
    state.cancelBusy = false;
    state.artifactPath = null;
    state.artifact = null;
    state.artifactLoading = false;
    state.artifactError = null;
    state.handoffUrl = "";
    state.handoffLoading = false;
    renderStatus();
    renderWorkbench();
    await Promise.all([loadHistory(true), loadHandoff(id)]);
  }

  function showView(view) {
    state.view = view;
    for (const node of document.querySelectorAll(".view")) node.hidden = node.id !== `${view}-view`;
    for (const node of document.querySelectorAll(".nav-item")) {
      const active = node.dataset.view === view;
      node.classList.toggle("is-active", active);
      if (active) node.setAttribute("aria-current", "page");
      else node.removeAttribute("aria-current");
    }
    if (view === "research") renderHandoff();
    if (view === "experiments") renderExperimentAvailability();
  }

  function renderSetupMode() {
    const mode = document.querySelector("input[name='setup-mode']:checked")?.value || "create";
    state.setupMode = mode;
    $("setup-create-fields").hidden = mode !== "create";
    $("setup-connect-fields").hidden = mode !== "connect";
    $("mode-create-card").classList.toggle("is-selected", mode === "create");
    $("mode-connect-card").classList.toggle("is-selected", mode === "connect");
    if (!state.setupBusy) $("setup-submit").disabled = readOnly();
  }

  function renderCompanion() {
    const companion = state.status?.companion || {};
    const installed = Boolean(companion.installed);
    $("companion-status").textContent = state.status
      ? installed ? t("companion.installed", { release: companion.release_tag || "ready" }) : t("companion.notInstalled")
      : t("companion.checking");
    $("companion-install").textContent = installed ? t("companion.reinstall") : t("companion.install");
    $("companion-install").disabled = state.companionBusy || !state.status || readOnly();
    $("companion-launch").disabled = state.companionBusy || !state.status || readOnly();
    $("companion-card").dataset.installed = installed ? "true" : "false";
  }

  function renderWorkbench() {
    const project = state.selectedProject;
    const hasProject = Boolean(project);
    $("project-path").textContent = project?.current_path || t("workspace.none");
    $("project-banner").hidden = !hasProject;
    $("overview-empty").hidden = hasProject;
    $("overview-stats").hidden = !hasProject;
    $("overview-content").hidden = !hasProject;
    $("overview-recent").hidden = !hasProject;
    if (project) {
      const name = project.display_name || project.workspace_id;
      $("project-name").textContent = name;
      $("project-banner-path").textContent = project.current_path || "—";
      $("project-avatar").textContent = name.slice(0, 2).toUpperCase();
      const enabled = Boolean(project.execution_enabled) && !readOnly();
      $("project-execution-status").textContent = readOnly() ? t("workspace.readOnly") : enabled ? t("workspace.execution") : t("workspace.readOnly");
      $("project-execution-status").className = `project-banner-status ${enabled ? "is-enabled" : "is-readonly"}`;
      $("stat-rounds").textContent = String(state.historyTotal);
      $("stat-rounds-note").textContent = state.historyTotal ? t("recent.title") : t("history.empty");
      $("stat-execution").textContent = enabled ? t("workspace.execution") : t("workspace.readOnly");
      $("stat-execution-note").textContent = enabled ? t("stats.executionReady") : readOnly() ? t("experiments.readOnly") : t("stats.executionOff");
      const webConnected = state.status?.web_connection && state.status.web_connection !== "not_verified";
      $("stat-web").textContent = webConnected ? state.status.web_connection : t("status.notVerified");
      $("stat-web-note").textContent = t("stats.webNote");
    } else {
      $("stat-rounds").textContent = "—";
      $("stat-rounds-note").textContent = "—";
      $("stat-execution").textContent = "—";
      $("stat-execution-note").textContent = "—";
      $("stat-web").textContent = "—";
      $("stat-web-note").textContent = "—";
    }
    renderHandoff();
    renderHistory();
    renderRunDetail();
    renderExperimentAvailability();
  }


  function savedHandoffUrl() {
    return state.handoffUrl || "";
  }

  function validChatgptUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && (url.hostname === "chatgpt.com" || url.hostname === "www.chatgpt.com") && url.pathname.startsWith("/c/") && url.pathname.length > 3;
    } catch { return false; }
  }

  function renderHandoff() {
    const url = savedHandoffUrl();
    const input = $("chatgpt-url");
    if (input && document.activeElement !== input) input.value = url;
    for (const id of ["research-open-chat", "handoff-open-chat"]) {
      const link = $(id);
      if (!link) continue;
      link.href = url || "https://chatgpt.com/";
      link.classList.toggle("is-muted", !url);
    }
   const note = $("saved-url-note");
   if (note) {
      note.hidden = !url && !state.handoffLoading;
      note.textContent = state.handoffLoading ? t("research.loading") : url ? t("research.saved", { url }) : "";
   }
    $("save-chatgpt-url").disabled = state.handoffLoading || !state.selectedWorkspaceId || readOnly();
    $("clear-chatgpt-url").disabled = state.handoffLoading || !state.selectedWorkspaceId || !url || readOnly();
    const preview = $("brief-preview");
    if (preview) {
      clear(preview);
      const pre = make("pre", "brief-text", buildResearchBrief());
      preview.appendChild(pre);
   }
 }

  async function loadHandoff(workspaceId) {
    if (!workspaceId) {
      state.handoffUrl = "";
      state.handoffLoading = false;
      renderHandoff();
      return;
    }
    const requestToken = ++state.handoffRequestToken;
    state.handoffLoading = true;
    renderHandoff();
    try {
      const value = unwrap(await api("/api/research", {
        method: "POST",
        body: { action: "get", workspace_id: workspaceId }
      }));
      if (requestToken !== state.handoffRequestToken || workspaceId !== state.selectedWorkspaceId) return;
      const url = typeof value?.conversation_url === "string" ? value.conversation_url : "";
      state.handoffUrl = validChatgptUrl(url) ? url : "";
    } catch (error) {
      if (requestToken === state.handoffRequestToken && workspaceId === state.selectedWorkspaceId) showFormError("handoff-error", formatError(error));
    } finally {
      if (requestToken === state.handoffRequestToken && workspaceId === state.selectedWorkspaceId) {
        state.handoffLoading = false;
        renderHandoff();
      }
    }
  }

  function buildResearchBrief() {
    const project = state.selectedProject;
    if (!project) return t("errors.chooseProject");
    const url = savedHandoffUrl();
    return [
      t("brief.title"),
      t("brief.workspace", { id: project.workspace_id }),
      t("brief.project", { name: project.display_name || project.workspace_id }),
      ...(url ? [t("brief.url", { url })] : []),
      "",
      t("brief.tools"),
      t("brief.history"),
      t("brief.run"),
      t("brief.result"),
      t("brief.artifact"),
      t("brief.review"),
      "",
      t("brief.research")
    ].join("\n");
  }

  function buildRunHandoff(run) {
    const artifacts = Array.isArray(run.artifacts) ? run.artifacts : [];
    return [
      t("result.title"),
      t("result.run", { id: run.run_id }),
      t("result.status", { status: stateLabel(run.state) }),
      t("result.artifacts"),
      ...(artifacts.length ? artifacts.map((artifact) => `- ${artifact.path} · ${artifact.bytes} bytes · SHA-256 ${artifact.sha256}`) : [`- ${t("result.none")}`]),
      ...(run.review ? [t("result.review", { decision: decisionLabel(run.review.decision) })] : [])
    ].join("\n");
  }

  function stateLabel(value) {
    return t(`state.${value}`, {}, value || "—");
  }

  function decisionLabel(value) {
    return t(`decision.${value}`, {}, value || "—");
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes)) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat(state.language === "zh" ? "zh-CN" : "en-GB", { dateStyle: "medium", timeStyle: "short" }).format(date);
  }

  async function loadHistory(reset = false) {
    if (!state.selectedWorkspaceId) {
      renderHistory();
      return;
    }
    if (!reset && state.historyNext === null) return;
    if (state.historyLoading && !reset) return;
    const workspaceId = state.selectedWorkspaceId;
    const requestToken = ++state.historyRequestToken;
    if (state.historyLoading) state.historyLoading = false;
    const offset = reset ? 0 : state.historyNext;
    state.historyLoading = true;
    if (reset) {
      state.history = [];
      state.historyTotal = 0;
    }
    renderHistory();
    try {
      const page = await callTool("collaboration_history", {
        workspace_id: workspaceId,
        offset,
        limit: 20
      });
      if (requestToken !== state.historyRequestToken || workspaceId !== state.selectedWorkspaceId) return;
      const runs = Array.isArray(page?.runs) ? page.runs : [];
      state.history = reset ? runs : state.history.concat(runs);
      state.historyNext = page?.next_offset === null || page?.next_offset === undefined ? null : page.next_offset;
      state.historyTotal = Number.isSafeInteger(page?.total) ? page.total : state.history.length;
      hidePageError();
    } catch (error) {
      if (requestToken !== state.historyRequestToken || workspaceId !== state.selectedWorkspaceId) return;
      showPageError(error);
      if (reset) state.history = [];
    } finally {
      if (requestToken === state.historyRequestToken && workspaceId === state.selectedWorkspaceId) {
        state.historyLoading = false;
        renderWorkbench();
      }
    }
  }

  function appendEmpty(parent, message, className = "empty-row") {
    parent.appendChild(make("div", className, message));
  }

  function renderHistoryList(parent, runs, compact = false) {
    clear(parent);
    if (state.historyLoading && !runs.length) {
      appendEmpty(parent, t("history.loading"));
      return;
    }
    if (!state.selectedWorkspaceId) {
      appendEmpty(parent, t("history.choose"));
      return;
    }
    if (!runs.length) {
      appendEmpty(parent, t("history.empty"));
      return;
    }
    for (const run of runs) {
      const button = make("button", `history-row${compact ? " compact" : ""}`);
      button.type = "button";
      button.dataset.runId = run.run_id || "";
      button.classList.toggle("is-selected", run.run_id === state.selectedRunId);
      const copy = make("span", "history-row-copy");
      copy.appendChild(make("strong", "history-row-title", run.objective || run.run_id || "—"));
      const meta = make("span", "history-row-meta");
      meta.appendChild(make("span", "state-badge state-badge-small", stateLabel(run.state)));
      meta.appendChild(make("span", null, formatDate(run.created_at)));
      if (run.review?.decision) meta.appendChild(make("span", "review-mini", decisionLabel(run.review.decision)));
      copy.appendChild(meta);
      button.appendChild(copy);
      button.appendChild(make("span", "history-arrow", "→"));
      button.addEventListener("click", () => selectRun(run.run_id));
      parent.appendChild(button);
    }
  }

  function renderHistory() {
    renderHistoryList($("history-list"), state.history);
    renderHistoryList($("overview-history-list"), state.history.slice(0, 5), true);
    $("history-load-more").hidden = !state.historyNext || state.historyLoading;
    $("history-load-more").disabled = state.historyLoading;
  }

  function clearPoll() {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

  function schedulePoll() {
    clearPoll();
    if (!state.selectedRun || !ACTIVE_STATES.has(state.selectedRun.state)) return;
    state.pollTimer = setTimeout(() => { void pollRun(); }, 2500);
  }

  async function pollRun() {
    if (!state.selectedRunId || !state.selectedRun || !ACTIVE_STATES.has(state.selectedRun.state)) return;
    const runId = state.selectedRunId;
    const requestToken = state.runRequestToken;
    try {
      const run = await callTool("collaboration_result", { run_id: runId });
      if (!runIsCurrent(runId, requestToken)) return;
      state.selectedRun = run;
      renderRunDetail();
      renderHistory();
      schedulePoll();
    } catch (error) {
      if (!runIsCurrent(runId, requestToken)) return;
      state.runError = formatError(error);
      renderRunDetail();
      schedulePoll();
    }
  }

  async function selectRun(runId) {
    if (!runId) return;
    clearPoll();
    const requestToken = ++state.runRequestToken;
    state.artifactRequestToken += 1;
    state.selectedRunId = runId;
    state.selectedRun = null;
    state.runLoading = true;
    state.runError = null;
    state.reviewBusy = false;
    state.cancelBusy = false;
    state.artifactPath = null;
    state.artifact = null;
    state.artifactError = null;
    showView("experiments");
    renderHistory();
    renderRunDetail();
    try {
      const run = await callTool("collaboration_result", { run_id: runId });
      if (!runIsCurrent(runId, requestToken)) return;
      state.selectedRun = run;
      hidePageError();
      schedulePoll();
    } catch (error) {
      if (!runIsCurrent(runId, requestToken)) return;
      state.runError = formatError(error);
    } finally {
      if (runIsCurrent(runId, requestToken)) {
        state.runLoading = false;
        renderRunDetail();
      }
    }
  }

  function runHeader(run) {
    const header = make("div", "run-detail-header");
    const heading = make("div");
    const kicker = make("div", "card-kicker", "RUN");
    const title = make("h2", "run-detail-title", run.contract?.objective || run.run_id);
    heading.append(kicker, title);
    const badge = make("span", `state-badge state-${run.state}`, stateLabel(run.state));
    header.append(heading, badge);
    return header;
  }

  function actionButton(label, className, handler, disabled = false) {
    const button = make("button", className, label);
    button.type = "button";
    button.disabled = disabled;
    button.addEventListener("click", handler);
    return button;
  }

  function renderRunDetail() {
    const host = $("run-detail");
    clear(host);
    if (state.runLoading) {
      host.appendChild(make("div", "run-empty", t("history.loading")));
      return;
    }
    if (state.runError) {
      const error = make("div", "run-empty");
      error.append(make("div", "empty-icon", "!"), make("h2", null, t("history.loadError")), make("p", null, state.runError));
      host.appendChild(error);
      return;
    }
    const run = state.selectedRun;
    if (!run) {
      const empty = make("div", "run-empty");
      empty.append(make("div", "empty-icon", "⌁"), make("h2", null, t("run.emptyTitle")), make("p", null, t("run.emptyCopy")));
      host.appendChild(empty);
      return;
    }
    host.appendChild(runHeader(run));
    const actions = make("div", "run-actions");
    if (ACTIVE_STATES.has(run.state)) actions.appendChild(actionButton(state.cancelBusy ? t("run.cancelling") : t("run.cancel"), "secondary-button", () => { void cancelRun(); }, state.cancelBusy || readOnly()));
    actions.appendChild(actionButton(t("run.copyResult"), "text-button", () => { void copyText(buildRunHandoff(run)); }));
    if (run.contract) actions.appendChild(actionButton(t("run.iterate"), "text-button", () => iterateRun(run)));
    host.appendChild(actions);

    const statusLine = make("div", "run-meta-line");
    statusLine.appendChild(make("span", null, run.ready ? t("run.ready") : t("run.pending")));
    statusLine.appendChild(make("span", null, t("run.created", { date: formatDate(run.created_at) })));
    if (run.completed_at) statusLine.appendChild(make("span", null, t("run.completed", { date: formatDate(run.completed_at) })));
    if (run.parent_run_id) statusLine.appendChild(make("span", null, t("run.parent", { id: run.parent_run_id })));
    host.appendChild(statusLine);

    if (run.error) {
      const errorBox = make("div", "run-error");
      errorBox.appendChild(make("strong", null, run.error.code || "ERROR"));
      errorBox.appendChild(make("span", null, run.error.message || t("errors.unknown")));
      host.appendChild(errorBox);
    }

    if (run.metadata) {
      const metadata = make("div", "run-metadata");
      metadata.appendChild(make("div", "card-kicker", t("run.metadata")));
      const metaGrid = make("div", "metadata-grid");
      for (const [key, value] of Object.entries(run.metadata)) {
        const item = make("div", "metadata-item");
        item.append(make("span", "metadata-key", key), make("span", "metadata-value", value));
        metaGrid.appendChild(item);
      }
      metadata.appendChild(metaGrid);
      host.appendChild(metadata);
    }

    if (run.contract) {
      const details = document.createElement("details");
      details.className = "contract-details";
      const summary = make("summary", null, t("run.contract"));
      const pre = make("pre", "contract-json", JSON.stringify(run.contract, null, 2));
      details.append(summary, pre);
      host.appendChild(details);
    }

    const artifactSection = make("section", "run-section");
    artifactSection.appendChild(make("h3", null, t("run.artifacts")));
    const artifacts = Array.isArray(run.artifacts) ? run.artifacts : [];
    if (!artifacts.length) appendEmpty(artifactSection, t("run.noArtifacts"), "subtle-empty");
    else {
      const artifactList = make("div", "artifact-list");
      for (const artifact of artifacts) {
        const row = make("div", `artifact-row${artifact.path === state.artifactPath ? " is-selected" : ""}`);
        const info = make("div", "artifact-info");
        info.append(make("strong", "artifact-path", artifact.path), make("span", "artifact-size", `${formatBytes(artifact.bytes)} · ${String(artifact.sha256 || "").slice(0, 12)}…`));
        row.appendChild(info);
        row.appendChild(actionButton(t("run.view"), "small-button", () => { void loadArtifact(artifact); }));
        artifactList.appendChild(row);
      }
      artifactSection.appendChild(artifactList);
    }
    host.appendChild(artifactSection);

    if (state.artifactPath) host.appendChild(renderArtifactViewer());

    if (run.output || run.partial_output) {
      const outputSection = make("section", "run-section");
      outputSection.appendChild(make("h3", null, run.output ? t("run.output") : t("run.partialOutput")));
      outputSection.appendChild(make("pre", "run-output", run.output || run.partial_output));
      host.appendChild(outputSection);
    }

    const evidenceSection = make("section", "run-section");
    evidenceSection.appendChild(make("h3", null, t("run.evidence")));
    const evidence = Array.isArray(run.evidence) ? run.evidence : [];
    if (!evidence.length) appendEmpty(evidenceSection, t("run.noEvidence"), "subtle-empty");
    else {
      const list = make("ul", "evidence-list");
      for (const item of evidence.slice(0, 12)) {
        const kind = item?.type || item?.kind || "evidence";
        const detail = item?.command || item?.path || item?.text || item?.status || "recorded";
        list.appendChild(make("li", null, `${kind} · ${detail}`));
      }
      evidenceSection.appendChild(list);
    }
    host.appendChild(evidenceSection);

    const reviewSection = make("section", "run-section review-section");
    reviewSection.appendChild(make("h3", null, t("run.review")));
    if (run.review) {
      reviewSection.appendChild(make("div", "review-decision", t("run.reviewDecision", { decision: decisionLabel(run.review.decision) })));
      reviewSection.appendChild(make("p", "review-feedback", run.review.feedback));
      reviewSection.appendChild(make("div", "review-date", t("run.reviewed", { date: formatDate(run.review.reviewed_at) })));
    } else if (run.state === "awaiting_review") {
      reviewSection.appendChild(make("p", "review-help", t("run.reviewHelp")));
      const form = document.createElement("form");
      form.className = "review-form";
      const decisionLabelNode = make("label", "form-field");
      decisionLabelNode.appendChild(make("span", null, t("run.decision")));
      const select = document.createElement("select");
      select.id = "review-decision";
      for (const decision of ["accept", "revise", "reject"]) {
        const option = make("option", null, decisionLabel(decision));
        option.value = decision;
        select.appendChild(option);
      }
      decisionLabelNode.appendChild(select);
      const feedbackLabel = make("label", "form-field");
      feedbackLabel.htmlFor = "review-feedback";
      feedbackLabel.appendChild(make("span", null, t("run.feedback")));
      const textarea = document.createElement("textarea");
      textarea.id = "review-feedback";
      textarea.rows = 4;
      textarea.required = true;
      textarea.placeholder = t("run.feedbackPlaceholder");
      feedbackLabel.appendChild(textarea);
      const errorNode = make("div", "form-error");
      errorNode.id = "inline-review-error";
      errorNode.hidden = true;
      const submit = make("button", "primary-button", state.reviewBusy ? t("run.savingReview") : t("run.saveReview"));
      submit.type = "submit";
      submit.disabled = state.reviewBusy;
      form.append(decisionLabelNode, feedbackLabel, errorNode, submit);
      if (readOnly()) {
        const readonlyNote = make("p", "form-warning", t("errors.readOnly"));
        reviewSection.appendChild(readonlyNote);
        submit.disabled = true;
      }
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        void submitReview(select.value, textarea.value, errorNode);
      });
      reviewSection.appendChild(form);
    } else {
      reviewSection.appendChild(make("div", "review-pending", t("run.reviewNone")));
    }
    host.appendChild(reviewSection);
  }

  function renderArtifactViewer() {
    const section = make("section", "artifact-viewer run-section");
    const heading = make("div", "card-heading-row");
    heading.appendChild(make("h3", null, state.artifactPath));
    if (state.artifact?.downloadUrl) {
      const link = make("a", "small-button link-button", t("run.download"));
      link.href = state.artifact.downloadUrl;
      link.download = state.artifactPath.split("/").pop() || "artifact";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      heading.appendChild(link);
    }
    section.appendChild(heading);
    if (state.artifactLoading) section.appendChild(make("div", "artifact-loading", t("run.loadingArtifact")));
    else if (state.artifactError) section.appendChild(make("div", "run-error", state.artifactError));
    else if (state.artifact) {
      section.appendChild(make("div", "artifact-verified", t("run.artifactVerified", { bytes: formatBytes(state.artifact.size) })));
      if (state.artifact.isText) section.appendChild(make("pre", "artifact-content", state.artifact.text));
      else section.appendChild(make("pre", "artifact-content binary-content", state.artifact.bytesBase64));
      const hash = make("div", "artifact-hash");
      hash.append(make("span", null, t("run.hash")), make("code", null, state.artifact.sha256));
      section.appendChild(hash);
    }
    return section;
  }

  function base64ToBytes(value) {
    const binary = window.atob(value || "");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const blockSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += blockSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + blockSize, bytes.length)));
    }
    return window.btoa(binary);
  }

  function concatBytes(chunks, size) {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }

  async function sha256Hex(bytes) {
    if (!window.crypto?.subtle) throw new Error("SHA-256 verification needs a secure browser context.");
    const digest = await window.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function textArtifact(path, mediaType) {
    const pathLower = String(path || "").toLowerCase();
    const mediaLower = String(mediaType || "").toLowerCase();
    return Boolean(mediaLower.startsWith("text/") || /\.(?:txt|md|json|jsonl|csv|tsv|log|mjs|js|cjs|ts|py|sh|yaml|yml|toml|xml|html|css|svg)$/u.test(pathLower));
  }

  async function readArtifactPages(runId, artifact, requestToken) {
    const chunks = [];
    let offset = 0;
    let expectedSize = null;
    let expectedHash = null;
    while (true) {
      if (requestToken !== state.artifactRequestToken || runId !== state.selectedRunId) return null;
      const page = await callTool("collaboration_artifact", {
        run_id: runId,
        path: artifact.path,
        offset_bytes: offset,
        max_bytes: ARTIFACT_PAGE_BYTES
      });
      if (requestToken !== state.artifactRequestToken || runId !== state.selectedRunId) return null;
      const size = Number(page?.bytes);
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ARTIFACT_BYTES) throw new Error("Artifact size is outside the browser limit.");
      if (expectedSize === null) expectedSize = size;
      if (expectedHash === null) expectedHash = String(page?.sha256 || "").toLowerCase();
      if (expectedSize !== size || expectedHash !== String(page?.sha256 || "").toLowerCase() || page?.offset_bytes !== offset) throw new Error("Artifact pages do not describe one stable file.");
      const chunk = page.content_base64 !== undefined ? base64ToBytes(page.content_base64) : new TextEncoder().encode(page.content || "");
      if (chunk.length !== Number(page?.chunk_bytes)) throw new Error("Artifact page length is inconsistent.");
      if (offset + chunk.length > size) throw new Error("Artifact page exceeds its declared size.");
      chunks.push(chunk);
      offset += chunk.length;
      if (page.eof) {
        if (page.next_offset_bytes !== null || offset !== size) throw new Error("Artifact EOF is inconsistent.");
        break;
      }
      if (!Number.isSafeInteger(page.next_offset_bytes) || page.next_offset_bytes !== offset || chunk.length === 0 || offset >= size) throw new Error("Artifact pagination did not advance.");
    }
    const bytes = concatBytes(chunks, expectedSize);
    const digest = await sha256Hex(bytes);
    if (requestToken !== state.artifactRequestToken || runId !== state.selectedRunId) return null;
    if (!expectedHash || digest !== expectedHash) throw new Error("Artifact SHA-256 verification failed; content was withheld.");
    if (state.artifactObjectUrl) URL.revokeObjectURL(state.artifactObjectUrl);
    const blob = new Blob([bytes], { type: artifact.media_type || "application/octet-stream" });
    const downloadUrl = URL.createObjectURL(blob);
    state.artifactObjectUrl = downloadUrl;
    const isText = textArtifact(artifact.path, artifact.media_type);
    return {
      bytes,
      bytesBase64: bytesToBase64(bytes.slice(0, 1024 * 1024)),
      size: expectedSize,
      sha256: digest,
      isText,
      text: isText ? new TextDecoder().decode(bytes) : "",
      downloadUrl
    };
  }

  async function loadArtifact(artifact) {
    if (!state.selectedRunId || !artifact?.path) return;
    const runId = state.selectedRunId;
    const requestToken = ++state.artifactRequestToken;
    state.artifactPath = artifact.path;
    state.artifact = null;
    state.artifactError = null;
    state.artifactLoading = true;
    renderRunDetail();
    try {
      const loaded = await readArtifactPages(runId, artifact, requestToken);
      if (requestToken === state.artifactRequestToken && runId === state.selectedRunId) state.artifact = loaded;
    } catch (error) {
      if (requestToken === state.artifactRequestToken && runId === state.selectedRunId) state.artifactError = formatError(error);
    } finally {
      if (requestToken === state.artifactRequestToken && runId === state.selectedRunId) {
        state.artifactLoading = false;
        renderRunDetail();
      }
    }
  }

  async function submitReview(decision, feedback, errorNode) {
    if (!state.selectedRunId || readOnly()) {
      if (readOnly()) errorNode.textContent = t("errors.readOnly");
      errorNode.hidden = !readOnly();
      return;
    }
    const runId = state.selectedRunId;
    const requestToken = state.runRequestToken;
    if (!feedback.trim()) {
      errorNode.textContent = t("run.feedbackPlaceholder");
      errorNode.hidden = false;
      return;
    }
    state.reviewBusy = true;
    renderRunDetail();
    try {
      const result = await callTool("collaboration_review", { run_id: runId, decision, feedback: feedback.trim() });
      if (!runIsCurrent(runId, requestToken)) return;
      const refreshed = result?.run_id ? result : await callTool("collaboration_result", { run_id: runId });
      if (!runIsCurrent(runId, requestToken)) return;
      state.selectedRun = refreshed;
      toast(t("toast.reviewed"));
      await loadHistory(true);
    } catch (error) {
      if (runIsCurrent(runId, requestToken)) state.runError = formatError(error);
    } finally {
      if (runIsCurrent(runId, requestToken)) {
        state.reviewBusy = false;
        renderRunDetail();
      }
    }
  }

  async function cancelRun() {
    if (readOnly() || !state.selectedRunId || !state.selectedRun || !ACTIVE_STATES.has(state.selectedRun.state) || state.cancelBusy) return;
    const runId = state.selectedRunId;
    const requestToken = state.runRequestToken;
    state.cancelBusy = true;
    renderRunDetail();
    try {
      const result = await callTool("collaboration_interrupt", { run_id: runId });
      if (!runIsCurrent(runId, requestToken)) return;
      const refreshed = result?.run_id ? result : await callTool("collaboration_result", { run_id: runId });
      if (!runIsCurrent(runId, requestToken)) return;
      state.selectedRun = refreshed;
      toast(t("toast.cancelled"));
      schedulePoll();
      await loadHistory(true);
    } catch (error) {
      if (runIsCurrent(runId, requestToken)) state.runError = formatError(error);
    } finally {
      if (runIsCurrent(runId, requestToken)) {
        state.cancelBusy = false;
        renderRunDetail();
      }
    }
  }

  function relativeLines(id) {
    return $(id).value.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  }

  function requireText(id, label) {
    const value = $(id).value.trim();
    if (!value) throw new Error(`${label} is required.`);
    return value;
  }

  function validateRelativePath(path, label) {
    if (!path || path.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(path) || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error(`${label} must be a normalized relative path.`);
    }
    return path;
  }

  function validateUuid(value, label) {
    if (!UUID_PATTERN.test(value)) throw new Error(`${label} must be a UUID.`);
    return value;
  }

  function buildContract() {
    if (!state.selectedWorkspaceId) throw new Error(t("errors.chooseProject"));
    const domain = $("experiment-domain").value;
    const objective = requireText("experiment-objective", t("experiments.objective"));
    const plan = relativeLines("experiment-plan");
    const acceptanceCriteria = relativeLines("experiment-acceptance");
    if (!plan.length) throw new Error(t("experiments.plan"));
    if (!acceptanceCriteria.length) throw new Error(t("experiments.acceptance"));
    const artifactPaths = relativeLines("experiment-outputs").map((path) => validateRelativePath(path, t("experiments.outputs")));
    if (!artifactPaths.length) throw new Error(t("experiments.outputs"));
    if (new Set(artifactPaths).size !== artifactPaths.length) throw new Error("Expected artifact paths must be unique.");
    const inputFiles = relativeLines("experiment-inputs").map((path) => validateRelativePath(path, t("experiments.inputs")));
    const contract = {
      domain,
      objective,
      plan,
      acceptance_criteria: acceptanceCriteria,
      expected_artifacts: artifactPaths
    };
    if (domain === "research") {
      const seedTokens = $("research-seeds").value.trim().split(/[\s,]+/u).filter(Boolean);
      const seeds = seedTokens.map((value) => Number(value));
      if (!seedTokens.length || seeds.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 2147483647)) throw new Error("Seeds must be non-negative integers no larger than 2147483647.");
      const baselines = relativeLines("research-baselines");
      const metrics = relativeLines("research-metrics");
      if (!baselines.length || !metrics.length) throw new Error("Baselines and metrics need at least one line.");
      contract.research = {
        question: requireText("research-question", t("researchFields.question")),
        hypothesis: requireText("research-hypothesis", t("researchFields.hypothesis")),
        baselines,
        dataset: requireText("research-dataset", t("researchFields.dataset")),
        split: requireText("research-split", t("researchFields.split")),
        seeds,
        metrics,
        protocol: requireText("research-protocol", t("researchFields.protocol"))
      };
      const sources = relativeLines("research-sources");
      const citations = relativeLines("research-citations");
      if (sources.length) contract.research.sources = sources;
      if (citations.length) contract.research.citations = citations;
    }
    const parent = $("experiment-parent").value.trim();
    if (parent) validateUuid(parent, t("experiments.parent"));
    return {
      workspace_id: state.selectedWorkspaceId,
      contract,
      input_files: inputFiles,
      ...(parent ? { parent_run_id: parent } : {})
    };
  }

  function requestFingerprint(payload) {
    return JSON.stringify(payload);
  }

  function requestFor(payload) {
    const fingerprint = requestFingerprint(payload);
    const key = state.selectedWorkspaceId ? `${REQUEST_KEY}.${state.selectedWorkspaceId}` : REQUEST_KEY;
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(key) || "null"); } catch { saved = null; }
    let id = saved?.fingerprint === fingerprint && UUID_PATTERN.test(saved?.id || "") ? saved.id : uuid();
    sessionStorage.setItem(key, JSON.stringify({ fingerprint, id }));
    state.lastRequestFingerprint = fingerprint;
    state.requestId = id;
    return id;
  }

  function uuid() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function renderRequestPreview() {
    const node = $("request-id-preview");
    if (!node) return;
    if (!state.requestId || state.formDirty) node.textContent = state.requestId && state.formDirty ? t("experiments.editedRequest") : t("experiments.newRequest");
    else node.textContent = t("experiments.requestRetry", { id: state.requestId.slice(0, 8) });
  }

  function renderExperimentAvailability() {
    const start = $("start-experiment");
    if (!start) return;
    const enabled = Boolean(state.selectedProject?.execution_enabled) && !readOnly();
    start.disabled = state.startBusy || !enabled;
    let note = $("execution-availability-note");
    if (!note) {
      note = make("p", "form-warning");
      note.id = "execution-availability-note";
      $("experiment-form").insertBefore(note, $("experiment-form").querySelector(".form-footer"));
    }
    note.textContent = enabled ? "" : readOnly() ? t("experiments.readOnly") : state.selectedProject ? t("experiments.disabled") : t("errors.chooseProject");
    note.hidden = enabled;
  }

  async function startExperiment() {
    if (state.startBusy || readOnly()) {
      if (readOnly()) showFormError("experiment-form-error", t("errors.readOnly"));
      return;
    }
    let payload;
    try { payload = buildContract(); }
    catch (error) { showFormError("experiment-form-error", formatError(error)); return; }
    const requestId = requestFor(payload);
    const workspaceId = state.selectedWorkspaceId;
    const requestToken = state.runRequestToken;
    state.startBusy = true;
    state.formDirty = false;
    showFormError("experiment-form-error", "");
    renderRequestPreview();
    renderExperimentAvailability();
    try {
      const result = await callTool("collaboration_run", { request_id: requestId, ...payload });
      if (workspaceId !== state.selectedWorkspaceId || requestToken !== state.runRequestToken) return;
      if (!result?.run_id) throw new Error("Bridge returned no run ID.");
      toast(t("toast.started"));
      await loadHistory(true);
      await selectRun(result.run_id);
    } catch (error) {
      showFormError("experiment-form-error", formatError(error));
    } finally {
      if (workspaceId === state.selectedWorkspaceId && requestToken === state.runRequestToken) {
        state.startBusy = false;
        renderRequestPreview();
        renderExperimentAvailability();
      }
    }
  }

  function setLines(id, values) {
    $(id).value = Array.isArray(values) ? values.join("\n") : "";
  }

  function iterateRun(run) {
    const contract = run.contract;
    if (!contract) return;
    showView("experiments");
    $("experiment-domain").value = contract.domain || "research";
    updateDomainFields();
    $("experiment-objective").value = contract.objective || "";
    setLines("experiment-plan", contract.plan);
    setLines("experiment-acceptance", contract.acceptance_criteria);
    setLines("experiment-outputs", (contract.expected_artifacts || []).map((artifact) => typeof artifact === "string" ? artifact : artifact.path));
    $("experiment-parent").value = run.run_id || "";
    if (contract.research) {
      $("research-question").value = contract.research.question || "";
      $("research-hypothesis").value = contract.research.hypothesis || "";
      setLines("research-baselines", contract.research.baselines);
      $("research-dataset").value = contract.research.dataset || "";
      $("research-split").value = contract.research.split || "";
      $("research-seeds").value = (contract.research.seeds || []).join(", ");
      setLines("research-metrics", contract.research.metrics);
      $("research-protocol").value = contract.research.protocol || "";
      setLines("research-sources", contract.research.sources);
      setLines("research-citations", contract.research.citations);
    }
    state.formDirty = true;
    renderRequestPreview();
    $("experiment-objective").focus();
  }

  function resetExperiment() {
    $("experiment-form").reset();
    $("experiment-domain").value = "research";
    updateDomainFields();
    state.formDirty = false;
    state.requestId = null;
    state.lastRequestFingerprint = null;
    if (state.selectedWorkspaceId) sessionStorage.removeItem(REQUEST_KEY + "." + state.selectedWorkspaceId);
    renderRequestPreview();
  }

  function updateDomainFields() {
    const research = $("experiment-domain").value === "research";
    $("research-fields").hidden = !research;
    for (const node of $("research-fields").querySelectorAll("input, textarea")) node.required = research && !["research-sources", "research-citations"].includes(node.id);
  }

  async function setupSubmit(event) {
    event.preventDefault();
    if (readOnly()) {
      showFormError("setup-form-error", t("errors.readOnly"));
      return;
    }
    showFormError("setup-form-error", "");
    const mode = document.querySelector("input[name='setup-mode']:checked")?.value || "create";
    const body = { mode };
    if (mode === "create") {
      const projectPath = $("setup-project-path").value.trim();
      if (!isAbsolutePath(projectPath)) { showFormError("setup-form-error", t("errors.invalidPath")); return; }
      body.project_path = projectPath;
      body.experiments = Boolean($("setup-experiments").checked);
    } else {
      const configPath = $("setup-config-path").value.trim();
      if (!isAbsolutePath(configPath)) { showFormError("setup-form-error", t("errors.invalidPath")); return; }
      body.config_path = configPath;
    }
    state.setupBusy = true;
    $("setup-submit").textContent = t("setup.saving");
    $("setup-submit").disabled = true;
    try {
      await api("/api/setup", { method: "POST", body });
      toast(t("toast.setup"));
      clearSelectedWorkspaceState();
      await refreshStatus();
      showView("overview");
    } catch (error) {
      showFormError("setup-form-error", formatError(error));
    } finally {
      state.setupBusy = false;
      $("setup-submit").textContent = t("setup.continue");
      $("setup-submit").disabled = readOnly();
    }
  }

  function isAbsolutePath(value) {
    return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value);
  }

  async function companionAction(action) {
    if (state.companionBusy || readOnly()) {
      if (readOnly()) showPageError(new Error(t("errors.readOnly")));
      return;
    }
    state.companionBusy = true;
    renderCompanion();
    try {
      await api("/api/companion", { method: "POST", body: { action } });
      toast(t("toast.companion"));
      await refreshStatus();
    } catch (error) {
      showPageError(error);
    } finally {
      state.companionBusy = false;
      renderCompanion();
    }
  }

  async function copyText(value) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(value);
      toast(t("toast.copied"));
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "true");
      textarea.className = "clipboard-fallback";
      document.body.appendChild(textarea);
      textarea.select();
      let copied = false;
      try { copied = document.execCommand("copy"); } catch { copied = false; }
      textarea.remove();
      if (copied) toast(t("toast.copied"));
      else toast(t("errors.copy"));
    }
  }

  function openChat() {
    const url = savedHandoffUrl() || "https://chatgpt.com/";
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async function saveHandoff() {
    if (!state.selectedWorkspaceId) { showFormError("handoff-error", t("errors.chooseProject")); return; }
    if (readOnly()) { showFormError("handoff-error", t("errors.readOnly")); return; }
    const value = $("chatgpt-url").value.trim();
    if (value && !validChatgptUrl(value)) { showFormError("handoff-error", t("errors.invalidUrl")); return; }
    const workspaceId = state.selectedWorkspaceId;
    const requestToken = ++state.handoffRequestToken;
    state.handoffLoading = true;
    showFormError("handoff-error", "");
    renderHandoff();
    try {
      const response = unwrap(await api("/api/research", {
        method: "POST",
        body: { action: "save", workspace_id: workspaceId, conversation_url: value }
      }));
      if (requestToken !== state.handoffRequestToken || workspaceId !== state.selectedWorkspaceId) return;
      const saved = typeof response?.conversation_url === "string" ? response.conversation_url : value;
      state.handoffUrl = validChatgptUrl(saved) ? saved : "";
      toast(t("toast.saved"));
    } catch (error) {
      if (requestToken === state.handoffRequestToken && workspaceId === state.selectedWorkspaceId) showFormError("handoff-error", formatError(error));
    } finally {
      if (requestToken === state.handoffRequestToken && workspaceId === state.selectedWorkspaceId) {
        state.handoffLoading = false;
        renderHandoff();
      }
    }
  }

  async function clearHandoff() {
    $("chatgpt-url").value = "";
    await saveHandoff();
  }

  function wireEvents() {
    $("language-toggle").addEventListener("click", () => {
      state.language = state.language === "en" ? "zh" : "en";
      sessionStorage.setItem(LANGUAGE_KEY, state.language);
      applyLanguage();
    });
    $("refresh-button").addEventListener("click", () => { void refreshStatus(); });
    $("dismiss-error").addEventListener("click", hidePageError);
    $("setup-link").addEventListener("click", () => showView("setup"));
    $("project-select").addEventListener("change", (event) => { void chooseProject(event.target.value); });
    document.querySelectorAll(".nav-item").forEach((node) => node.addEventListener("click", () => showView(node.dataset.view)));
    $("overview-new-experiment").addEventListener("click", () => { showView("experiments"); $("experiment-objective").focus(); });
    $("overview-open-chat").addEventListener("click", openChat);
    $("overview-open-research").addEventListener("click", () => showView("research"));
    $("overview-choose-project").addEventListener("click", () => $("project-select").focus());
    $("overview-see-all").addEventListener("click", () => showView("experiments"));
    $("companion-install").addEventListener("click", () => { void companionAction("install"); });
    $("companion-launch").addEventListener("click", () => { void companionAction("launch"); });
    document.querySelectorAll("input[name='setup-mode']").forEach((node) => node.addEventListener("change", renderSetupMode));
    $("setup-form").addEventListener("submit", setupSubmit);
    $("save-chatgpt-url").addEventListener("click", () => { void saveHandoff(); });
    $("clear-chatgpt-url").addEventListener("click", () => { void clearHandoff(); });
    $("research-copy-brief").addEventListener("click", () => { void copyText(buildResearchBrief()); });
    $("research-copy-brief-top").addEventListener("click", () => { void copyText(buildResearchBrief()); });
    $("handoff-open-chat").addEventListener("click", (event) => {
      if (!savedHandoffUrl()) { event.preventDefault(); openChat(); }
    });
    $("research-open-chat").addEventListener("click", (event) => {
      if (!savedHandoffUrl()) { event.preventDefault(); openChat(); }
    });
    $("experiment-domain").addEventListener("change", () => { updateDomainFields(); state.formDirty = true; renderRequestPreview(); });
    $("experiment-form").addEventListener("input", () => { state.formDirty = true; renderRequestPreview(); });
    $("experiment-form").addEventListener("change", () => { state.formDirty = true; renderRequestPreview(); });
    $("experiment-form").addEventListener("submit", (event) => { event.preventDefault(); void startExperiment(); });
    $("reset-experiment").addEventListener("click", resetExperiment);
    $("history-refresh").addEventListener("click", () => { void loadHistory(true); });
    $("history-load-more").addEventListener("click", () => { void loadHistory(false); });
  }

  function init() {
    readTokenFromHash();
    wireEvents();
    updateDomainFields();
    applyLanguage();
    showView("overview");
    void refreshStatus();
  }

  init();
})();
