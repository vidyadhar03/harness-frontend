"use client";
import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ArrowUpRight,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Clapperboard,
  Compass,
  FileText,
  Image as ImageIcon,
  Layers,
  Lock,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelRightClose,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Upload,
  X,
  Download,
  MapPin,
  LoaderCircle,
  Pencil,
  FolderOpen,
} from "lucide-react";
import {
  initial,
  readWorkspace,
  saveWorkspace,
  uid,
  type Workspace,
  type Location,
  type Reference,
  type Concept,
} from "../lib/model";
import { apiBase, request } from "../lib/api";
import ConnectedStudio from "./ConnectedStudio";
type Tab = "brief" | "references" | "concept";
type Modal =
  "add" | "rename" | "merge" | "lock" | "connection" | "sources" | null;
export default function Studio() {
  return apiBase ? <ConnectedStudio /> : <LocalStudio />;
}
function LocalStudio() {
  const [ws, setWs] = useState<Workspace>(initial),
    [ready, setReady] = useState(false),
    [tab, setTab] = useState<Tab>("references"),
    [chat, setChat] = useState(true),
    [sidebar, setSidebar] = useState(true),
    [filter, setFilter] = useState("All references"),
    [search, setSearch] = useState(""),
    [modal, setModal] = useState<Modal>(null),
    [name, setName] = useState(""),
    [mergeTarget, setMergeTarget] = useState(""),
    [text, setText] = useState(""),
    [notice, setNotice] = useState(""),
    [saveError, setSaveError] = useState(""),
    [detail, setDetail] = useState<Reference | null>(null),
    [preview, setPreview] = useState<Concept | null>(null),
    [menu, setMenu] = useState(false),
    [sending, setSending] = useState(false),
    [busy, setBusy] = useState("");
  const uploadRef = useRef<HTMLInputElement>(null),
    uploadConcept = useRef<HTMLInputElement>(null),
    dialog = useRef<HTMLDialogElement>(null),
    bottom = useRef<HTMLDivElement>(null),
    saveChain = useRef(Promise.resolve());
  const loc = ws.locations.find((l) => l.id === ws.active) ?? ws.locations[0];
  const selected = loc.refs.filter((r) => r.selected);
  useEffect(() => {
    if (window.innerWidth < 960) setChat(false);
    if (window.innerWidth < 650) setSidebar(false);
  }, []);
  useEffect(() => {
    readWorkspace()
      .then((v) => {
        if (v?.locations?.length) setWs(v);
      })
      .catch(() =>
        setSaveError(
          "Browser storage is unavailable. Keep this tab open and export your decisions.",
        ),
      )
      .finally(() => setReady(true));
  }, []);
  useEffect(() => {
    if (ready) {
      saveChain.current = saveChain.current
        .then(() => saveWorkspace(ws))
        .then(() => setSaveError(""))
        .catch(() =>
          setSaveError(
            "Changes could not be saved. Export your decisions before closing this tab.",
          ),
        );
    }
  }, [ws, ready]);
  useEffect(() => {
    if (modal || detail || preview) dialog.current?.showModal();
    else dialog.current?.close();
  }, [modal, detail, preview]);
  useEffect(() => {
    if (notice) {
      const t = setTimeout(() => setNotice(""), 5000);
      return () => clearTimeout(t);
    }
  }, [notice]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [ws.messages, sending]);
  function patchFor(id: string, fn: (l: Location) => Location) {
    setWs((s) => ({
      ...s,
      locations: s.locations.map((l) => (l.id === id ? fn(l) : l)),
    }));
  }
  function patch(p: Partial<Location>) {
    patchFor(loc.id, (l) => ({ ...l, ...p }));
  }
  function select(r: Reference) {
    patch({
      refs: loc.refs.map((a) =>
        a.id === r.id ? { ...a, selected: !a.selected } : a,
      ),
    });
  }
  function close() {
    setModal(null);
    setDetail(null);
    setPreview(null);
  }
  function switchLoc(id: string) {
    setWs((s) => ({ ...s, active: id }));
    setFilter("All references");
    setMenu(false);
  }
  async function upload(files: FileList | null, kind: "reference" | "concept") {
    if (!files) return;
    const scope = loc.id;
    for (const f of Array.from(files)) {
      if (
        !["image/jpeg", "image/png", "image/webp"].includes(f.type) ||
        f.size > 10 * 1024 * 1024
      ) {
        setNotice("Choose a JPG, PNG or WebP image under 10 MB.");
        continue;
      }
      const image = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result));
        r.onerror = rej;
        r.readAsDataURL(f);
      });
      if (kind === "reference")
        patchFor(scope, (l) => ({
          ...l,
          refs: [
            ...l.refs,
            {
              id: uid(),
              title: f.name.replace(/\.[^.]+$/, ""),
              image,
              category: "Uploaded",
              reason:
                "Your reference. Add a note about what you want to borrow.",
              selected: false,
              guidance: "",
            },
          ],
        }));
      else
        patchFor(scope, (l) => ({
          ...l,
          concepts: [
            ...l.concepts,
            {
              id: uid(),
              name: f.name,
              image,
              created: new Date().toISOString(),
            },
          ],
        }));
    }
    setNotice(
      kind === "reference"
        ? "References added. Select the elements you want to use."
        : "Concept uploaded. Review it before approving.",
    );
    if (kind === "concept") setTab("concept");
    if (uploadRef.current) uploadRef.current.value = "";
    if (uploadConcept.current) uploadConcept.current.value = "";
  }
  async function run(kind: "references" | "concept") {
    if (!apiBase) {
      setModal("connection");
      return;
    }
    if (busy) return;
    if (!loc.approved) {
      setNotice("Review and approve the working brief first.");
      setTab("brief");
      return;
    }
    const scope = loc.id;
    setBusy(scope);
    try {
      const job = await request<{ id: string }>(`/jobs`, {
        kind,
        location: loc,
      });
      localStorage.setItem(
        "motionx-pending-job",
        JSON.stringify({ id: job.id, scope, kind }),
      );
      await poll(job.id, scope, kind);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "The harness request failed.");
      setBusy("");
    }
  }
  async function poll(id: string, scope: string, kind: string) {
    try {
      for (let n = 0; n < 240; n++) {
        const j = await request<{
          status: string;
          error?: string;
          references?: Reference[];
          concept?: Concept;
        }>(`/jobs/${encodeURIComponent(id)}`);
        if (j.status === "failed")
          throw new Error(
            j.error || "The run failed. Your previous work is unchanged.",
          );
        if (j.status === "succeeded") {
          if (kind === "references" && Array.isArray(j.references))
            patchFor(scope, (l) => ({
              ...l,
              refs: [
                ...l.refs.filter(
                  (r) => r.selected || r.category === "Uploaded",
                ),
                ...j.references!.filter(
                  (r) =>
                    !l.refs.some(
                      (a) =>
                        a.id === r.id &&
                        (a.selected || a.category === "Uploaded"),
                    ),
                ),
              ],
            }));
          if (kind === "concept" && j.concept)
            patchFor(scope, (l) => ({
              ...l,
              concepts: [...l.concepts, j.concept!],
            }));
          localStorage.removeItem("motionx-pending-job");
          setNotice("Your results are ready.");
          return;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      throw new Error("The run is still pending. Reload to reconnect.");
    } catch (e) {
      setNotice(
        e instanceof Error
          ? e.message
          : "Unable to check the run. Reload to reconnect.",
      );
    } finally {
      setBusy("");
    }
  }
  const resumed = useRef(false);
  useEffect(() => {
    if (ready && apiBase && !resumed.current) {
      resumed.current = true;
      const v = localStorage.getItem("motionx-pending-job");
      if (v) {
        try {
          const j = JSON.parse(v);
          setBusy(j.scope);
          void poll(j.id, j.scope, j.kind);
        } catch {
          localStorage.removeItem("motionx-pending-job");
        }
      }
    }
  }, [ready]);
  async function send() {
    const value = text.trim();
    if (!value || sending) return;
    const scope = loc.name,
      snapshot = loc;
    setWs((s) => ({
      ...s,
      messages: [
        ...s.messages,
        { id: uid(), role: "user", text: value, scope },
      ],
    }));
    setText("");
    if (!apiBase) {
      setWs((s) => ({
        ...s,
        messages: [
          ...s.messages,
          {
            id: uid(),
            role: "assistant",
            scope,
            text: "Saved to this location’s discussion. Connect the harness to get AI responses. You can already edit the brief, select references, and upload a concept in the workspace.",
          },
        ],
      }));
      return;
    }
    setSending(true);
    try {
      const r = await request<{ message: string }>("/chat", {
        message: value,
        location: snapshot,
        history: ws.messages.slice(-20),
      });
      setWs((s) => ({
        ...s,
        messages: [
          ...s.messages,
          { id: uid(), role: "assistant", text: r.message, scope },
        ],
      }));
    } catch (e) {
      setNotice(
        e instanceof Error
          ? e.message
          : "Message failed. Your discussion is preserved.",
      );
    } finally {
      setSending(false);
    }
  }
  function exportBrief() {
    const data = {
      location: loc.name,
      approvedBrief: loc.approved,
      brief: loc.brief,
      requirements: loc.requirements,
      unresolved: loc.questions,
      references: selected.map((r) => ({
        title: r.title,
        guidance: r.guidance,
        source: r.source,
        credit: r.credit,
        image: r.image,
      })),
      approvedConcept: loc.concepts.find((c) => c.id === loc.locked) ?? null,
    };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    a.download =
      loc.name.toLowerCase().replace(/\W+/g, "-") + "-blockout-brief.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const shown = loc.refs.filter(
    (r) =>
      filter === "All references" ||
      (filter === "Selected" && r.selected) ||
      r.category === filter,
  );
  return (
    <div
      className={`studio ${sidebar ? "" : "no-sidebar"} ${chat ? "" : "no-chat"}`}
    >
      <aside className="sidebar" hidden={!sidebar}>
        <div className="brand">
          <span className="brand-icon">
            <Clapperboard size={21} />
          </span>
          <strong>
            motion<span>x</span>
          </strong>
          <span className="studio-label">STUDIO</span>
        </div>
        <button className="project-switch" onClick={() => setModal("sources")}>
          <span className="project-mark">D</span>
          <span>
            <strong>Dehleez</strong>
            <small>Film workspace</small>
          </span>
          <ChevronDown size={15} />
        </button>
        <div className="nav-label">WORKSPACE</div>
        <button className="nav-item" onClick={() => setModal("sources")}>
          <FolderOpen size={17} /> Project sources{" "}
          <span className="muted">3</span>
        </button>
        <button
          className="nav-item active"
          onClick={() => setTab("references")}
        >
          <MapPin size={17} /> Locations <span>{ws.locations.length}</span>
        </button>
        <div className="sidebar-section">
          <span>YOUR LOCATIONS</span>
          <button
            className="icon"
            aria-label="Add location"
            onClick={() => {
              setName("");
              setModal("add");
            }}
          >
            <Plus size={16} />
          </button>
        </div>
        <label className="location-search">
          <Search size={15} />
          <input
            placeholder="Find a location"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Find location"
          />
        </label>
        <div className="location-list">
          {ws.locations
            .filter((l) => l.name.toLowerCase().includes(search.toLowerCase()))
            .map((l) => (
              <button
                key={l.id}
                className={`location-item ${l.id === loc.id ? "current" : ""}`}
                onClick={() => switchLoc(l.id)}
              >
                <span className="location-glyph">
                  {l.locked ? <Lock size={15} /> : <MapPin size={15} />}
                </span>
                <span>
                  <strong>{l.name}</strong>
                  <small>
                    {l.deferred
                      ? "Set aside"
                      : l.locked
                        ? "Visual direction approved"
                        : `${l.scenes.length} scenes · ${l.parent}`}
                  </small>
                </span>
                {l.id === loc.id && <span className="selected-dot" />}
              </button>
            ))}
        </div>
        <div className="sidebar-bottom">
          <div className="workflow-tip">
            <Layers size={18} />
            <strong>Build a place, one decision at a time.</strong>
            <p>From the script to a world you can step into.</p>
          </div>
          <button className="profile" onClick={() => setModal("connection")}>
            <span className="avatar">JM</span>
            <span>
              <strong>Jagan Mohan</strong>
              <small>Local workspace</small>
            </span>
            <Settings2 size={17} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon"
              aria-label="Toggle locations"
              onClick={() => setSidebar(!sidebar)}
            >
              <PanelLeftClose size={18} />
            </button>
            <span>Dehleez</span>
            <ChevronRight size={14} />
            <span>Locations</span>
            <ChevronRight size={14} />
            <strong>{loc.name}</strong>
          </div>
          <div className="top-actions">
            <span className="sample-badge">Sample project</span>
            <button className="chat-toggle" onClick={() => setChat(!chat)}>
              <Sparkles size={16} />
              <span>Creative assistant</span>
            </button>
          </div>
        </header>
        {saveError && (
          <div className="error-banner" role="alert">
            {saveError}
          </div>
        )}
        <div className="workspace-body">
          <main className="canvas">
            <div className="location-heading">
              <div>
                <div className="eyebrow">
                  LOCATION WORKSPACE <span> / {loc.parent.toUpperCase()}</span>
                </div>
                <h1>{loc.name}</h1>
                <div className="location-meta">
                  <span>
                    <Clapperboard size={14} /> Scenes{" "}
                    {loc.scenes.join(", ") || "not assigned"}
                  </span>
                  <span className={`status-pill ${loc.locked ? "locked" : ""}`}>
                    {loc.locked ? (
                      <Lock size={12} />
                    ) : (
                      <span className="tiny-dot" />
                    )}
                    {loc.locked
                      ? "Direction approved"
                      : loc.approved
                        ? "Exploring references"
                        : "Brief needs review"}
                  </span>
                </div>
              </div>
              <div className="menu-wrap">
                <button
                  aria-label="Location actions"
                  className="outline square"
                  onClick={() => setMenu(!menu)}
                >
                  <MoreHorizontal size={20} />
                </button>
                {menu && (
                  <div className="dropdown">
                    <button
                      onClick={() => {
                        setName(loc.name);
                        setModal("rename");
                        setMenu(false);
                      }}
                    >
                      Rename location
                    </button>
                    <button
                      onClick={() => {
                        setMergeTarget("");
                        setModal("merge");
                        setMenu(false);
                      }}
                    >
                      Merge into another location
                    </button>
                    <button
                      onClick={() => {
                        patch({ deferred: !loc.deferred });
                        setMenu(false);
                      }}
                    >
                      {loc.deferred
                        ? "Return to active"
                        : "Set aside for later"}
                    </button>
                    <button onClick={exportBrief}>Export decisions</button>
                  </div>
                )}
              </div>
            </div>
            <nav className="tabs" aria-label="Location stages">
              {(["brief", "references", "concept"] as Tab[]).map((t, i) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  aria-current={tab === t ? "page" : undefined}
                  className={tab === t ? "selected" : ""}
                >
                  <span className="step">
                    {t === "brief" && loc.approved ? (
                      <Check size={12} />
                    ) : (
                      i + 1
                    )}
                  </span>
                  {t === "brief"
                    ? "Location brief"
                    : t === "references"
                      ? "Visual references"
                      : "Concept & approval"}
                  {t === "references" && (
                    <span className="count">{loc.refs.length}</span>
                  )}
                </button>
              ))}
            </nav>
            {loc.deferred && (
              <div className="brief-banner">
                This location is set aside. You can still review and edit it.
                <button onClick={() => patch({ deferred: false })}>
                  Make active
                </button>
              </div>
            )}
            {tab === "brief" && (
              <section className="brief-view">
                <div className="section-title">
                  <div>
                    <h2>A shared picture of the place</h2>
                    <p>
                      Review the essentials before exploring its visual
                      direction.
                    </p>
                  </div>
                  <FileText size={24} />
                </div>
                <div className="sample-note">
                  Sample brief for exploring the interface. Connect your harness
                  for extracted notes and original source citations.
                </div>
                <label className="field">
                  Location description
                  <textarea
                    rows={5}
                    value={loc.brief}
                    onChange={(e) =>
                      patch({ brief: e.target.value, approved: false })
                    }
                  />
                </label>
                <label className="field">
                  Features to preserve
                  <textarea
                    rows={4}
                    value={loc.requirements}
                    onChange={(e) =>
                      patch({ requirements: e.target.value, approved: false })
                    }
                  />
                </label>
                <label className="field">
                  Open questions for blockout
                  <textarea
                    rows={3}
                    value={loc.questions}
                    onChange={(e) =>
                      patch({ questions: e.target.value, approved: false })
                    }
                  />
                </label>
                <div className="brief-footer">
                  <span>
                    Approves this working brief, not every extracted note.
                  </span>
                  <button
                    className="primary"
                    onClick={() => {
                      patch({ approved: true });
                      setTab("references");
                      setNotice("Working brief approved.");
                    }}
                  >
                    <Check size={16} />
                    Use this brief
                  </button>
                </div>
              </section>
            )}
            {tab === "references" && (
              <section className="reference-view">
                {!loc.approved && (
                  <div className="brief-banner">
                    <div>
                      <FileText size={17} />
                      <span>
                        Start with a shared understanding of this location.
                      </span>
                    </div>
                    <button onClick={() => setTab("brief")}>
                      Review brief <ArrowRight size={14} />
                    </button>
                  </div>
                )}
                <div className="section-title">
                  <div>
                    <h2>Find the feeling of this place.</h2>
                    <p>Borrow what works. Bring your own perspective.</p>
                  </div>
                  <div className="button-row">
                    <button
                      className="outline"
                      onClick={() => uploadRef.current?.click()}
                    >
                      <Upload size={15} />
                      Upload
                    </button>
                    <button
                      className="primary"
                      disabled={!!busy}
                      onClick={() => run("references")}
                    >
                      {busy === loc.id ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : (
                        <Sparkles size={16} />
                      )}
                      Find inspiration
                    </button>
                  </div>
                </div>
                <div className="filter-row">
                  {[
                    "All references",
                    "Selected",
                    "Architecture",
                    "Roots & canopy",
                    "Terrain",
                    "Uploaded",
                  ]
                    .filter(
                      (f) =>
                        f !== "Uploaded" ||
                        loc.refs.some((r) => r.category === "Uploaded"),
                    )
                    .map((f) => (
                      <button
                        className={filter === f ? "active" : ""}
                        key={f}
                        onClick={() => setFilter(f)}
                      >
                        {f}
                        {f === "Selected" && <span>{selected.length}</span>}
                      </button>
                    ))}
                  <span className="results-count">
                    {shown.length} references
                  </span>
                </div>
                {shown.length > 0 ? (
                  <div className="reference-grid">
                    {shown.map((r, i) => (
                      <article
                        className={`reference-card ${r.selected ? "is-selected" : ""}`}
                        key={r.id}
                      >
                        <div className="image-wrap">
                          <button
                            className="image-button"
                            onClick={() => setDetail(r)}
                            aria-label={`View ${r.title}`}
                          >
                            <img
                              src={r.image}
                              alt={r.title}
                              onError={(e) => {
                                e.currentTarget.style.opacity = "0";
                                e.currentTarget.parentElement!.classList.add(
                                  "image-missing",
                                );
                              }}
                            />
                          </button>
                          <span className="image-number">
                            {String(i + 1).padStart(2, "0")}
                          </span>
                          <button
                            className="select-image"
                            aria-label={`${r.selected ? "Deselect" : "Select"} ${r.title}`}
                            aria-pressed={r.selected}
                            onClick={() => select(r)}
                          >
                            {r.selected ? (
                              <Check size={16} />
                            ) : (
                              <Plus size={16} />
                            )}
                          </button>
                          <span className="category">{r.category}</span>
                        </div>
                        <div className="card-content">
                          <button
                            className="card-title"
                            onClick={() => setDetail(r)}
                          >
                            {r.title}
                            <ArrowUpRight size={15} />
                          </button>
                          <p>{r.reason}</p>
                          {r.selected && (
                            <label className="guidance-field">
                              USE FOR
                              <input
                                aria-label={`Use ${r.title} for`}
                                value={r.guidance}
                                placeholder="e.g. canopy shape, not the bridge"
                                onChange={(e) =>
                                  patch({
                                    refs: loc.refs.map((a) =>
                                      a.id === r.id
                                        ? { ...a, guidance: e.target.value }
                                        : a,
                                    ),
                                  })
                                }
                              />
                            </label>
                          )}
                          <div className="card-meta">
                            <span>
                              {r.category === "Uploaded"
                                ? "Your upload"
                                : "Wikimedia Commons"}
                            </span>
                            <span>
                              {r.selected
                                ? "Selected for direction"
                                : "Visual inspiration"}
                            </span>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="empty">
                    <ImageIcon size={35} />
                    <h3>
                      {filter === "Selected"
                        ? "Choose the pieces that speak to you."
                        : "A fresh board for this location."}
                    </h3>
                    <p>
                      {filter === "Selected"
                        ? "Select a reference using its + button."
                        : "Upload a reference or connect the harness to search."}
                    </p>
                    <button
                      className="outline"
                      onClick={() =>
                        filter === "Selected"
                          ? setFilter("All references")
                          : uploadRef.current?.click()
                      }
                    >
                      {filter === "Selected"
                        ? "Browse references"
                        : "Upload a reference"}
                    </button>
                  </div>
                )}
                <div className="selection-bar">
                  <div>
                    <span className="selection-stack">
                      <Layers size={20} />
                    </span>
                    <span>
                      <strong>
                        {selected.length
                          ? `${selected.length} references in your direction`
                          : "Your direction starts here"}
                      </strong>
                      <small>
                        {selected.length
                          ? "Add a note about what to borrow from each."
                          : "Select references or upload your finished concept."}
                      </small>
                    </span>
                  </div>
                  <button
                    className="text-action"
                    onClick={() => setTab("concept")}
                  >
                    Shape the concept <ArrowRight size={17} />
                  </button>
                </div>
              </section>
            )}
            {tab === "concept" && (
              <section className="concept-view">
                <div className="section-title">
                  <div>
                    <h2>Make it your location.</h2>
                    <p>Choose one concept to carry into the 3D blockout.</p>
                  </div>
                  <button
                    className="outline"
                    onClick={() => uploadConcept.current?.click()}
                  >
                    <Upload size={16} />
                    Upload concept
                  </button>
                </div>
                <div className="direction-summary">
                  <span className="eyebrow">CURRENT DIRECTION</span>
                  <p>{loc.brief}</p>
                  <div className="mini-refs">
                    {selected.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => setDetail(r)}
                        title={r.guidance || r.title}
                      >
                        <img src={r.image} alt={r.title} />
                      </button>
                    ))}
                    <span>{selected.length} supporting references</span>
                  </div>
                </div>
                {loc.concepts.length ? (
                  <div className="concept-grid">
                    {loc.concepts.map((c, i) => (
                      <article className="concept-card" key={c.id}>
                        <button onClick={() => setPreview(c)}>
                          <img src={c.image} alt={c.name} />
                        </button>
                        <div>
                          <span>
                            <small>VERSION {i + 1}</small>
                            <strong>{c.name}</strong>
                          </span>
                          <button
                            className={
                              loc.locked === c.id ? "outline" : "primary"
                            }
                            onClick={() => {
                              setPreview(c);
                              setModal("lock");
                            }}
                          >
                            {loc.locked === c.id ? (
                              <>
                                <Lock size={15} />
                                Approved
                              </>
                            ) : (
                              <>
                                Review & approve
                                <ArrowRight size={15} />
                              </>
                            )}
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="empty concept-empty">
                    <span className="empty-art">
                      <ImageIcon size={37} />
                      <Sparkles size={18} />
                    </span>
                    <h3>A place that’s entirely yours.</h3>
                    <p>
                      Bring a concept you’ve already created, or generate one
                      from your brief and selected references.
                    </p>
                    <div className="button-row">
                      <button
                        className="outline"
                        onClick={() => uploadConcept.current?.click()}
                      >
                        <Upload size={16} />
                        Upload my concept
                      </button>
                      <button
                        className="primary"
                        onClick={() => run("concept")}
                        disabled={!!busy}
                      >
                        <Sparkles size={16} />
                        Generate concept
                      </button>
                    </div>
                  </div>
                )}
                {loc.locked && (
                  <div className="approved-banner">
                    <Lock size={20} />
                    <div>
                      <strong>Visual direction approved</strong>
                      <p>
                        Your image and decisions are ready for blockout
                        planning.
                      </p>
                    </div>
                    <button className="outline" onClick={exportBrief}>
                      <Download size={15} />
                      Export blockout brief
                    </button>
                  </div>
                )}
              </section>
            )}
            <footer className="canvas-footer">
              <span>DEHLEEZ / LOCATION DEVELOPMENT</span>
              <span>
                {saveError
                  ? "Not saved"
                  : ready
                    ? "Saved in this browser"
                    : "Loading workspace…"}
              </span>
            </footer>
          </main>
          {chat && (
            <aside className="assistant-panel">
              <div className="assistant-heading">
                <div>
                  <span className="spark-icon">
                    <Sparkles size={18} />
                  </span>
                  <strong>Creative assistant</strong>
                </div>
                <button
                  className="icon"
                  aria-label="Close assistant"
                  onClick={() => setChat(false)}
                >
                  <PanelRightClose size={18} />
                </button>
              </div>
              <div className="context-chip">
                <MapPin size={13} />
                <span>{loc.name}</span>
                <span>· {selected.length} selected</span>
              </div>
              <div className="conversation">
                <div className="assistant-intro">
                  <span className="assistant-avatar">
                    <Sparkles size={20} />
                  </span>
                  <h3>
                    Let’s find your
                    <br />
                    version of this place.
                  </h3>
                  <p>
                    Explore an idea, compare references, or tell me what you’d
                    like to change.
                  </p>
                </div>
                <div className="connection-note">
                  <span className="tiny-dot" />
                  {apiBase
                    ? "Harness configured"
                    : "Discussion mode · AI not connected"}
                </div>
                {ws.messages.length === 0 && (
                  <div className="suggestions">
                    {[
                      "Help me define the visual direction",
                      "Compare the references I selected",
                      "What should we resolve before blockout?",
                    ].map((t) => (
                      <button key={t} onClick={() => setText(t)}>
                        {t}
                        <ArrowUpRight size={14} />
                      </button>
                    ))}
                  </div>
                )}
                {ws.messages.map((m) => (
                  <div className={`message ${m.role}`} key={m.id}>
                    <small>
                      {m.role === "user"
                        ? "You"
                        : apiBase
                          ? "Assistant"
                          : "Workspace"}{" "}
                      · {m.scope}
                    </small>
                    <p>{m.text}</p>
                  </div>
                ))}
                {sending && (
                  <div className="thinking">
                    <LoaderCircle className="spin" size={15} />
                    Thinking about your location…
                  </div>
                )}
                <div ref={bottom} />
              </div>
              <div className="composer-area">
                <div className="composer">
                  <textarea
                    aria-label="Message creative assistant"
                    placeholder={`A thought about ${loc.name}…`}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                  />
                  <div>
                    <span>
                      {selected.length
                        ? `${selected.length} references attached`
                        : "Location context included"}
                    </span>
                    <button
                      aria-label="Send message"
                      disabled={!text.trim() || sending}
                      onClick={send}
                    >
                      <ArrowUp size={18} />
                    </button>
                  </div>
                </div>
                <p>
                  {apiBase
                    ? "AI suggestions become decisions only when you approve."
                    : "Your discussion is saved locally. Connect AI in workspace settings."}
                </p>
                <button
                  className="connection-link"
                  onClick={() => setModal("connection")}
                >
                  Workspace settings <ArrowUpRight size={12} />
                </button>
              </div>
            </aside>
          )}
        </div>
      </div>
      <input
        ref={uploadRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        hidden
        onChange={(e) => void upload(e.target.files, "reference")}
      />
      <input
        ref={uploadConcept}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(e) => void upload(e.target.files, "concept")}
      />
      {notice && (
        <div className="toast" role="status">
          <Check size={17} />
          {notice}
          <button
            className="icon"
            aria-label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      <dialog
        ref={dialog}
        onCancel={close}
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
      >
        <div className="dialog-content">
          <button
            className="dialog-close icon"
            onClick={close}
            aria-label="Close dialog"
          >
            <X size={20} />
          </button>
          {modal === "connection" && (
            <>
              <span className="dialog-symbol">
                <Settings2 size={24} />
              </span>
              <h2>Workspace connection</h2>
              <p>
                This standalone workspace keeps your briefs, uploads, selections
                and discussions in this browser.
              </p>
              <div className="connection-status">
                <span className="tiny-dot" />
                {apiBase
                  ? "Harness API configured"
                  : "Harness API not connected"}
              </div>
              <p>
                Live AI, reference search and concept generation need your
                Python harness service. No model calls are simulated.
              </p>
              <p className="small">
                For your developer: configure{" "}
                <code>NEXT_PUBLIC_HARNESS_API_URL</code> and implement the
                included API contract. Project data is sample content until your
                repository is connected.
              </p>
              <button className="primary" onClick={close}>
                Back to workspace
              </button>
            </>
          )}
          {modal === "sources" && (
            <>
              <span className="eyebrow">SAMPLE PROJECT</span>
              <h2>Dehleez</h2>
              <p>
                A sample workspace based on our location discussions. These are
                illustrative source entries, not files read from your database.
              </p>
              {[
                "Episode 1 · screenplay",
                "Director’s location notes",
                "Visual reference collection",
              ].map((s, i) => (
                <div className="source-row" key={s}>
                  <FileText size={18} />
                  <span>{s}</span>
                  <small>
                    {i === 0 ? "PDF" : i === 1 ? "NOTES" : "IMAGES"}
                  </small>
                </div>
              ))}
              <p className="small">
                Connect the existing memory service to load your actual sources
                and citations.
              </p>
            </>
          )}
          {(modal === "add" || modal === "rename") && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!name.trim()) return;
                if (modal === "rename") patch({ name: name.trim() });
                else {
                  const id = uid();
                  setWs((s) => ({
                    ...s,
                    active: id,
                    locations: [
                      ...s.locations,
                      {
                        id,
                        name: name.trim(),
                        parent: "Unassigned",
                        scenes: [],
                        brief: "",
                        requirements: "",
                        questions: "",
                        approved: false,
                        deferred: false,
                        refs: [],
                        concepts: [],
                      },
                    ],
                  }));
                  setTab("brief");
                }
                close();
              }}
            >
              <h2>{modal === "add" ? "Add a location" : "Rename location"}</h2>
              <label className="field">
                Location name
                <input
                  autoFocus
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                />
              </label>
              <button className="primary" type="submit">
                {modal === "add" ? "Add location" : "Save name"}
              </button>
            </form>
          )}
          {modal === "merge" && (
            <>
              <h2>Merge {loc.name}</h2>
              <p>
                Move its references, concepts and brief into another location.
                The destination’s existing approval will be cleared for review.
              </p>
              <label className="field">
                Keep this destination
                <select
                  value={mergeTarget}
                  onChange={(e) => setMergeTarget(e.target.value)}
                >
                  <option value="">Choose a location</option>
                  {ws.locations
                    .filter((l) => l.id !== loc.id)
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                </select>
              </label>
              <button
                disabled={!mergeTarget}
                className="primary"
                onClick={() => {
                  setWs((s) => ({
                    ...s,
                    active: mergeTarget,
                    locations: s.locations
                      .filter((l) => l.id !== loc.id)
                      .map((l) =>
                        l.id === mergeTarget
                          ? {
                              ...l,
                              brief: [l.brief, loc.brief]
                                .filter(Boolean)
                                .join("\n\n"),
                              requirements: [l.requirements, loc.requirements]
                                .filter(Boolean)
                                .join("\n"),
                              questions: [l.questions, loc.questions]
                                .filter(Boolean)
                                .join("\n"),
                              scenes: [
                                ...new Set([...l.scenes, ...loc.scenes]),
                              ],
                              refs: [
                                ...l.refs,
                                ...loc.refs.filter(
                                  (r) => !l.refs.some((a) => a.id === r.id),
                                ),
                              ],
                              concepts: [...l.concepts, ...loc.concepts],
                              approved: false,
                              locked: undefined,
                            }
                          : l,
                      ),
                  }));
                  close();
                  setNotice("Locations merged. Review the combined brief.");
                }}
              >
                Confirm merge
              </button>
            </>
          )}
          {detail && !modal && (
            <>
              <img
                className="detail-image"
                src={detail.image}
                alt={detail.title}
              />
              <span className="eyebrow">{detail.category}</span>
              <h2>{detail.title}</h2>
              <p>{detail.reason}</p>
              <p className="small">{detail.credit || "Uploaded by you"}</p>
              <div className="button-row">
                <button
                  className="primary"
                  onClick={() => {
                    select(loc.refs.find((r) => r.id === detail.id)!);
                    close();
                  }}
                >
                  {loc.refs.find((r) => r.id === detail.id)?.selected
                    ? "Remove from direction"
                    : "Use in my direction"}
                </button>
                {detail.source && /^https?:\/\//.test(detail.source) && (
                  <a
                    className="outline"
                    href={detail.source}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Original source
                    <ArrowUpRight size={15} />
                  </a>
                )}
              </div>
            </>
          )}
          {preview && (
            <>
              <img
                className="detail-image"
                src={preview.image}
                alt={preview.name}
              />
              <span className="eyebrow">LOCATION CONCEPT</span>
              <h2>
                {modal === "lock"
                  ? "Approve this visual direction?"
                  : preview.name}
              </h2>
              <p>
                This locks the selected image as visual guidance. Dimensions,
                unseen spaces and circulation remain decisions for the blockout.
              </p>
              {loc.questions && (
                <div className="open-questions">
                  <strong>Still to resolve</strong>
                  <p>{loc.questions}</p>
                </div>
              )}
              <button
                className="primary"
                onClick={() => {
                  patch({ locked: preview.id });
                  close();
                  setNotice(
                    "Visual direction approved. Export your brief to start blockout planning.",
                  );
                }}
              >
                <Lock size={16} />
                Approve visual direction
              </button>
            </>
          )}
        </div>
      </dialog>
    </div>
  );
}
