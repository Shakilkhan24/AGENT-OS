import { useEffect, useRef, useState } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TerminalView } from "../shared/types";
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
    let inputQueue = Promise.resolve();
    let queuedInput = 0;
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
    // paying the cost on every chunk. Single-chunk writes (the common case
    // for live typing) still flush immediately.
    let frameBuffer = "";
    let frameScheduled = false;
    let pendingAckBytes = 0;
    const flushFrame = () => {
      frameScheduled = false;
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
      pendingAckBytes += data.length;
      if (!frameScheduled) {
        frameScheduled = true;
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(flushFrame);
        else setTimeout(flushFrame, 0);
      }
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
      if (queuedInput + data.length > 2 * 1024 * 1024) {
        report(
          new Error(
            "Paste is too large or input is busy. Wait, then paste a smaller selection.",
          ),
        );
        return;
      }
      queuedInput += data.length;
      inputQueue = inputQueue
        .then(() => {
          for (let offset = 0; offset < data.length;) {
            if (disposed) return;
            let end = Math.min(offset + 16384, data.length);
            if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]))
              end--;
            window.minimal.input(token, data.slice(offset, end));
            offset = end;
          }
        })
        .catch((error) => {
          if (!disposed) report(error);
        })
        .finally(() => {
          queuedInput -= data.length;
        });
    });
    const copy = () =>
      window.minimal.writeClipboard(term.getSelection()).catch(report);
    // Paste the clipboard contents. Text that contains newlines, carriage
    // returns or tabs is wrapped in the standard bracketed-paste escape
    // sequences (\x1b[200~ ... \x1b[201~) so the receiving program (Bash's
    // readline, an editor, etc.) treats the paste as a single atomic edit
    // instead of executing each newline as Enter or each tab as completion.
    // The wrappers are forwarded byte-for-byte through the PTY; tmux's
    // escape-time (500ms in tmux-engine.ts) reassembles them as a single
    // sequence even on a busy paste. Single-line content is pasted as-is,
    // which matches how the renderer used to handle it before this guard
    // was added.
    const pasteText = () =>
      window.minimal
        .readClipboard()
        .then((text) => {
          if (disposed || !text) return;
          if (text.includes("\n") || text.includes("\r") || text.includes("\t")) {
            term.paste(`\x1b[200~${text}\x1b[201~`);
          } else {
            term.paste(text);
          }
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
          void window.minimal.detach(result);
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
      setConnected(false);
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
      offOutput();
      offExit();
      onData.dispose();
      element.removeEventListener("contextmenu", onContextMenu);
      if (token) void window.minimal.detach(token);
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
