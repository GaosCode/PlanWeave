import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { RemoteMessage, RemoteProfile, RemoteProjectSnapshot, RemoteTask } from "../../shared/remoteTypes.js";
import { remoteBridge } from "../bridge.js";

export function TeamModeShell({ onExit }: { onExit: () => void }) {
  const [profiles, setProfiles] = useState<RemoteProfile[]>([]);
  const [active, setActive] = useState<RemoteProfile | null>(null);
  const [snapshot, setSnapshot] = useState<RemoteProjectSnapshot | null>(null);
  const [messages, setMessages] = useState<RemoteMessage[]>([]);
  const [tasks, setTasks] = useState<RemoteTask[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void remoteBridge?.listRemoteProfiles().then(setProfiles); }, []);

  async function open(profile: RemoteProfile) {
    if (!remoteBridge || !profile.projectId) return;
    setError(null);
    try {
      await remoteBridge.connectProfile(profile.id, profile.projectId);
      const next = await remoteBridge.getRemoteProjectSnapshot(profile.id, profile.projectId);
      setActive(profile); setSnapshot(next);
      setTasks(await remoteBridge.getRemoteTasks(profile.id, profile.projectId));
      const room = next.planningRooms[0];
      if (room) setMessages(await remoteBridge.getRemoteMessages(profile.id, profile.projectId, room.id));
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }

  async function claim(task: RemoteTask) {
    if (!remoteBridge || !active?.projectId) return;
    setError(null);
    try {
      const safeUser = active.userId ?? "contributor";
      await remoteBridge.claimRemoteTask(active.id, active.projectId, task.taskId, `team/${safeUser}/${task.taskId}`, "HEAD");
      setTasks(await remoteBridge.getRemoteTasks(active.id, active.projectId));
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }

  async function send() {
    const room = snapshot?.planningRooms[0];
    if (!remoteBridge || !active?.projectId || !room || !draft.trim()) return;
    const message = await remoteBridge.sendRemoteMessage(active.id, active.projectId, room.id, draft.trim());
    setMessages((current) => [...current, message]); setDraft("");
  }

  return (
    <div className="flex h-screen bg-app-canvas text-text">
      <aside className="w-64 border-r border-border/80 bg-app-panel p-4">
        <div className="mb-6 flex items-center justify-between"><strong>Team Mode</strong><Button size="sm" variant="ghost" onClick={onExit}>Local</Button></div>
        <div className="space-y-2">{profiles.map((profile) => <Button className="w-full justify-start" key={profile.id} variant={active?.id === profile.id ? "secondary" : "ghost"} onClick={() => void open(profile)}>{profile.name}</Button>)}</div>
        {profiles.length === 0 ? <p className="text-sm text-muted-foreground">Add a Team profile in Settings first.</p> : null}
      </aside>
      <main className="min-w-0 flex-1 p-8">
        {error ? <div className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
        {!snapshot ? <div className="mx-auto mt-24 max-w-xl"><h1 className="text-3xl font-semibold">Choose a team project</h1><p className="mt-2 text-muted-foreground">Connect to the shared server to see members, decisions and discussion.</p></div> : (
          <div className="mx-auto flex h-full max-w-5xl flex-col gap-6">
            <header><div className="text-xs uppercase tracking-widest text-muted-foreground">Team workspace · Connected</div><h1 className="mt-1 text-3xl font-semibold">{snapshot.project.name}</h1><p className="mt-2 text-sm text-muted-foreground">{snapshot.members.length} members · {snapshot.proposals.length} proposals · event {snapshot.lastEventId}</p></header>
            <section className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_280px] gap-6">
              <div className="flex min-h-0 flex-col rounded-xl border border-border/80 bg-surface-raised">
                <div className="border-b border-border/80 px-5 py-4 font-medium"># {snapshot.planningRooms[0]?.name ?? "general"}</div>
                <div className="min-h-0 flex-1 space-y-4 overflow-auto p-5">{messages.map((message) => <div key={message.id}><div className="text-xs text-muted-foreground">{message.authorUserId}</div><div className="mt-1 text-sm">{message.body}</div></div>)}</div>
                <div className="flex gap-2 border-t border-border/80 p-4"><input className="h-9 flex-1 rounded-md border border-input bg-transparent px-3 text-sm" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Share an idea or update" onKeyDown={(event) => { if (event.key === "Enter") void send(); }} /><Button onClick={() => void send()}>Send</Button></div>
              </div>
              <aside className="space-y-5"><section><h2 className="mb-2 text-sm font-semibold">Tasks</h2>{tasks.map((task) => <div className="border-b border-border/60 py-2 text-sm" key={task.id}><div className="font-medium">{task.title}</div><div className="my-1 text-xs text-muted-foreground">{task.status} · {task.policy.ownershipScopes.join(", ")}</div>{task.status === "ready" ? <Button size="sm" variant="outline" onClick={() => void claim(task)}>Claim</Button> : null}</div>)}</section><section><h2 className="mb-2 text-sm font-semibold">Members</h2>{snapshot.members.map((member) => <div className="flex justify-between border-b border-border/60 py-2 text-sm" key={member.userId}><span>{member.displayName}</span><span className="text-muted-foreground">{member.role}</span></div>)}</section><section><h2 className="mb-2 text-sm font-semibold">Proposals</h2>{snapshot.proposals.map((proposal) => <div className="border-b border-border/60 py-2 text-sm" key={proposal.id}>{proposal.title}<div className="text-xs text-muted-foreground">{proposal.status}</div></div>)}</section></aside>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
