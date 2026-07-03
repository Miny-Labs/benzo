/**
 * Contacts (C6 - Wise/Cash recipient management). Local-first: merges the BFF's
 * recent contacts with device-saved ones, lets you add/nickname/remove, and pay
 * any of them in one tap. Saved contacts live in localStorage (lib/contacts).
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Trash2, Send as SendIcon } from "lucide-react";
import { useWallet } from "../lib/store";
import { listLocal, saveContact, removeContact, mergeContacts, isSaved, normAddress } from "../lib/contacts";
import { Screen, Stagger } from "../ui/motion";
import { ScreenHeader } from "../ui/chrome";
import { Avatar, Button, Card, Input } from "../ui/primitives";

export function Contacts() {
  const nav = useNavigate();
  const { contacts: bff } = useWallet();
  const [localVersion, bump] = useState(0);
  const merged = useMemo(() => mergeContacts(bff), [bff, localVersion]);
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const validAddress = normAddress(address);

  function add() {
    if (!validAddress) return;
    saveContact(address, name);
    setAddress(""); setName(""); setAdding(false);
    bump((n) => n + 1);
  }
  function remove(addr: string) {
    removeContact(addr);
    bump((n) => n + 1);
  }

  return (
    <Screen>
      <ScreenHeader title="Contacts" />
      <div className="px-5 pt-1">
        {!adding ? (
          <Button full variant="secondary" size="md" onClick={() => setAdding(true)} data-testid="contacts-add">
            <Plus size={17} /> Add a contact
          </Button>
        ) : (
          <Card className="space-y-3 p-4" data-testid="contacts-add-form">
            <Input label="Address or Receive Code" placeholder="G... or bzr_..." value={address} onChange={(e) => setAddress(e.target.value)} data-testid="contacts-handle" />
            {address && !validAddress ? (
              <div className="-mt-2 text-[12px] font-medium text-danger" data-testid="contacts-handle-error">
                Please enter a valid Stellar G-address or Benzo receive code.
              </div>
            ) : null}
            <Input label="Name (optional)" placeholder="Contact name" value={name} onChange={(e) => setName(e.target.value)} data-testid="contacts-name" />
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => setAdding(false)}>Cancel</Button>
              <Button size="sm" onClick={add} disabled={!validAddress} data-testid="contacts-save">Save</Button>
            </div>
          </Card>
        )}
      </div>

      {merged.length === 0 ? (
        <div className="px-8 py-20 text-center text-[14px] text-muted" data-testid="contacts-empty">
          No contacts yet. Add someone to pay them in one tap.
        </div>
      ) : (
        <Stagger className="space-y-3 px-5 pt-4" data-testid="contacts-list">
          {merged.map((c, i) => (
            <Stagger.Item index={i} key={c.handle}>
              <Card className="flex items-center gap-3 p-3.5" data-testid="contact-row">
                <Avatar name={c.name} size={42} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-semibold">{c.name}</div>
                  <div className="truncate text-[13px] text-muted">
                    {c.handle.startsWith("bzr_")
                      ? `${c.handle.slice(0, 10)}...${c.handle.slice(-8)}`
                      : c.handle.length > 24
                      ? `${c.handle.slice(0, 8)}...${c.handle.slice(-8)}`
                      : c.handle}
                  </div>
                </div>
                <button
                  onClick={() => nav(`/send?to=${encodeURIComponent(c.handle)}`)}
                  aria-label={`Pay ${c.name}`}
                  data-testid="contact-pay"
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-accent/10 text-accent transition outline-none active:scale-90 focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  <SendIcon size={16} />
                </button>
                {isSaved(c.handle) ? (
                  <button onClick={() => remove(c.handle)} aria-label={`Remove ${c.name}`} data-testid="contact-remove" className="flex h-9 w-9 items-center justify-center rounded-full text-muted transition hover:text-danger active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                    <Trash2 size={16} />
                  </button>
                ) : null}
              </Card>
            </Stagger.Item>
          ))}
        </Stagger>
      )}
    </Screen>
  );
}
