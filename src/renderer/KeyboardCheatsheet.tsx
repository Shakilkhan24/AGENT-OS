/**
 * M9.3 — keyboard cheatsheet dialog.
 *
 * Renders the existing `<Modal>` so focus restoration, Escape and
 * `aria-labelledby` come for free. The body is a plain `<table>` of
 * `CHEATSHEET` entries; the data lives in `cheatsheet-data.ts` so a test
 * can assert the table contents without rendering the dialog.
 */
import { Modal } from "./components";
import { CHEATSHEET } from "./cheatsheet-data";

export function KeyboardCheatsheet({ close }: { close(): void }) {
  return (
    <Modal
      title="Keyboard shortcuts"
      subtitle="Everything you can do without taking your hands off the keyboard."
      close={close}
    >
      <table className="cheatsheet" aria-label="Keyboard shortcuts">
        <thead>
          <tr>
            <th scope="col">Shortcut</th>
            <th scope="col">Action</th>
            <th scope="col">Scope</th>
          </tr>
        </thead>
        <tbody>
          {CHEATSHEET.map((entry) => (
            <tr key={entry.keys}>
              <td>
                <kbd>{entry.keys}</kbd>
              </td>
              <td>{entry.description}</td>
              <td>{entry.scope ?? "\u2014"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="modal-actions">
        <button type="button" className="primary" onClick={close}>
          Close
        </button>
      </div>
    </Modal>
  );
}