import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectDto } from "../../../../shared/projects";
import Modal, { DialogHead } from "../../ui/Modal";
import Icon from "../../ui/Icon";

export type ProjectDialogState =
  | { kind: "create" }
  | { kind: "rename"; project: ProjectDto }
  | { kind: "remove"; project: ProjectDto };

export function ProjectNameDialog({ state, busy, onSubmit, onClose }: {
  state: Extract<ProjectDialogState, { kind: "create" | "rename" }>;
  busy: boolean;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(state.kind === "rename" ? state.project.name : "");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
  const trimmed = name.trim();

  return (
    <Modal open onClose={onClose} labelledBy="project-dialog-title">
      <DialogHead id="project-dialog-title" icon={state.kind === "create" ? "book" : "edit"} accent title={t(state.kind === "create" ? "project.create" : "project.rename")} />
      <form onSubmit={(event) => { event.preventDefault(); if (trimmed) onSubmit(trimmed); }}>
        <label className="field" htmlFor="project-name-input">
          {t("project.nameLabel")}
          <input
            ref={inputRef}
            id="project-name-input"
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            required
            autoComplete="off"
          />
        </label>
        <div className="dialog-foot">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
          <button type="submit" className="btn primary" disabled={busy || !trimmed}>
            {busy ? <span className="spinner light" aria-hidden="true" /> : null}
            {t("common.confirm")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ProjectRemoveDialog({ project, busy, onConfirm, onClose }: {
  project: ProjectDto;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal open alert onClose={onClose} labelledBy="project-remove-title">
      <DialogHead id="project-remove-title" icon="trash" title={t("project.remove")} body={t("project.removeConfirm")} />
      <p className="remove-target"><Icon name="book" /> <strong>{project.name}</strong></p>
      <div className="dialog-foot">
        <button type="button" className="btn" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
        <button type="button" className="btn danger" disabled={busy} onClick={onConfirm}>
          {busy ? <span className="spinner light" aria-hidden="true" /> : <Icon name="trash" />}
          {t("common.confirm")}
        </button>
      </div>
    </Modal>
  );
}
