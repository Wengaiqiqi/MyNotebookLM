import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { InsightDto } from "../../../../shared/transformations";
import SafeMarkdown from "../../chat/SafeMarkdown";
import Icon from "../../ui/Icon";
import { parseQuiz } from "./quiz";

type Response = { text: string; revealed: boolean; rating?: "known" | "review" };
type Progress = Record<string, Response>;

export default function QuizPanel({ projectId, insights, onDelete }: { projectId: string; insights: InsightDto[]; onDelete: (insightId: string) => Promise<boolean> }) {
  const { t } = useTranslation();
  const sets = useMemo(() => insights.filter((item) => item.builtinKey === "qa")
    .map((insight) => ({ insight, questions: parseQuiz(insight.content) })), [insights]);
  const [selected, setSelected] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const active = sets.find((set) => set.insight.id === selected) ?? sets[0];
  return <section className="panel studio-rules" aria-label={t("transformations.practice")}>
    <header className="panel-head"><h2>{t("transformations.practice")}</h2><span className="count">{sets.length}</span></header>
    {!active ? <div className="empty quiz-empty"><p>{t("transformations.noQuestions")}</p><small>{t("transformations.practiceHint")}</small></div> : <>
      <div className="quiz-tabs" role="tablist" aria-label={t("transformations.questionSets")}>
        {sets.map(({ insight }, index) => {
          const title = insight.content.match(/^#\s+(.+)$/m)?.[1] ?? `${t("transformations.questionSet")} ${sets.length - index}`;
          return <div className="quiz-tab" role="presentation" key={insight.id}><button type="button" role="tab"
          id={`quiz-tab-${insight.id}`} aria-controls="quiz-panel" aria-selected={active.insight.id === insight.id}
          onClick={() => setSelected(insight.id)} onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? sets.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + sets.length) % sets.length;
            setSelected(sets[next]!.insight.id);
            document.getElementById(`quiz-tab-${sets[next]!.insight.id}`)?.focus();
          }}>{title}</button><button type="button" className="quiz-tab-delete" aria-label={`${t("common.delete")}: ${title}`} disabled={deleting === insight.id}
            onClick={async () => { setDeleting(insight.id); const deleted = await onDelete(insight.id); setDeleting(null); if (deleted) localStorage.removeItem(`notebook:quiz:${projectId}:${insight.id}`); }}><Icon name="trash" /></button></div>;
        })}
      </div>
      <div id="quiz-panel" role="tabpanel" aria-labelledby={`quiz-tab-${active.insight.id}`} className="panel-body quiz-body">
        <QuizAttempt key={`${projectId}:${active.insight.id}`} projectId={projectId} insight={active.insight} />
      </div>
    </>}
  </section>;
}

function QuizAttempt({ projectId, insight }: { projectId: string; insight: InsightDto }) {
  const { t } = useTranslation();
  const questions = useMemo(() => parseQuiz(insight.content), [insight.content]);
  const storageKey = `notebook:quiz:${projectId}:${insight.id}`;
  const [progress, setProgress] = useState<Progress>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
      if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
      return Object.fromEntries(Object.entries(stored).filter(([, value]) => value && typeof value.text === "string" && typeof value.revealed === "boolean"));
    } catch { return {}; }
  });
  const [saveError, setSaveError] = useState(false);
  function update(key: string, response: Response) {
    const next = { ...progress, [key]: response };
    setProgress(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); setSaveError(false); }
    catch { setSaveError(true); }
  }
  if (!questions.length) return <p role="status">{t("transformations.unreadableQuestions")}</p>;
  const completed = questions.filter((q, index) => progress[`${index}:${q.question}`]?.rating).length;
  return <>
    <p className="quiz-progress">{t("transformations.practiceProgress", { count: completed, total: questions.length })}</p>
    {saveError && <p className="err" role="alert">{t("transformations.practiceSaveError")}</p>}
    {questions.map((q, index) => {
      const key = `${index}:${q.question}`;
      const response = progress[key] ?? { text: "", revealed: false };
      return <article className="quiz-question" key={`${index}:${q.question}`}>
        <div id={`question-${index}`} className="assistant-body"><span className="quiz-number">{index + 1}.</span><SafeMarkdown text={q.question} /></div>
        <textarea className="textarea" aria-labelledby={`question-${index}`} placeholder={t("transformations.yourAnswer")}
          value={response.text} onChange={(event) => update(key, { text: event.target.value, revealed: false })} />
        {!response.revealed ? <button type="button" className="btn sm" onClick={() => update(key, { ...response, revealed: true })}>{t("transformations.revealAnswer")}</button> : <>
          <div className="quiz-reference assistant-body"><strong>{t("transformations.referenceAnswer")}</strong><SafeMarkdown text={q.answer} /></div>
          <div className="quiz-actions"><span>{t("transformations.selfAssess")}</span>{(["known", "review"] as const).map((rating) =>
            <button type="button" key={rating} className={`btn sm${response.rating === rating ? " primary" : ""}`} aria-pressed={response.rating === rating}
              onClick={() => update(key, { ...response, rating })}>{t(`transformations.${rating}`)}</button>)}</div>
        </>}
      </article>;
    })}
  </>;
}
