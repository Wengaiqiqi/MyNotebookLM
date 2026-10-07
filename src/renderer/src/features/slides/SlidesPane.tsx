import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SLIDE_LAYOUTS, SLIDE_THEMES, SLIDE_THEME_COLORS, slideDeckSchema, type Slide, type SlideDeck, type SlideLayout, type SlideTheme } from "../../../../shared/slides";
import type { SourceDto } from "../../../../shared/sources";
import type { TaskDto } from "../../../../shared/tasks";
import Icon from "../../ui/Icon";
import RoundedSelect from "../../ui/RoundedSelect";
import { toast } from "../../ui/Toast";
import { useTaskFeed } from "../../hooks/useTaskFeed";
import { api } from "../../lib/api";
import { errorText, formatDateTime, sourceReady } from "../../lib/format";
import { textStepProgress } from "../studio/progress-motion";
import { downloadMindMap as downloadBlob } from "../studio/MindMapViewer";
import type { AppLanguage } from "../../i18n";

type Deck = { id: string; createdAt: string; model: string | null; deck: SlideDeck };
type SaveState = "idle" | "saving" | "saved" | "failed";

const hex = (color: string): string => `#${color}`;

function parseDeck(content: string): SlideDeck | null {
  try {
    const result = slideDeckSchema.safeParse(JSON.parse(content));
    return result.success ? result.data : null;
  } catch { return null; }
}

/** One slide on a 16:9 canvas; editable on the main stage, static in thumbnails. */
function SlideView({ slide, theme, onChange }: { slide: Slide; theme: SlideTheme; onChange?: (slide: Slide) => void }) {
  const { t } = useTranslation();
  const color = SLIDE_THEME_COLORS[theme];
  const style = { "--slide-bg": hex(color.background), "--slide-title": hex(color.title), "--slide-text": hex(color.text),
    "--slide-accent": hex(color.accent), "--slide-muted": hex(color.muted) } as React.CSSProperties;
  const set = (patch: Partial<Slide>): void => onChange?.({ ...slide, ...patch });
  const title = onChange
    ? <textarea className="slide-title" rows={1} value={slide.title} placeholder={t("slides.titlePlaceholder")} aria-label={t("slides.slideTitle")} onChange={(event) => set({ title: event.target.value })} />
    : <div className="slide-title">{slide.title}</div>;
  const lines = (key: "bullets" | "right", placeholder: string) => onChange
    ? <LinesEditor lines={slide[key]} placeholder={placeholder} onChange={(next) => set({ [key]: next })} />
    : <ul className="slide-lines">{slide[key].filter((line) => line.trim()).map((line, index) => <li key={index}>{line}</li>)}</ul>;
  const cover = slide.layout === "title" || slide.layout === "section";
  return (
    <div className={`slide-canvas layout-${slide.layout}${onChange ? " editable" : ""}`} style={style}>
      <div className="slide-frame">
        {slide.layout === "section" && <i className="slide-band" />}
        {slide.layout === "title" && <i className="slide-rule" />}
        {title}
        {!cover && <i className="slide-underline" />}
        {cover
          ? onChange
            ? <textarea className="slide-subtitle" value={slide.bullets.join("\n")} placeholder={t("slides.subtitlePlaceholder")} onChange={(event) => set({ bullets: event.target.value.split("\n") })} />
            : <div className="slide-subtitle">{slide.bullets.filter((line) => line.trim()).join("\n")}</div>
          : <div className="slide-body">
            {lines("bullets", t("slides.bulletPlaceholder"))}
            {slide.layout === "two-column" && <><i className="slide-divider" />{lines("right", t("slides.rightPlaceholder"))}</>}
          </div>}
      </div>
    </div>
  );
}

/** Bullet list where each line is its own box: Enter adds a line, Backspace on an empty line removes it. */
function LinesEditor({ lines, placeholder, onChange }: { lines: string[]; placeholder: string; onChange: (lines: string[]) => void }) {
  const items = lines.length ? lines : [""];
  const refs = useRef<Array<HTMLTextAreaElement | null>>([]);
  const focusAt = useRef<number | null>(null);
  useEffect(() => {
    if (focusAt.current === null) return;
    refs.current[focusAt.current]?.focus();
    focusAt.current = null;
  });
  return (
    <ul className="slide-lines">
      {items.map((line, index) => (
        <li key={index}>
          <textarea ref={(node) => { refs.current[index] = node; }} rows={1} value={line} placeholder={index === 0 ? placeholder : ""}
            onChange={(event) => onChange(items.map((item, at) => at === index ? event.target.value.replace(/\n/g, " ") : item))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (items.length >= 20) return;
                focusAt.current = index + 1;
                onChange([...items.slice(0, index + 1), "", ...items.slice(index + 1)]);
              } else if (event.key === "Backspace" && line === "" && items.length > 1) {
                event.preventDefault();
                focusAt.current = Math.max(0, index - 1);
                onChange(items.filter((_item, at) => at !== index));
              }
            }} />
        </li>
      ))}
    </ul>
  );
}

