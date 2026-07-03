import { type ActivityRow } from "./api";

const LS_KEY = "benzo.history.local.v1";

export function listLocalHistory(): ActivityRow[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function saveLocalHistory(row: ActivityRow): void {
  const history = listLocalHistory().filter((r) => r.id !== row.id);
  history.unshift(row);
  localStorage.setItem(LS_KEY, JSON.stringify(history));
}

export function updateLocalHistoryStatus(id: string, status: ActivityRow["status"], txHash?: string): void {
  const history = listLocalHistory();
  const found = history.find((r) => r.id === id);
  if (found) {
    found.status = status;
    if (txHash) found.txHash = txHash;
    localStorage.setItem(LS_KEY, JSON.stringify(history));
  }
}

export function clearLocalHistory(): void {
  localStorage.removeItem(LS_KEY);
}
