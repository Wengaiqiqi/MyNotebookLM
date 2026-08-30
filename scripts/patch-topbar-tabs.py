import io

def edit(path, pairs):
    s = io.open(path, encoding="utf-8").read()
    for old, new in pairs:
        assert old in s, (path, old[:70])
        s = s.replace(old, new, 1)
    io.open(path, "w", encoding="utf-8", newline="\n").write(s)

# Workspace: drop its header; section becomes a prop from the shell
edit("src/renderer/src/features/workspace/Workspace.tsx", [
("""export default function Workspace({ projectId, projectName, routes, onOpenSettings, onSourcesChanged }: {
  projectId: string;
  projectName: string;
  routes: DefaultModelRoutesDto;
  onOpenSettings: () => void;
  onSourcesChanged?: () => void;
}) {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>("research");""",
 """export default function Workspace({ projectId, section, onSectionChange, routes, onOpenSettings, onSourcesChanged }: {
  projectId: string;
  section: Section;
  onSectionChange: (section: Section) => void;
  routes: DefaultModelRoutesDto;
  onOpenSettings: () => void;
  onSourcesChanged?: () => void;
}) {
  const { t } = useTranslation();"""),
("""  const sections: Array<{ id: Section; icon: React.ComponentProps<typeof Icon>["name"]; label: string }> = [
    { id: "research", icon: "chat", label: t("workspace.research") },
    { id: "notes", icon: "notes", label: t("notes.titlePage") },
    { id: "studio", icon: "sparkle", label: t("workspace.studio") }
  ];

  return (
    <div className="workspace fade-in">
      <header className="workspace-head">
        <div style={{ minWidth: 0 }}>
          <h1>{projectName}</h1>
          <p className="sub">{t("workspace.subtitle")}</p>
        </div>
        <span className="spacer" />
        <nav className="tabs" role="tablist" aria-label={t("project.sections")}>
          {sections.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={section === item.id}
              onClick={() => setSection(item.id)}
            >
              <Icon name={item.icon} />
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      {section === "research" && (""",
 """  return (
    <div className="workspace fade-in">
      {section === "research" && ("""),
])
# project-name prop is no longer used by Workspace
edit("src/renderer/src/features/workspace/Workspace.tsx", [
("""                <Workspace
                  key={selectedProject.id}
                  projectId={selectedProject.id}
                  projectName={selectedProject.name}
                  routes={routes}""",
 """                <Workspace
                  key={selectedProject.id}
                  projectId={selectedProject.id}
                  section={section}
                  onSectionChange={setSection}
                  routes={routes}"""),
])

# App: section state + tabs live in the topbar row
edit("src/renderer/src/App.tsx", [
("""import Sidebar from "./features/sidebar/Sidebar";
import Workspace from "./features/workspace/Workspace";""",
 """import Sidebar from "./features/sidebar/Sidebar";
import Workspace, { type Section } from "./features/workspace/Workspace";"""),
("""  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<ProjectDialogState>();""",
 """  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<ProjectDialogState>();
  const [section, setSection] = useState<Section>("research");"""),
("""            <header className="topbar drag">
              <span className="crumb"><b>{t("app.name")}</b>{crumb ? ` / ${crumb}` : ""}</span>
              <span className="spacer" />
            </header>""",
 """            <header className="topbar drag">
              {view === "app" && !settingsOpen && selectedProject && !selectedProject.archived && selectedProject.status === "active" ? (
                <nav className="tabs" role="tablist" aria-label={t("project.sections")}>
                  {([
                    ["research", "chat", t("workspace.research")],
                    ["notes", "notes", t("notes.titlePage")],
                    ["studio", "sparkle", t("workspace.studio")]
                  ] as const).map(([id, icon, label]) => (
                    <button key={id} type="button" role="tab" aria-selected={section === id} onClick={() => setSection(id)}>
                      <Icon name={icon} />
                      {label}
                    </button>
                  ))}
                </nav>
              ) : (
                <span className="crumb"><b>{t("app.name")}</b>{crumb ? ` / ${crumb}` : ""}</span>
              )}
              <span className="spacer" />
            </header>"""),
])

# CSS: trim dead workspace-head spacing
edit("src/renderer/src/styles.css", [
(""".workspace { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 14px 18px 18px; gap: 12px; }
.workspace-head { display: flex; align-items: center; gap: 14px; min-height: 44px; }
.workspace-head h1 { font-size: 21px; font-weight: 700; letter-spacing: -.02em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace-head .sub { color: var(--ink-3); font-size: 12.5px; margin-top: 1px; }
.workspace-head .spacer { flex: 1; }""",
 """.workspace { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 12px 18px 16px; gap: 12px; }"""),
])
print("ok")
