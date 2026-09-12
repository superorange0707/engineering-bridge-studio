import type { CodexLogicalRole } from "./codex-model-registry.js";

export type CodexRouting = "auto" | CodexLogicalRole;
export type CodexRoutingReason =
  | "explicit_override"
  | "high_risk_or_architectural"
  | "bounded_implementation"
  | "default_quality_route";
export type CodexRoutingRule =
  | "explicit_override"
  | "positive_high_risk_intent"
  | "bounded_implementation"
  | "quality_fallback"
  | "legacy_unverified";

export interface CodexRouteSelection {
  readonly requestedRouting: CodexRouting;
  readonly logicalRole: CodexLogicalRole;
  readonly reason: CodexRoutingReason;
  readonly matchedRule: CodexRoutingRule;
  readonly matchedFactors: readonly string[];
  readonly ignoredGuardFactors: readonly string[];
}

const PRINCIPAL_SIGNALS = /\b(?:architect(?:ure|ural)?|security|permissions?|authorization|access control|threat model|migrat(?:e|ions?)|schemas?|data semantics|data loss|destructive|irreversible|high[- ]risk|critical|whole[- ]repo|repo[- ]wide|root cause|incident|race condition|public (?:api|compatibility)|backward compatibility)\b|架构|安全|权限|迁移|数据(?:库)?模式|表结构|数据语义|数据丢失|破坏性|不可逆|高风险|关键|全仓|根因/u;
const STRONG_PRINCIPAL_SIGNAL = /^(?:data loss|destructive|irreversible|high[- ]risk|critical|incident|race condition|数据丢失|破坏性|不可逆|高风险|关键)$/u;
const HIGH_RISK_ACTION = /\b(?:architect|audit|authorize|change|design|fix|implement|investigate|migrate|modify|plan|propose|decide|evaluate|assess|define|specify|redesign|refactor|remove|replace|review|secure|threat[- ]model)\b|规划|计划|提议|提出|决定|评估|评价|定义|指定|设计|审查|授权|变更|修改|修复|实现|调查|迁移|重构|删除|替换/u;
const DIRECT_HIGH_RISK_ACTION = /\b(?:architect|audit|authorize|design|migrate|plan|propose|decide|evaluate|assess|define|specify|redesign|secure|threat[- ]model)\b|规划|计划|提议|提出|决定|评估|评价|定义|指定|设计|审查|授权|迁移/u;
const IMPLEMENTATION_ACTION = /\b(?:add|change|fix|implement|rename|replace|review|update|remove|write|document)\b|添加|修改|修复|实现|重命名|替换|审查|更新|删除|编写/u;
const BOUNDED_SCOPE = /\b(?:exact|specific|single|one|file|function|method|test|typo|endpoint|component|field|line|acceptance criteria|documentation[- ]only|docs?[- ]only)\b|明确|具体|单个|一个|文件|函数|方法|测试|错别字|端点|组件|字段|一行|验收|仅文档/u;
const DOCUMENTATION_OBJECT = /\b(?:readme|docs?|documentation|documenting|text|typo|wording|comment|note|line)\b|文档|说明|文案|错别字|注释|一行/u;
const GUARD_START = /\b(?:and\s+)?(?:do\s+not|don['’]?t|must\s+not|never|no|avoid|prohibit(?:ed|s|ing)?|exclude(?:d|s|ing)?|fail\s+closed\s+if|without\s+(?:changing|modifying|altering|affecting))\b|不要|不得|禁止|避免|在不(?:改变|修改|影响)/u;
const CONDITIONAL_OUTCOME = /\bif\b.*?\b(?:fail\s+closed|stop|reject)(?:\s+the\s+task)?\b|如果.*?(?:失败关闭|停止|拒绝(?:任务)?)/u;
const CONDITIONAL_REJECTION = /\b(?:fail\s+closed|reject(?:\s+the\s+task)?)\b|失败关闭|拒绝(?:任务)?/u;
const SENTENCE_BOUNDARY = /[\n.;。；]+/u;
const RESET_BOUNDARY = /\b(?:but|however|instead)\b|但是|不过|然而/u;
const COMMA_BOUNDARY = /[,，]+/u;
const MAX_ROUTING_FACTORS = 20;

interface RoutingSpan { readonly text: string; readonly guarded: boolean }

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].slice(0, MAX_ROUTING_FACTORS);
}

function matches(expression: RegExp, value: string): Array<{ value: string; index: number }> {
  const global = new RegExp(expression.source, `${expression.flags}g`);
  return [...value.matchAll(global)].map((match) => ({ value: match[0], index: match.index }));
}

function startsWithPositiveAction(text: string): boolean {
  const candidate = text.trimStart().replace(/^(?:(?:and|then)\s+|然后)/u, "");
  return HIGH_RISK_ACTION.exec(candidate)?.index === 0 || IMPLEMENTATION_ACTION.exec(candidate)?.index === 0;
}

