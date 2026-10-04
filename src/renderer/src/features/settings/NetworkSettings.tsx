import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { proxyUrlSchema, type AppSettingsDto, type ProxyMode, type UpdateAppSettingsInput } from "../../../../shared/settings";
import { toast } from "../../ui/Toast";

const MODES: ProxyMode[] = ["system", "direct", "manual"];

/** Proxy used for model services and model downloads. */
export default function NetworkSettings() {
  const { t } = useTranslation();
  const [saved, setSaved] = useState<AppSettingsDto>();
  const [mode, setMode] = useState<ProxyMode>("system");
  const [proxyUrl, setProxyUrl] = useState("");
  const [bypass, setBypass] = useState("");

  useEffect(() => {
    let active = true;
    void window.myNotebook.settings.get().then((result) => {
      if (!active || !result.ok) return;
      setSaved(result.value);
      setMode(result.value.proxyMode);
      setProxyUrl(result.value.proxyUrl);
      setBypass(result.value.proxyBypass);
    });
    return () => { active = false; };
  }, []);

  const save = async (input: UpdateAppSettingsInput) => {
    const result = await window.myNotebook.settings.update(input);
    if (result.ok) setSaved(result.value);
    else toast.error(t(result.error.messageKey));
  };
  const urlValid = proxyUrl.trim() !== "" && proxyUrlSchema.safeParse(proxyUrl).success;

  const selectMode = (next: ProxyMode) => {
    setMode(next);
    // Manual mode is saved once a valid address is entered.
    if (next !== "manual") void save({ proxyMode: next });
    else if (urlValid) void save({ proxyMode: next, proxyUrl: proxyUrl.trim() });
  };
  const saveUrl = () => {
    if (!urlValid || (saved?.proxyMode === "manual" && saved.proxyUrl === proxyUrl.trim())) return;
    void save({ proxyMode: "manual", proxyUrl: proxyUrl.trim() });
  };
  const saveBypass = () => {
    if (saved && saved.proxyBypass !== bypass) void save({ proxyBypass: bypass });
  };

  if (!saved) return null;
  return (
    <div className="pref-card card">
      <h3>{t("settings.network.title")}</h3>
      <div className="pref-row">
        <span className="copy"><strong>{t("settings.network.mode")}</strong><small>{t(`settings.network.modeHint.${mode}`)}</small></span>
        <div className="seg" role="group" aria-label={t("settings.network.mode")}>
          {MODES.map((item) => (
            <button key={item} type="button" aria-pressed={mode === item} onClick={() => selectMode(item)}>{t(`settings.network.modes.${item}`)}</button>
          ))}
        </div>
      </div>
      {mode === "manual" && (
        <label className="field" htmlFor="network-proxy-url">
          {t("settings.network.proxyUrl")}
          <input
            id="network-proxy-url"
            className="input"
            value={proxyUrl}
            placeholder="http://127.0.0.1:7890"
            aria-invalid={proxyUrl.trim() !== "" && !urlValid}
            onChange={(event) => setProxyUrl(event.target.value)}
            onBlur={saveUrl}
          />
          <span className="hint">{proxyUrl.trim() !== "" && !urlValid ? t("settings.network.proxyUrlInvalid") : t("settings.network.proxyUrlHint")}</span>
        </label>
      )}
      {mode !== "direct" && (
        <label className="field" htmlFor="network-proxy-bypass">
          {t("settings.network.bypass")}
          <textarea
            id="network-proxy-bypass"
            className="textarea"
            rows={3}
            value={bypass}
            placeholder="api.deepseek.com, *.aliyuncs.com"
            onChange={(event) => setBypass(event.target.value)}
            onBlur={saveBypass}
          />
          <span className="hint">{t("settings.network.bypassHint")}</span>
        </label>
      )}
    </div>
  );
}
