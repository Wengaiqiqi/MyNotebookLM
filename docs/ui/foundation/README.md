# Foundation UI Visual Contract

Approved screens: first launch, empty project, project list, create project, and model settings.

Layout: left project navigation, central workspace, source citations on the right where relevant, and settings in the navigation footer.

Palette: warm off-white surfaces, charcoal text, restrained indigo accent.

Themes: light and dark use identical information hierarchy. After onboarding, the sidebar footer presents centered `中文 | EN` and `浅色 | 深色` text selectors with matching visual treatment.

Model configuration:

- Generation and embedding models use the same provider-first flow.
- Selecting a provider supplies its default API address; `API 地址` remains directly editable and does not display an automatic-match notice.
- The user supplies `API Key` when the provider requires one.
- `获取成功` appears beside `获取模型` only after a successful model-list request.
- Each model may be selected from the fetched dropdown or entered manually.
- The settings center can change both generation and embedding configuration after onboarding.

Window chrome: the application surface extends through the title area. Native Windows minimize, maximize, and close controls are embedded into that surface without a separate title-bar color band.

Project interactions: rename, archive, and delete are available from a project overflow menu. Every create, rename, delete, and confirmation dialog is centered against the complete application viewport with a full-window dimmed backdrop.

Implementation must be compared with these images using a real Windows screenshot. No podcast, audio, speech, or microphone interface is part of the approved product.
