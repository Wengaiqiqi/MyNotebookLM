import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

export default function PodcastPlayer({ projectId, insightId }: { projectId: string; insightId: string }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true, objectUrl = "";
    setUrl(""); setError("");
    void api().transformations.getAudio({ projectId, insightId }).then((result) => {
      if (!alive) return;
      if (!result.ok) { setError(result.error.messageKey); return; }
      const bytes = Uint8Array.from(atob(result.value.data), (character) => character.charCodeAt(0));
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: result.value.mimeType }));
      setUrl(objectUrl);
    }).catch(() => { if (alive) setError("errors.podcastAudioUnavailable"); });
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [projectId, insightId, retry]);
  if (error) return <div role="alert"><p>{t(error)}</p><button type="button" className="btn" onClick={() => setRetry((value) => value + 1)}>{t("common.retry")}</button></div>;
  if (!url) return <p role="status">{t("common.loading")}</p>;
  return <div style={{ display: "grid", gap: 8, marginBottom: 16 }}>
    <small>{t("transformations.podcastSynthetic")}</small>
    <audio controls preload="metadata" src={url} aria-label={t("transformations.podcastPlayer")} style={{ width: "100%" }} onError={() => setError("errors.podcastAudioUnavailable")} />
    <a className="btn ghost sm" href={url} download={`podcast-${insightId}.wav`}>{t("transformations.downloadAudio")}</a>
  </div>;
}
