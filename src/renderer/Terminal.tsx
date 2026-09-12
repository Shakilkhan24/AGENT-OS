import { useEffect, useRef, useState } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TerminalView } from "../shared/types";
import { TerminalInputQueue, utf8Bytes } from "../shared/terminal-flow";
export function Terminal({
  terminal,
  report,
}: {
  terminal: TerminalView;
  report: (error: unknown) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!host.current || terminal.status === "missing") return;
    setConnectionError("");
    let disposed = false;
    let token = "";
    let pending: [string, string][] = [];
    const earlyExits = new Set<string>();
    let receivedOutput = false;
    const input = new TerminalInputQueue(data => window.minimal.input(token, data));
    const term = new Xterm({
      cursorBlink: true,
      fontFamily: '"DejaVu Sans Mono", "Cascadia Code", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 10000,
      allowProposedApi: false,
      theme: {
        background: "#111314",
        foreground: "#d8ded9",
        cursor: "#c5edaa",
        selectionBackground: "#334a37",
        black: "#242827",
        red: "#f18d89",
        green: "#b3d797",
        yellow: "#e1c785",
        blue: "#90badd",
        magenta: "#c1a4d8",
        cyan: "#95d3cc",
        white: "#e0e5df",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();
    // Coalesce per-frame: xterm.js can absorb thousands of `term.write` calls
    // per second, but each one schedules a render. On burst output (e.g.
    // `cat`-ing a 200 KB file) we can receive dozens of IPC chunks in a
    // single animation frame; queue them and flush once per rAF instead of
    // paying the cost on every chunk. All chunks flush on the next frame.
    let frameBuffer = "";
    let outputFrame = 0;
    let pendingAckBytes = 0;
    const flushFrame = () => {
      outputFrame = 0;
      if (disposed) return;
      const data = frameBuffer;
      const bytes = pendingAckBytes;
      frameBuffer = "";
      pendingAckBytes = 0;
      if (!data) return;
      if (!receivedOutput) {
        receivedOutput = true;
        setConnected(true);
      }
      term.write(data, () => window.minimal.acknowledge(token, bytes));
    };
    const enqueueWrite = (data: string) => {
      frameBuffer += data;
      pendingAckBytes += utf8Bytes(data);
      if (!outputFrame) outputFrame = requestAnimationFrame(flushFrame);
    };
    const offOutput = window.minimal.onOutput((incoming, data) => {
      if (!token) pending.push([incoming, data]);
      else if (incoming === token) enqueueWrite(data);
    });
    const offExit = window.minimal.onExit((incoming) => {
      if (!token) earlyExits.add(incoming);
      else if (incoming === token) {
        setConnected(false);
        setConnectionError(
          "Terminal connection ended. Reconnect to view surviving work.",
        );
      }
    });
    const onData = term.onData((data) => {
      if (!token || disposed) return;
      void input.enqueue(data)
        .catch((error) => {
          if (!disposed) report(error);
        });
    });
    const copy = () =>
      window.minimal.writeClipboard(term.getSelection()).catch(report);
    // xterm normalizes line endings and handles the application's paste mode.
    const pasteText = () =>
      window.minimal
        .readClipboard()
        .then((text) => {
          if (disposed || !text) return;
          term.paste(text);
        })
        .catch(report);
    term.attachCustomKeyEventHandler((event) => {
      if (
        event.ctrlKey &&
        event.shiftKey &&
        ["c", "v"].includes(event.key.toLowerCase())
      ) {
        if (event.type === "keydown") {
          if (event.key.toLowerCase() === "c") {
            if (term.hasSelection()) void copy();
          } else void pasteText();
        }
        event.preventDefault();
        return false;
      }
      return true;
    });
    let resizeFrame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (!disposed) {
          fit.fit();
          if (token) window.minimal.resize(token, term.cols, term.rows);
        }
      });
    });
    observer.observe(host.current);
    window.minimal
      .attach(terminal.id, term.cols, term.rows)
      .then((result) => {
        if (disposed) {
          void window.minimal.detach(result).catch(() => {});
          return;
        }
        token = result;
        for (const [incoming, data] of pending)
          if (incoming === token) enqueueWrite(data);
        pending = [];
        if (earlyExits.has(token)) {
          setConnected(false);
          setConnectionError(
            "Could not attach to this terminal. Reconnect to try again.",
          );
        }
        term.focus();
      })
      .catch((error) => {
        if (!disposed)
          setConnectionError(
            error instanceof Error ? error.message : String(error),
          );
      });
    const element = host.current;
    // Right-click always pastes from the OS clipboard. xterm.js installs its
    // own contextmenu handler that selects the word under the cursor before
    // this listener runs, so gating on `term.hasSelection()` here would route
    // every right-click to copy that word instead of paste. Use Ctrl+Shift+C
    // to copy a selection explicitly.
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      void pasteText();
    };
    element.addEventListener("contextmenu", onContextMenu);
    return () => {
      disposed = true;
      input.cancel();
      setConnected(false);
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
      cancelAnimationFrame(outputFrame);
      offOutput();
      offExit();
      onData.dispose();
      element.removeEventListener("contextmenu", onContextMenu);
      if (token) void window.minimal.detach(token).catch(report);
      term.dispose();
    };
  }, [terminal.id, terminal.status === "missing", attempt]);
  return (
    <div className="terminal-wrap">
      <div
        className="terminal-surface"
        ref={host}
        data-testid="terminal-surface"
      />
      {terminal.status === "missing" && (
        <div className="terminal-message">
          <h2>
            {terminal.launchError
              ? "Could not start this terminal"
              : "Work is no longer running"}
          </h2>
          <p>
            {terminal.launchError ||
              "This terminal was not found in tmux. It has been kept here for reference."}
          </p>
          <p>
            Use <strong>Edit &amp; run</strong> to review its command and launch
            again.
          </p>
        </div>
      )}
      {connectionError && terminal.status !== "missing" && (
        <div className="terminal-reconnect" role="status">
          <span>{connectionError}</span>
          <button
            className="secondary"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Reconnect
          </button>
        </div>
      )}
      <div className="terminal-caption">
        <span className={`dot ${connected ? "live" : ""}`} />
        {terminal.status === "exited"
          ? `Process exited · code ${terminal.exitCode ?? "unknown"}`
          : connected
            ? "Connected"
            : terminal.status === "missing"
              ? "Unavailable"
              : connectionError
                ? "Disconnected"
                : "Connecting…"}
        <span className="caption-right">
          {terminal.pid ? `PID ${terminal.pid}` : ""} · bash / tmux
        </span>
      </div>
    </div>
  );
}
