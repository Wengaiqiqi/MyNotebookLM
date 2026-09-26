import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { modelOutputKind, type ModelProfileDto, type SpeechVoices, type SpeechVoiceDescriptor } from "../../../../shared/models";
import Icon from "../../ui/Icon";
import RoundedSelect from "../../ui/RoundedSelect";

export default function PodcastVoices({ disabled, onReadyChange }: { disabled: boolean; onReadyChange: (ready: boolean) => void }) {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<ModelProfileDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failure, setFailure] = useState("");
  const [ready, setReady] = useState<Record<string, boolean>>({});
  const updateReady = useCallback((id: string, value: boolean) => setReady((current) => current[id] === value ? current : { ...current, [id]: value }), []);
  const updateProfile = useCallback((profile: ModelProfileDto) => setProfiles((current) => current.map((item) => item.id === profile.id ? profile : item)), []);

  useEffect(() => {
    let alive = true;
    void Promise.all([window.myNotebook.models.listProfiles(), window.myNotebook.models.getRoutes?.({ taskKind: "podcast" })]).then(([listed, routes]) => {
      if (!alive) return;
      if (!listed.ok || !routes?.ok) { setFailure(!listed.ok ? listed.error.messageKey : routes && !routes.ok ? routes.error.messageKey : "errors.podcastRouteMissing"); return; }
      const routed = [...routes.value].sort((a, b) => a.position - b.position).map((route) => listed.value.profiles.find((profile) => profile.id === route.profileId));
      setProfiles(routed.filter((profile): profile is ModelProfileDto => !!profile && profile.enabled && profile.capability === "generation" && modelOutputKind(profile) === "speech"));
      if (!routed.some((profile) => profile?.enabled && profile.capability === "generation" && modelOutputKind(profile) === "text")) setFailure("errors.podcastRouteMissing");
    }).catch(() => { if (alive) setFailure("errors.internal"); }).finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, []);

  useEffect(() => { onReadyChange(loaded && !failure && profiles.length > 0 && profiles.every((profile) => ready[profile.id])); }, [loaded, failure, profiles, ready, onReadyChange]);

  return <div className="podcast-voices">
    {!loaded && <span className="hint"><span className="spinner sm" aria-hidden="true" />{t("model.fetchingVoices")}</span>}
    {(failure || (loaded && !profiles.length)) && <span className="form-error" role="status">{t(failure || "errors.podcastRouteMissing")}</span>}
    {profiles.map((profile) => <SpeechVoiceFields key={profile.id} profile={profile} disabled={disabled} onReadyChange={updateReady} onSaved={updateProfile} />)}
  </div>;
}

function SpeechVoiceFields({ profile, disabled, onReadyChange, onSaved }: {
  profile: ModelProfileDto; disabled: boolean; onReadyChange: (id: string, ready: boolean) => void; onSaved: (profile: ModelProfileDto) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState<SpeechVoices>(profile.speechVoices ?? { A: "", B: "" });
  const [catalog, setCatalog] = useState<SpeechVoiceDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [manual, setManual] = useState({ A: false, B: false });
  const [failure, setFailure] = useState("");
  const [saveFailure, setSaveFailure] = useState("");
  const [refresh, setRefresh] = useState(0);
  const { id, provider, baseUrl, modelId } = profile;
  const valid = !!value.A.trim() && !!value.B.trim();
  const changed = value.A.trim() !== profile.speechVoices?.A || value.B.trim() !== profile.speechVoices?.B;

  useEffect(() => {
    let alive = true;
    setLoading(true); setFailure("");
    void window.myNotebook.models.discoverVoices({ profileId: id, provider: provider as "openai" | "openai-compatible" | "gemini", capability: "generation", baseUrl, modelId }).then((result) => {
      if (!alive) return;
      if (!result.ok) { setFailure(result.error.messageKey); setManual({ A: true, B: true }); return; }
      setCatalog(result.value);
      if (!result.value.length) setManual({ A: true, B: true });
      if (result.value.length) setValue((current) => ({ A: current.A || result.value[0]!.id, B: current.B || (result.value[1] ?? result.value[0])!.id }));
    }).catch(() => { if (alive) { setFailure("errors.internal"); setManual({ A: true, B: true }); } }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [id, provider, baseUrl, modelId, refresh]);

  useEffect(() => {
    if (!valid || !changed) return;
    let alive = true;
    void (async () => {
      const { createdAt: _created, updatedAt: _updated, generationLimits: _limits, contextTokensOverride: _context, maxOutputTokensOverride: _output, ...input } = profile;
      const result = await window.myNotebook.models.saveProfile({ profile: { ...input, speechVoices: { A: value.A.trim(), B: value.B.trim() } } }).catch(() => undefined);
      if (!alive) return;
      if (result?.ok) { setSaveFailure(""); onSaved(result.value); }
      else setSaveFailure(result && !result.ok ? result.error.messageKey : "errors.internal");
    })();
    return () => { alive = false; };
  }, [valid, changed, value, profile, onSaved, refresh]);

  useEffect(() => { onReadyChange(id, !loading && valid && !changed && !saveFailure); }, [id, loading, valid, changed, saveFailure, onReadyChange]);

  return <div className="field podcast-voice-fields">
    <div className="input-row">
      <span>{t("model.podcastVoices")} · {modelId}</span>
      <button type="button" className="btn outline" disabled={disabled || loading} onClick={() => { setSaveFailure(""); setRefresh((previous) => previous + 1); }}>
        {loading ? <span className="spinner" aria-hidden="true" /> : <Icon name="retry" />}{loading ? t("model.fetchingVoices") : t("model.getVoices")}
      </button>
    </div>
    {!loading && !catalog.length && <span className="hint">{t("model.noVoiceCatalog")}</span>}
    {(saveFailure || failure) && <span className="form-error" role="status">{t(saveFailure || failure)}</span>}
    {(["A", "B"] as const).map((speaker) => {
      const label = `${t("model.speakerVoice", { speaker })} · ${modelId}`;
      const selected = value[speaker];
      const options = [{ value: "", label: t("model.selectVoice") }, ...catalog.map((voice) => ({ value: voice.id, label: `${voice.name}${voice.language ? ` · ${voice.language}` : ""}` }))];
      if (selected && !catalog.some((voice) => voice.id === selected)) options.push({ value: selected, label: selected });
      const change = (voice: string) => { setSaveFailure(""); setValue((current) => ({ ...current, [speaker]: voice })); };
      return <div className="field" key={speaker} role="group" aria-label={t("model.speakerVoice", { speaker })}>
        <span>{t("model.speakerVoice", { speaker })}</span>
        <div className="input-row podcast-voice-row">
          {manual[speaker] || !catalog.length ? <input className="input" aria-label={label} disabled={disabled || loading} value={selected} placeholder={t("model.voiceId")} maxLength={200} onChange={(event) => change(event.target.value)} />
            : <RoundedSelect ariaLabel={label} disabled={disabled || loading} value={selected} options={options} onChange={change} />}
          <button type="button" className="btn" disabled={disabled || loading || !catalog.length} aria-label={`${t(manual[speaker] ? "model.chooseVoice" : "model.enterVoiceId")} · ${t("model.speakerVoice", { speaker })}`}
            onClick={() => setManual((current) => ({ ...current, [speaker]: !current[speaker] }))}>{t(manual[speaker] ? "model.chooseVoice" : "model.enterVoiceId")}</button>
        </div>
      </div>;
    })}
  </div>;
}
