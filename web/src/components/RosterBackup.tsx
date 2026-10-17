// Export and import of the roster. The roster otherwise lives only in this browser's localStorage,
// so these files are the coordinator's backup. Files are read and written in the browser only.
import { useId, useRef, useState } from "react";
import type { FamilyLinks } from "../family";
import type { Roster } from "../roster";
import {
  BackupError,
  MAX_BACKUP_BYTES,
  aliasesChangedByReplace,
  backupFileName,
  mergeRoster,
  parseBackupFile,
  replaceRoster,
  rosterToCsv,
  rosterToJson,
  type ImportedRoster,
} from "../roster-backup";
import { Modal } from "./Modal";

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

interface Pending {
  fileName: string;
  data: ImportedRoster;
}

export function RosterBackup({
  roster,
  update,
  familyLinks,
}: {
  roster: Roster;
  update: (fn: (r: Roster) => Roster) => void;
  familyLinks: FamilyLinks;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const hasResidents = roster.residents.length > 0;

  const exportAs = (ext: "json" | "csv") => {
    setError(null);
    if (ext === "json") download(backupFileName(roster, "json"), rosterToJson(roster), "application/json");
    else download(backupFileName(roster, "csv"), rosterToCsv(roster), "text/csv;charset=utf-8");
    setMessage(`Saved ${plural(roster.residents.length, "resident")} to a ${ext.toUpperCase()} file. It includes names, so keep it somewhere private.`);
  };

  const onFile = async (file: File | undefined) => {
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    setError(null);
    setMessage(null);
    try {
      if (file.size > MAX_BACKUP_BYTES) throw new BackupError("That file is too large to be a roster backup.");
      const data = parseBackupFile(file.name, await file.text());
      if (data.residents.length === 0) throw new BackupError("That file has no residents in it.");
      if (!hasResidents) apply(data, "replace");
      else setPending({ fileName: file.name, data });
    } catch (err) {
      setError(
        `Couldn't import ${file.name}. ${err instanceof BackupError ? err.message : "The file could not be read."} Your roster has not changed.`,
      );
    }
  };

  const apply = (data: ImportedRoster, mode: "replace" | "merge") => {
    try {
      if (mode === "replace") {
        // Family links follow the alias; drop links whose alias now belongs to someone else.
        for (const rid of aliasesChangedByReplace(roster, data)) familyLinks.forget(rid);
        update((r) => replaceRoster(r, data));
        setMessage(`Imported ${plural(data.residents.length, "resident")}${data.kind === "json" ? ", home details and the week" : ""}.`);
      } else {
        const result = mergeRoster(roster, data);
        update(() => result.roster);
        setMessage(`Merged: ${plural(result.updated, "resident")} updated, ${plural(result.added, "resident")} added.`);
      }
      setPending(null);
    } catch (err) {
      setPending(null);
      setError(`Couldn't import. ${err instanceof BackupError ? err.message : "Something went wrong."} Your roster has not changed.`);
    }
  };

  const titleId = `${id}-import-h`;
  return (
    <div className="roster-backup">
      <div className="form-actions" role="group" aria-label="Roster backup">
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => exportAs("json")} disabled={!hasResidents}>
          Export backup (JSON)
        </button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => exportAs("csv")} disabled={!hasResidents}>
          Export residents (CSV)
        </button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => fileRef.current?.click()} aria-describedby={`${id}-hint`}>
          Import from file…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,.csv,application/json,text/csv"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
      </div>
      <p className="hint" id={`${id}-hint`}>
        The roster is saved only in this browser. Export a backup before clearing it or switching devices. JSON keeps everything; CSV
        holds residents only and opens in a spreadsheet.
      </p>
      {error && (
        <div className="error-msg" role="alert">
          {error}
        </div>
      )}
      <p className="hint" role="status">
        {message ?? ""}
      </p>

      {pending && (
        <Modal labelledBy={titleId} onClose={() => setPending(null)}>
          <header className="modal-head">
            <div style={{ minWidth: 0 }}>
              <p className="eyebrow eyebrow-brand">Import roster</p>
              <h2 id={titleId}>Replace or merge?</h2>
            </div>
          </header>
          <div className="modal-body">
            <p style={{ margin: 0 }}>
              <strong>{pending.fileName}</strong> has {plural(pending.data.residents.length, "resident")}. Your roster has{" "}
              {plural(roster.residents.length, "resident")}.
            </p>
            <ul style={{ margin: 0, paddingLeft: "1.2rem" }}>
              <li>
                <strong>Replace</strong> swaps your roster for the file
                {pending.data.kind === "json" ? ", including home details and the week" : " (home details and the week stay)"}.
              </li>
              <li>
                <strong>Merge by name</strong> updates residents with the same name, adds new ones and keeps everyone else.
              </li>
            </ul>
          </div>
          <footer className="modal-foot">
            <button type="button" className="btn btn-quiet" onClick={() => setPending(null)} data-autofocus>
              Cancel
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => apply(pending.data, "merge")}>
              Merge by name
            </button>
            <button type="button" className="btn btn-primary" onClick={() => apply(pending.data, "replace")}>
              Replace roster
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
