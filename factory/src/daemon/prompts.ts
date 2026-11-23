import { readFileSync } from 'node:fs';

export interface ExecutorVars {
  item_id: number; title: string; body: string; spec: string; spec_path: string; prd_path: string;
  test_cmd: string; iteration: number; failure_output: string; review_findings: string;
  gate_note: string; resume: boolean;
}
export interface ReviewerVars {
  item_id: number; title: string; body: string; spec: string; spec_path: string;
  test_cmd: string; diff: string; test_output: string;
}
export interface Verdict { verdict: 'approve' | 'changes'; findings: string[] }
export const NO_VERDICT_FINDING = 'reviewer returned no parseable verdict';

const load = (name: string) => readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), 'utf8');
const EXECUTOR = load('executor');
const REVIEWER = load('reviewer');

type Vars = Record<string, string | number | boolean>;

export function render(tpl: string, vars: Vars): string {
  const val = (k: string) => {
    if (!(k in vars)) throw new Error(`unknown template var {{${k}}}`);
    return vars[k];
  };
  // Sections first (repeat for nesting; template-only, before values exist), then one substitution pass so values never re-expand.
  const section = /\{\{#(\w+)\}\}\n?([\s\S]*?)\{\{\/\1\}\}\n?/g;
  let out = tpl;
  while (section.test(out)) {
    section.lastIndex = 0;
    out = out.replace(section, (_, k: string, inner: string) => {
      const v = val(k);
      return v === true || (typeof v === 'string' && v !== '') ? inner : '';
    });
  }
  return out.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(val(k)));
}

export const buildExecutorPrompt = (v: ExecutorVars): string => render(EXECUTOR, { ...v });
export const buildReviewerPrompt = (v: ReviewerVars): string => render(REVIEWER, { ...v });

export function parseVerdict(finalText: string): Verdict {
  const blocks = [...finalText.matchAll(/^```json[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gim)];
  const last = blocks.at(-1);
  try {
    const j = JSON.parse(last![1]);
    const findings = j.findings === undefined && j.verdict === 'approve' ? [] : j.findings;
    if ((j.verdict === 'approve' || j.verdict === 'changes') && Array.isArray(findings) && findings.every((f) => typeof f === 'string')) {
      return { verdict: j.verdict, findings };
    }
  } catch {}
  return { verdict: 'changes', findings: [NO_VERDICT_FINDING] };
}
