import { useEffect, useRef, useState } from "react";
import {
  connectPanel,
  errorText,
  isAbort,
  setPanelTarget,
  type Session,
} from "./api";
import { Spinner, useUI } from "./ui";
import AppearanceControls from "./AppearanceControls";
import { notify } from "./notifications";
import Workspace from "./Management";
import {
  normalizePanel,
  PanelFields,
  usePanels,
  type PanelConnection,
} from "./Panels";
import setup from "./vendor/SetupView.module.css";

function Setup({
  initial,
  onConnect,
}: {
  initial?: PanelConnection;
  onConnect: (panel: PanelConnection, session: Session) => void;
}) {
  const { t } = useUI();
  const [value, setValue] = useState<PanelConnection>(
    initial || { name: "", url: location.origin, secret: "" },
  );
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function submit() {
    if (busy) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const panel = normalizePanel(value);
      const session = await connectPanel(panel, controller.signal);
      onConnect(panel, session);
    } catch (error) {
      if (!isAbort(error)) notify(errorText(error, t));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <div className="setup">
      <div className="setup-panel">
        <div className="setup-brand">sing-box manager</div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <fieldset disabled={busy}>
            <PanelFields value={value} onChange={setValue} />
          </fieldset>
          <button
            className={`button primary ${setup["setup-submit"]}`}
            disabled={busy || !value.url.trim() || !value.secret}
          >
            {busy && <Spinner />}
            {busy ? t("正在连接…", "Connecting...") : t("连接", "Connect")}
          </button>
        </form>
        <AppearanceControls compact />
      </div>
    </div>
  );
}

type Connected = PanelConnection & { session: Session };

export default function App() {
  const connections = usePanels();
  const { current } = connections;
  const [connected, setConnected] = useState<Connected | null>();
  const [expired, setExpired] = useState(false);
  const known = useRef<Connected | null>(null);
  const { t } = useUI();
  useEffect(() => {
    if (connected && !expired)
      window.dispatchEvent(new Event("sbm:authenticated"));
  }, [connected, expired]);
  useEffect(() => {
    const unauthorized = () => {
      if (known.current) setExpired(true);
    };
    window.addEventListener("sbm:unauthorized", unauthorized);
    return () => window.removeEventListener("sbm:unauthorized", unauthorized);
  }, []);
  useEffect(() => {
    if (
      current &&
      known.current?.url === current.url &&
      known.current.secret === current.secret
    )
      return;
    const controller = new AbortController();
    known.current = null;
    setExpired(false);
    setPanelTarget(current || { url: location.origin, secret: "" });
    if (!current?.secret) {
      setConnected(null);
      return;
    }
    setConnected(undefined);
    connectPanel(current, controller.signal)
      .then((session) => {
        if (controller.signal.aborted) return;
        const value = { ...current, session };
        known.current = value;
        setConnected(value);
      })
      .catch((error) => {
        if (isAbort(error)) return;
        notify(errorText(error, t));
        setConnected(null);
      });
    return () => controller.abort();
  }, [current?.url, current?.secret]);
  function accept(panel: PanelConnection, session: Session) {
    connections.remember(panel);
    setPanelTarget(panel);
    const value = { ...panel, session };
    known.current = value;
    setConnected(value);
    setExpired(false);
  }
  if (
    connected === undefined ||
    (connected &&
      (connected.url !== current?.url || connected.secret !== current.secret))
  )
    return (
      <div className="setup">
        <Spinner />
      </div>
    );
  if (!connected || !current)
    return (
      <Setup key={current?.url || "new"} initial={current} onConnect={accept} />
    );
  return (
    <>
      <Workspace
        key={current.url}
        session={connected.session}
        suspended={expired}
        panels={connections.panels}
        currentPanel={current}
        updatePanels={connections.update}
        onSelectPanel={connections.select}
        onLogout={() => {
          known.current = null;
          setPanelTarget({ url: current.url, secret: "" });
          connections.update(
            connections.panels.map((panel) =>
              panel.url === current.url ? { ...panel, secret: "" } : panel,
            ),
          );
          setExpired(false);
          setConnected(null);
        }}
      />
      {expired && (
        <div
          className="auth-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t("重新连接", "Reconnect")}
        >
          <Setup initial={current} onConnect={accept} />
        </div>
      )}
    </>
  );
}
