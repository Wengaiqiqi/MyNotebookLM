import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { InsightDto } from "../../../../shared/transformations";
import SafeMarkdown from "../../chat/SafeMarkdown";
import Icon from "../../ui/Icon";
import { parseQuiz, type QuizOption, type QuizQuestion } from "./quiz";

type AttemptResponse = {
  selectedKey?: string;
  isCorrect?: boolean;
  text?: string;
  revealed?: boolean;
  rating?: "known" | "review";
};
type Progress = Record<string, AttemptResponse>;

export default function QuizPanel({
  projectId,
  insights,
  onDelete
}: {
  projectId: string;
  insights: InsightDto[];
  onDelete: (insightId: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const sets = useMemo(
    () =>
      insights
        .filter((item) => item.builtinKey === "qa")
        .map((insight) => ({ insight, questions: parseQuiz(insight.content) })),
    [insights]
  );
  const [selected, setSelected] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const active = sets.find((set) => set.insight.id === selected) ?? sets[0];

  return (
    <section className="panel studio-rules" aria-label={t("transformations.practice")}>
      <header className="panel-head">
        <h2>{t("transformations.practice")}</h2>
        <span className="count">{sets.length}</span>
      </header>
      {!active ? (
        <div className="empty quiz-empty">
          <p>{t("transformations.noQuestions")}</p>
          <small>{t("transformations.practiceHint")}</small>
        </div>
      ) : (
        <>
          <div className="quiz-tabs" role="tablist" aria-label={t("transformations.questionSets")}>
            {sets.map(({ insight }, index) => {
              const title =
                insight.content.match(/^#\s+(.+)$/m)?.[1]?.trim() ??
                `${t("transformations.questionSet")} ${sets.length - index}`;
              return (
                <div className={`quiz-tab${active.insight.id === insight.id ? " active" : ""}`} role="presentation" key={insight.id}>
                  <button
                    type="button"
                    role="tab"
                    id={`quiz-tab-${insight.id}`}
                    aria-controls="quiz-panel"
                    aria-selected={active.insight.id === insight.id}
                    onClick={() => setSelected(insight.id)}
                    onKeyDown={(event) => {
                      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                      event.preventDefault();
                      const next =
                        event.key === "Home"
                          ? 0
                          : event.key === "End"
                          ? sets.length - 1
                          : (index + (event.key === "ArrowRight" ? 1 : -1) + sets.length) % sets.length;
                      setSelected(sets[next]!.insight.id);
                      document.getElementById(`quiz-tab-${sets[next]!.insight.id}`)?.focus();
                    }}
                  >
                    {title}
                  </button>
                  <button
                    type="button"
                    className="quiz-tab-delete"
                    aria-label={`${t("common.delete")}: ${title}`}
                    disabled={deleting === insight.id}
                    onClick={async () => {
                      setDeleting(insight.id);
                      const deleted = await onDelete(insight.id);
                      setDeleting(null);
                      if (deleted) localStorage.removeItem(`notebook:quiz:${projectId}:${insight.id}`);
                    }}
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              );
            })}
          </div>
          <div
            id="quiz-panel"
            role="tabpanel"
            aria-labelledby={`quiz-tab-${active.insight.id}`}
            className="panel-body quiz-body"
          >
            <QuizAttempt
              key={`${projectId}:${active.insight.id}`}
              projectId={projectId}
              insight={active.insight}
            />
          </div>
        </>
      )}
    </section>
  );
}

function QuizAttempt({ projectId, insight }: { projectId: string; insight: InsightDto }) {
  const { t } = useTranslation();
  const questions = useMemo(() => parseQuiz(insight.content), [insight.content]);
  const storageKey = `notebook:quiz:${projectId}:${insight.id}`;

  const [progress, setProgress] = useState<Progress>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
      if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
      return Object.fromEntries(
        Object.entries(stored).filter(
          ([, value]) =>
            value &&
            typeof value === "object" &&
            (typeof (value as AttemptResponse).text === "string" ||
              typeof (value as AttemptResponse).selectedKey === "string" ||
              typeof (value as AttemptResponse).revealed === "boolean")
        )
      );
    } catch {
      return {};
    }
  });

  const [showSummary, setShowSummary] = useState(false);
  const [saveError, setSaveError] = useState(false);

  function update(key: string, response: AttemptResponse) {
    const next = { ...progress, [key]: response };
    setProgress(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setSaveError(false);
    } catch {
      setSaveError(true);
    }
  }

  function handleOptionSelect(q: QuizQuestion, qIndex: number, optionKey: string) {
    const key = `${qIndex}:${q.question}`;
    const isCorrect = q.correctAnswer ? optionKey.toUpperCase() === q.correctAnswer.toUpperCase() : undefined;
    const current = progress[key] ?? {};
    update(key, {
      ...current,
      selectedKey: optionKey,
      ...(isCorrect === undefined ? {} : { isCorrect }),
      revealed: true
    });
  }

  function handleResetCurrent(q: QuizQuestion, qIndex: number) {
    const key = `${qIndex}:${q.question}`;
    const next = { ...progress };
    delete next[key];
    setProgress(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setSaveError(false);
    } catch {
      setSaveError(true);
    }
  }

  function handleRetakeAll() {
    setProgress({});
    setShowSummary(false);
    try {
      localStorage.removeItem(storageKey);
      setSaveError(false);
    } catch {
      setSaveError(true);
    }
  }

  if (!questions.length) {
    return <p role="status">{t("transformations.unreadableQuestions")}</p>;
  }

  // Calculate statistics
  let correctCount = 0;
  let incorrectCount = 0;
  let answeredCount = 0;

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    const state = progress[`${i}:${q.question}`];
    if (!state) continue;

    if (q.options.length > 0) {
      if (state.selectedKey) {
        answeredCount++;
        if (state.isCorrect) correctCount++;
        else incorrectCount++;
      }
    } else {
      if (state.rating) {
        answeredCount++;
        if (state.rating === "known") correctCount++;
        else incorrectCount++;
      }
    }
  }

  const total = questions.length;
  const unansweredCount = Math.max(0, total - answeredCount);
  const accuracyRate = answeredCount > 0 ? Math.round((correctCount / answeredCount) * 100) : 0;
  const progressPercent = Math.round((answeredCount / total) * 100);

  return (
    <div className="quiz-container">
      {/* Top Controls & Metrics Bar */}
      {/* Top Toolbar & Metrics Header */}
      <div className="quiz-header-bar">
        <div className="quiz-stats-row">
          <div className="quiz-badge-group">
            <span className="quiz-badge correct" title={t("transformations.correct")}>
              <Icon name="check" /> {correctCount}
            </span>
            <span className="quiz-badge incorrect" title={t("transformations.incorrect")}>
              <Icon name="close" /> {incorrectCount}
            </span>
            <span className="quiz-badge neutral" title={t("transformations.unanswered")}>
              {unansweredCount} {t("transformations.unanswered")}
            </span>
          </div>

          <div className="quiz-actions-group">
            {answeredCount > 0 && (
              <button
                type="button"
                className={`btn xs quiz-action-btn${showSummary ? " primary" : ""}`}
                onClick={() => setShowSummary(!showSummary)}
              >
                <Icon name="sparkle" />
                <span>{showSummary ? t("transformations.backToQuiz") : t("transformations.viewSummary")}</span>
              </button>
            )}

            <button
              type="button"
              className="btn xs quiz-action-btn danger-hover"
              onClick={handleRetakeAll}
              title={t("transformations.retake")}
            >
              <Icon name="retry" />
              <span>{t("transformations.retake")}</span>
            </button>
          </div>
        </div>

        {/* Full-width sleek progress bar with label */}
        <div className="quiz-progress-section">
          <div className="quiz-progress-info">
            <span className="quiz-progress-label">
              {t("transformations.practiceProgress", { count: answeredCount, total })}
              {answeredCount > 0 && (
                <span className="quiz-accuracy-label">
                  {" · "}
                  {t("transformations.practiceAccuracy", { rate: accuracyRate })}
                </span>
              )}
            </span>
            <span className="quiz-progress-percent">{progressPercent}%</span>
          </div>
          <div className="quiz-progress-track" title={`${answeredCount}/${total} (${progressPercent}%)`}>
            <div className="quiz-progress-fill" style={{ width: `${progressPercent}%` }} />
          </div>
        </div>
      </div>

      {saveError && <p className="err" role="alert">{t("transformations.practiceSaveError")}</p>}

      {/* Summary Scorecard View */}
      {showSummary ? (
        <div className="quiz-summary-card">
          <div className="quiz-score-circle">
            <span className="quiz-score-num">{accuracyRate}%</span>
            <span className="quiz-score-caption">{t("transformations.scoreRate")}</span>
          </div>
          <h3 className="quiz-summary-title">
            {accuracyRate === 100
              ? t("transformations.perfectScore")
              : accuracyRate >= 80
              ? t("transformations.greatScore")
              : accuracyRate >= 60
              ? t("transformations.passScore")
              : t("transformations.lowScore")}
          </h3>
          <p className="quiz-summary-detail">
            {t("transformations.scoreCount", { correct: correctCount, total })}
          </p>
          <div className="quiz-summary-buttons">
            <button
              type="button"
              className="btn primary"
              onClick={() => setShowSummary(false)}
            >
              {t("transformations.backToQuiz")}
            </button>
            <button type="button" className="btn" onClick={handleRetakeAll}>
              <Icon name="retry" /> {t("transformations.retake")}
            </button>
          </div>
        </div>
      ) : (
        <div className="quiz-list-wrapper">
          {questions.map((q, idx) => (
            <QuestionCard
              key={`${idx}:${q.question}`}
              question={q}
              index={idx}
              total={total}
              state={progress[`${idx}:${q.question}`] ?? { text: "", revealed: false }}
              onOptionSelect={(optKey) => handleOptionSelect(q, idx, optKey)}
              onResetCurrent={() => handleResetCurrent(q, idx)}
              onLegacyUpdate={(upd) => update(`${idx}:${q.question}`, upd)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function QuestionCard({
  question,
  index,
  total,
  state,
  onOptionSelect,
  onResetCurrent,
  onLegacyUpdate
}: {
  question: QuizQuestion;
  index: number;
  total: number;
  state: AttemptResponse;
  onOptionSelect: (optKey: string) => void;
  onResetCurrent: () => void;
  onLegacyUpdate: (res: AttemptResponse) => void;
}) {
  const { t } = useTranslation();
  const isMultipleChoice = question.options.length > 0;
  const hasAnswered = isMultipleChoice ? Boolean(state.selectedKey) : state.revealed;

  return (
    <article className="quiz-card" aria-labelledby={`question-title-${index}`}>
      <div className="quiz-card-header">
        <span className="quiz-card-number">
          {index + 1} / {total}
        </span>
        <span className="quiz-card-type">
          {isMultipleChoice ? t("transformations.singleChoice") : t("transformations.questionSet")}
        </span>
      </div>

      <div id={`question-title-${index}`} className="quiz-card-question assistant-body">
        <SafeMarkdown text={question.question} />
      </div>

      {isMultipleChoice ? (
        <div className="quiz-options-grid" role="radiogroup">
          {question.options.map((opt) => {
            const isSelected = state.selectedKey === opt.key;
            const isCorrectOption = question.correctAnswer
              ? opt.key.toUpperCase() === question.correctAnswer.toUpperCase()
              : false;

            let optionStatus = "default";
            if (hasAnswered) {
              if (isSelected) {
                optionStatus = state.isCorrect ? "selected-correct" : "selected-incorrect";
              } else if (isCorrectOption) {
                optionStatus = "show-correct";
              } else {
                optionStatus = "dimmed";
              }
            }

            return (
              <button
                type="button"
                key={opt.key}
                role="radio"
                aria-checked={isSelected}
                disabled={hasAnswered}
                className={`quiz-option-btn ${optionStatus}`}
                onClick={() => onOptionSelect(opt.key)}
              >
                <div className="quiz-option-badge">{opt.key}</div>
                <div className="quiz-option-text">
                  <SafeMarkdown text={opt.text} />
                </div>
                {hasAnswered && (
                  <div className="quiz-option-feedback-icon">
                    {isSelected && state.isCorrect && <Icon name="check" className="icon-correct" />}
                    {isSelected && !state.isCorrect && <Icon name="close" className="icon-incorrect" />}
                    {!isSelected && isCorrectOption && <Icon name="check" className="icon-correct" />}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        /* Legacy Question fallback */
        <div className="quiz-legacy-box">
          <textarea
            className="textarea"
            placeholder={t("transformations.yourAnswer")}
            value={state.text ?? ""}
            onChange={(e) => onLegacyUpdate({ ...state, text: e.target.value, revealed: false })}
          />
          {!state.revealed ? (
            <button
              type="button"
              className="btn sm"
              onClick={() => onLegacyUpdate({ ...state, revealed: true })}
            >
              {t("transformations.revealAnswer")}
            </button>
          ) : (
            <>
              <div className="quiz-reference assistant-body">
                <strong>{t("transformations.referenceAnswer")}</strong>
                <SafeMarkdown text={question.answer} />
              </div>
              <div className="quiz-actions">
                <span>{t("transformations.selfAssess")}</span>
                {(["known", "review"] as const).map((rating) => (
                  <button
                    type="button"
                    key={rating}
                    className={`btn sm${state.rating === rating ? " primary" : ""}`}
                    aria-pressed={state.rating === rating}
                    onClick={() => onLegacyUpdate({ ...state, rating })}
                  >
                    {t(`transformations.${rating}`)}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Explanation Banner */}
      {isMultipleChoice && hasAnswered && (
        <div
          className={`quiz-explanation-banner ${
            state.isCorrect ? "banner-correct" : "banner-incorrect"
          }`}
        >
          <div className="quiz-banner-header">
            <span className="quiz-banner-title">
              {state.isCorrect ? (
                <>
                  <Icon name="check" /> {t("transformations.correct")}
                </>
              ) : (
                <>
                  <Icon name="close" /> {t("transformations.incorrect")}
                  {question.correctAnswer && (
                    <span className="quiz-banner-answer">
                      （{t("transformations.correctAnswerIs")}: {question.correctAnswer}）
                    </span>
                  )}
                </>
              )}
            </span>
            <button
              type="button"
              className="btn xs quiz-retry-btn"
              onClick={onResetCurrent}
              title={t("transformations.tryAgain")}
            >
              <Icon name="retry" /> {t("transformations.tryAgain")}
            </button>
          </div>

          {(question.explanation || question.answer) && (
            <div className="quiz-banner-body assistant-body">
              <strong>{t("transformations.explanation")}</strong>
              <SafeMarkdown text={question.explanation || question.answer} />
            </div>
          )}
        </div>
      )}
    </article>
  );
}