function appendRoutingSpans(spans: RoutingSpan[], text: string): void {
  for (const segment of text.split(RESET_BOUNDARY)) {
    let guarded = false;
    let parts: string[] = [];
    const flush = (): void => {
      if (parts.some((part) => part.trim())) spans.push({ text: parts.join(", "), guarded });
      parts = [];
    };
    for (const clause of segment.split(COMMA_BOUNDARY)) {
      if (!clause.trim()) continue;
      if (guarded && startsWithPositiveAction(clause)) {
        flush();
        guarded = false;
      }
      const explicit = GUARD_START.exec(clause)?.index;
      if (explicit === undefined) {
        parts.push(clause);
        continue;
      }
      const prefix = clause.slice(0, explicit);
      if (prefix.trim()) parts.push(prefix);
      if (!guarded) {
        flush();
        guarded = true;
      }
      parts.push(clause.slice(explicit));
    }
    flush();
  }
}

function conditionalOutcomeIsGuard(text: string): boolean {
  if (CONDITIONAL_REJECTION.test(text)) return true;
  const stop = /\bstop\b|停止/u.exec(text);
  const consequenceStart = /[,，]/u.exec(text)?.index;
  if (stop === null || consequenceStart === undefined) return true;
  return !HIGH_RISK_ACTION.test(text.slice(consequenceStart + 1, stop.index));
}

function routingSpans(instruction: string): RoutingSpan[] {
  const spans: RoutingSpan[] = [];
  for (const sentence of instruction.split(SENTENCE_BOUNDARY)) {
    let remaining = sentence;
    let conditional = CONDITIONAL_OUTCOME.exec(remaining);
    while (conditional !== null) {
      appendRoutingSpans(spans, remaining.slice(0, conditional.index));
      spans.push({ text: conditional[0], guarded: conditionalOutcomeIsGuard(conditional[0]) });
      remaining = remaining.slice(conditional.index + conditional[0].length);
      conditional = CONDITIONAL_OUTCOME.exec(remaining);
    }
    appendRoutingSpans(spans, remaining);
  }
  return spans;
}

function highRiskFactors(spans: readonly RoutingSpan[]): { matched: string[]; ignored: string[] } {
  const matched: string[] = [];
  const ignored: string[] = [];
  for (const span of spans) {
    const actions = matches(HIGH_RISK_ACTION, span.text).map(({ value }) => value);
    const directActions = matches(DIRECT_HIGH_RISK_ACTION, span.text).map(({ value }) => value);
    const documentationOnly = DOCUMENTATION_OBJECT.test(span.text) && BOUNDED_SCOPE.test(span.text);
    for (const signal of matches(PRINCIPAL_SIGNALS, span.text)) {
      if (span.guarded) {
        ignored.push(`signal:${signal.value}`);
      } else if (directActions.length > 0 || (!documentationOnly &&
          (actions.length > 0 || STRONG_PRINCIPAL_SIGNAL.test(signal.value)))) {
        matched.push(`signal:${signal.value}`, ...actions.map((action) => `action:${action}`));
      }
    }
  }
  return { matched: unique(matched), ignored: unique(ignored) };
}

function positiveFactors(
  spans: readonly RoutingSpan[],
  expression: RegExp,
  prefix: "action" | "scope"
): string[] {
  return unique(spans.flatMap(({ text, guarded }) => guarded
    ? []
    : matches(expression, text).map(({ value }) => `${prefix}:${value}`)));
}

export function routeCodexTask(routing: CodexRouting = "auto", instruction: string): CodexRouteSelection {
  if (routing !== "auto") {
    return {
      requestedRouting: routing,
      logicalRole: routing,
      reason: "explicit_override",
      matchedRule: "explicit_override",
      matchedFactors: [`override:${routing}`],
      ignoredGuardFactors: []
    };
  }
  const normalized = instruction.toLowerCase();
  const spans = routingSpans(normalized);
  const highRisk = highRiskFactors(spans);
  if (highRisk.matched.length > 0) {
    return {
      requestedRouting: routing,
      logicalRole: "repo_principal",
      reason: "high_risk_or_architectural",
      matchedRule: "positive_high_risk_intent",
      matchedFactors: highRisk.matched,
      ignoredGuardFactors: highRisk.ignored
    };
  }
  const actions = positiveFactors(spans, IMPLEMENTATION_ACTION, "action");
  const scope = positiveFactors(spans, BOUNDED_SCOPE, "scope");
  if (actions.length > 0 && scope.length > 0) {
    return {
      requestedRouting: routing,
      logicalRole: "implementer",
      reason: "bounded_implementation",
      matchedRule: "bounded_implementation",
      matchedFactors: unique([...actions, ...scope]),
      ignoredGuardFactors: highRisk.ignored
    };
  }
  return {
    requestedRouting: routing,
    logicalRole: "local_lead",
    reason: "default_quality_route",
    matchedRule: "quality_fallback",
    matchedFactors: [],
    ignoredGuardFactors: highRisk.ignored
  };
}

export function routingTransition(
  parent: CodexLogicalRole,
  child: CodexLogicalRole
): "escalation" | "de_escalation" | "handoff" {
  const rank: Readonly<Record<CodexLogicalRole, number>> = {
    implementer: 0,
    local_lead: 1,
    repo_principal: 2
  };
  if (rank[child] > rank[parent]) return "escalation";
  if (rank[child] < rank[parent]) return "de_escalation";
  return "handoff";
}