export default function SlidesPane({ projectId, sources }: { projectId: string; sources: SourceDto[] }) {
  const { t, i18n } = useTranslation();
  const language: AppLanguage = i18n.resolvedLanguage === "en" ? "en" : "zh-CN";
  const [decks, setDecks] = useState<Deck[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [slideIndex, setSlideIndex] = useState(0);
  const [picked, setPicked] = useState<string[] | null>(null); // null = every ready source
  const [starting, setStarting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const pending = useRef<{ insightId: string; deck: SlideDeck } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const readySources = useMemo(() => sources.filter(sourceReady), [sources]);
  const revisionIds = readySources.map((source) => source.currentRevisionId!).filter((id) => picked === null || picked.includes(id));

  const flush = useCallback(async (): Promise<void> => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const next = pending.current;
    pending.current = null;
    if (!next) return;
    setSaveState("saving");
    const result = await api().transformations.saveSlides({ projectId, ...next }).catch(() => undefined);
    // A newer edit queued meanwhile owns the indicator.
    if (!pending.current) setSaveState(result?.ok ? "saved" : "failed");
  }, [projectId]);

  const loadDecks = useCallback(async (selectNewest = false): Promise<void> => {
    await flush();
    const items: Deck[] = [];
    for (let offset = 0; ; offset += 100) {
      const result = await api().transformations.listInsights({ projectId, limit: 100, offset }).catch(() => undefined);
      if (!result?.ok) return;
      for (const insight of result.value) {
        const deck = insight.builtinKey === "slides" ? parseDeck(insight.content) : null;
        if (deck) items.push({ id: insight.id, createdAt: insight.createdAt, model: insight.model, deck });
      }
      if (result.value.length < 100) break;
    }
    setDecks(items);
    setSelectedId((current) => selectNewest || !items.some((item) => item.id === current) ? items[0]?.id ?? null : current);
    if (selectNewest) setSlideIndex(0);
  }, [projectId, flush]);

  useEffect(() => {
    setDecks([]); setSelectedId(null); setPicked(null);
    void loadDecks();
    return () => { void flush(); };
  }, [projectId, loadDecks, flush]);

  const feed = useTaskFeed(projectId, window.myNotebook.tasks?.subscribe, window.myNotebook.tasks?.list);
  const task: TaskDto | undefined = feed.find((item) => item.kind === "transformation" && item.transformationKind === "slides");
  const finished = task?.state === "completed" ? `${task.id}:${task.updatedAt}` : "";
  const seenFinished = useRef<string | null>(null);
  useEffect(() => {
    // The first value is history; only a run completing while open selects its deck.
    if (seenFinished.current !== null && finished && finished !== seenFinished.current) void loadDecks(true);
    seenFinished.current = finished;
  }, [finished, loadDecks]);

  const active = starting || task?.state === "queued" || task?.state === "running";
  const current = decks.find((item) => item.id === selectedId) ?? null;
  const slides = current?.deck.slides ?? [];
  const index = Math.min(slideIndex, Math.max(0, slides.length - 1));
  const slide = slides[index];

  async function generate(): Promise<void> {
    if (active || revisionIds.length === 0) return;
    setStarting(true);
    const result = await api().transformations.run({ projectId, builtinKey: "slides", language, force: true, sourceRevisionIds: revisionIds }).catch(() => undefined);
    setStarting(false);
    if (!result?.ok) toast.error(result ? errorText(result, t) : t("errors.internal"));
  }

  async function control(action: "cancel" | "retry"): Promise<void> {
    if (!task) return;
    const result = await api().transformations[action]({ projectId, taskId: task.id }).catch(() => undefined);
    if (!result?.ok) toast.error(result ? errorText(result, t) : t("errors.internal"));
  }

  function edit(change: (deck: SlideDeck) => SlideDeck): void {
    if (!current) return;
    const deck = change(current.deck);
    setDecks((items) => items.map((item) => item.id === current.id ? { ...item, deck } : item));
    pending.current = { insightId: current.id, deck };
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush(), 600);
  }

  const editSlides = (change: (slides: Slide[]) => Slide[], nextIndex?: number): void => {
    edit((deck) => ({ ...deck, slides: change(deck.slides) }));
    if (nextIndex !== undefined) setSlideIndex(nextIndex);
  };
  const newSlide = (): Slide => ({ id: crypto.randomUUID(), layout: "bullets", title: t("slides.newSlide"), bullets: [], right: [], notes: "" });
  const move = (offset: number): void => editSlides((items) => {
    const next = [...items];
    [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
    return next;
  }, index + offset);

  async function exportDeck(): Promise<void> {
    if (!current || exporting) return;
    setExporting(true);
    try {
      const { exportPptx } = await import("./export-pptx");
      downloadBlob(await exportPptx(current.deck), current.deck.title, "pptx");
    } catch {
      toast.error(t("slides.exportFailed"));
    } finally { setExporting(false); }
  }

  async function deleteDeck(id: string): Promise<void> {
    if (pending.current?.insightId === id) { pending.current = null; if (saveTimer.current) clearTimeout(saveTimer.current); }
    const result = await api().transformations.deleteInsight({ projectId, insightId: id }).catch(() => undefined);
    if (!result?.ok) { toast.error(result ? errorText(result, t) : t("errors.internal")); return; }
    setDecks((items) => items.filter((item) => item.id !== id));
    if (selectedId === id) setSelectedId(decks.find((item) => item.id !== id)?.id ?? null);
  }

  const step = task && !starting ? textStepProgress(task.stage, task.progress) : null;
  const taskState = starting ? "queued" : task?.state;
  const showTask = starting || taskState === "queued" || taskState === "running" || taskState === "failed";

  return (
    <div className="pane slides">
      <section className="panel slides-side" aria-label={t("slides.title")}>
        <header className="panel-head"><h2>{t("slides.generateTitle")}</h2></header>
        <div className="slides-generate">
          {readySources.length === 0 ? <p className="hint">{t("slides.noSources")}</p> : (
            <div className="slides-sources" role="group" aria-label={t("slides.sources")}>
              {readySources.map((source) => {
                const id = source.currentRevisionId!;
                const checked = picked === null || picked.includes(id);
                return <label key={id} className="slides-source">
                  <input type="checkbox" checked={checked} onChange={() => setPicked((current) => {
                    const all = current ?? readySources.map((item) => item.currentRevisionId!);
                    return checked ? all.filter((item) => item !== id) : [...all, id];
                  })} />
                  <span>{source.displayName}</span>
                </label>;
              })}
            </div>
          )}
          <div className="run-actions">
            <button type="button" className="btn primary" disabled={active || revisionIds.length === 0} onClick={() => void generate()}>
              {active ? <span className="spinner light" aria-hidden="true" /> : <Icon name="sparkle" />}{t("slides.generate")}
            </button>
            {taskState === "failed" && <button type="button" className="btn" onClick={() => void control("retry")}><Icon name="retry" />{t("transformations.retry")}</button>}
            {task && (task.state === "queued" || task.state === "running") && <button type="button" className="btn" onClick={() => void control("cancel")}>{t("common.cancel")}</button>}
          </div>
          {showTask && (
            <div className={`task-card is-${taskState}`} role="status">
              <div className="task-card-header">
                <div className="task-card-status">
                  <span className={`task-status-icon ${taskState}`}>{taskState === "failed" ? <Icon name="close" /> : <span className="spinner sm" />}</span>
                  <strong>{taskState === "running" && step ? t(`transformations.phases.${step.steps[step.index]}`) : t(`transformations.states.${taskState}`)}</strong>
                </div>
                {step && taskState === "running" && <span className="task-card-meta"><span className="task-card-step">{t("transformations.stepCount", { current: step.index + 1, total: step.steps.length })}</span></span>}
              </div>
              <div className={`progress${taskState === "failed" ? " danger" : " running indeterminate"}`}><i /></div>
              {!starting && task?.error && <p className="err" role="alert">{t(task.error.messageKey, task.error.messageKey)}</p>}
            </div>
          )}
        </div>
        <header className="panel-head"><h2>{t("slides.decks")}</h2><span className="count">{decks.length}</span></header>
        <div className="panel-body slides-decks">
          {decks.length === 0 ? <p className="hint">{t("slides.noDecks")}</p> : decks.map((item) => (
            <div key={item.id} className={`slides-deck${item.id === selectedId ? " selected" : ""}`}>
              <button type="button" className="slides-deck-open" aria-current={item.id === selectedId} onClick={() => { void flush(); setSelectedId(item.id); setSlideIndex(0); }}>
                <strong>{item.deck.title || t("slides.untitled")}</strong>
                <small>{t("slides.slideCount", { count: item.deck.slides.length })} · {formatDateTime(item.createdAt, language)}</small>
              </button>
              <button type="button" className="btn ghost icon sm" aria-label={`${t("common.delete")}: ${item.deck.title}`} onClick={() => void deleteDeck(item.id)}><Icon name="trash" /></button>
            </div>
          ))}
        </div>
      </section>

      <section className="panel slides-editor" aria-label={t("slides.editor")}>
        {!current || !slide ? (
          <div className="empty"><span className="glyph" aria-hidden="true"><Icon name="slides" /></span><p>{t("slides.selectDeck")}</p></div>
        ) : <>
          <header className="panel-head slides-toolbar">
            <input className="input slides-deck-title" value={current.deck.title} maxLength={300} aria-label={t("slides.deckTitle")}
              onChange={(event) => edit((deck) => ({ ...deck, title: event.target.value }))} />
            <RoundedSelect value={current.deck.theme} ariaLabel={t("slides.theme")}
              options={SLIDE_THEMES.map((theme) => ({ value: theme, label: t(`slides.themes.${theme}`) }))}
              onChange={(theme) => edit((deck) => ({ ...deck, theme: theme as SlideTheme }))} />
            <span className="slides-save-state" aria-live="polite">{saveState === "idle" ? "" : t(`slides.save.${saveState}`)}</span>
            <span className="spacer" />
            <button type="button" className="btn primary sm" disabled={exporting} onClick={() => void exportDeck()}>
              {exporting ? <span className="spinner light" aria-hidden="true" /> : <Icon name="download" />}{t("slides.export")}
            </button>
          </header>
          <div className="slides-workarea">
            <ol className="slides-thumbs" aria-label={t("slides.list")}>
              {slides.map((item, at) => (
                <li key={item.id}>
                  <button type="button" className={at === index ? "selected" : ""} aria-current={at === index} aria-label={t("slides.slideLabel", { index: at + 1 })} onClick={() => setSlideIndex(at)}>
                    <span className="slides-thumb-no">{at + 1}</span>
                    <SlideView slide={item} theme={current.deck.theme} />
                  </button>
                </li>
              ))}
            </ol>
            <div className="slides-stage">
              <div className="slides-slide-tools">
                <RoundedSelect value={slide.layout} ariaLabel={t("slides.layout")}
                  options={SLIDE_LAYOUTS.map((layout) => ({ value: layout, label: t(`slides.layouts.${layout}`) }))}
                  onChange={(layout) => editSlides((items) => items.map((item, at) => at === index ? { ...item, layout: layout as SlideLayout } : item))} />
                <span className="spacer" />
                <button type="button" className="btn ghost sm" disabled={slides.length >= 100} onClick={() => editSlides((items) => [...items.slice(0, index + 1), newSlide(), ...items.slice(index + 1)], index + 1)}><Icon name="plus" />{t("slides.addSlide")}</button>
                <button type="button" className="btn ghost sm" disabled={slides.length >= 100} onClick={() => editSlides((items) => [...items.slice(0, index + 1), { ...slide, id: crypto.randomUUID() }, ...items.slice(index + 1)], index + 1)}><Icon name="copy" />{t("slides.duplicate")}</button>
                <button type="button" className="btn ghost icon sm" aria-label={t("slides.moveUp")} disabled={index === 0} onClick={() => move(-1)}><Icon name="arrow-up" /></button>
                <button type="button" className="btn ghost icon sm" aria-label={t("slides.moveDown")} disabled={index >= slides.length - 1} onClick={() => move(1)}><Icon name="arrow-down" /></button>
                <button type="button" className="btn danger-soft sm" disabled={slides.length <= 1} onClick={() => editSlides((items) => items.filter((_item, at) => at !== index), Math.max(0, index - 1))}><Icon name="trash" />{t("slides.deleteSlide")}</button>
              </div>
              <SlideView key={slide.id} slide={slide} theme={current.deck.theme} onChange={(next) => editSlides((items) => items.map((item, at) => at === index ? next : item))} />
              <label className="field slides-notes">
                {t("slides.notes")}
                <textarea className="textarea" value={slide.notes} maxLength={8000} placeholder={t("slides.notesPlaceholder")}
                  onChange={(event) => editSlides((items) => items.map((item, at) => at === index ? { ...item, notes: event.target.value } : item))} />
              </label>
            </div>
          </div>
        </>}
      </section>
    </div>
  );
}
