import { useEffect, useState } from "react";
import { ArrowRightIcon, CheckCircle2Icon, Link2Icon, LoaderCircleIcon, ServerIcon, ShieldCheckIcon, UserRoundIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RemoteMessage, RemoteProfile, RemoteProjectSnapshot, RemoteTask } from "../../shared/remoteTypes.js";
import { remoteBridge } from "../bridge.js";

type TeamRole = "host" | "member";

function RoleChoiceCard({ role, onSelect }: { role: TeamRole; onSelect: (role: TeamRole) => void }) {
  const host = role === "host";
  return (
    <button
      className="group relative animate-in fade-in slide-in-from-bottom-2 overflow-hidden rounded-2xl border border-border/80 bg-surface-raised p-5 text-left shadow-sm transition-[transform,box-shadow,border-color] duration-[var(--motion-duration-panel)] ease-[var(--motion-ease-emphasized)] hover:-translate-y-1 hover:border-violet-400/70 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      style={{ animationDelay: host ? "0ms" : "80ms" }}
      type="button"
      onClick={() => onSelect(role)}
    >
      <div className={`absolute inset-x-0 top-0 h-1 origin-left scale-x-0 bg-gradient-to-r ${host ? "from-violet-500 to-indigo-400" : "from-sky-500 to-cyan-400"} transition-transform duration-[var(--motion-duration-panel)] group-hover:scale-x-100`} />
      <div className={`flex size-11 items-center justify-center rounded-xl ${host ? "bg-violet-500/12 text-violet-600 dark:text-violet-300" : "bg-sky-500/12 text-sky-600 dark:text-sky-300"} transition-transform duration-[var(--motion-duration-panel)] group-hover:scale-110`}>
        {host ? <ServerIcon className="size-5" /> : <UserRoundIcon className="size-5" />}
      </div>
      <div className="mt-5 flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-medium uppercase tracking-[0.12em] text-text-muted">{host ? "创建共享空间" : "加入已有空间"}</div>
          <h2 className="mt-1 text-lg font-semibold text-text-strong">{host ? "作为主机启动" : "作为成员加入"}</h2>
        </div>
        <ArrowRightIcon className="mt-1 size-4 text-text-faint transition-transform duration-[var(--motion-duration-panel)] group-hover:translate-x-1 group-hover:text-text" />
      </div>
      <p className="mt-3 min-h-12 text-sm leading-6 text-text-muted">
        {host ? "在本机创建团队服务，集中管理项目并生成可分享的连接地址。" : "使用主机提供的服务地址和加入令牌，连接到现有团队项目。"}
      </p>
      <div className="mt-4 space-y-2 text-xs text-text-muted">
        <div className="flex items-center gap-2"><CheckCircle2Icon className="size-3.5 text-state-success" />{host ? "启动后即可邀请成员" : "不会在本机创建团队服务"}</div>
        <div className="flex items-center gap-2"><ShieldCheckIcon className="size-3.5 text-state-success" />使用加入令牌保护连接</div>
      </div>
    </button>
  );
}

export function TeamModeShell({ embedded = false, onConnectionRoleChange, onExit }: { embedded?: boolean; onConnectionRoleChange?: (role: "server" | "member") => void; onExit: () => void }) {
  const [profiles, setProfiles] = useState<RemoteProfile[]>([]);
  const [active, setActive] = useState<RemoteProfile | null>(null);
  const [snapshot, setSnapshot] = useState<RemoteProjectSnapshot | null>(null);
  const [messages, setMessages] = useState<RemoteMessage[]>([]);
  const [tasks, setTasks] = useState<RemoteTask[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [roleChoice, setRoleChoice] = useState<"choose" | "host" | "member">("choose");
  const [projectId, setProjectId] = useState("team-project");
  const [projectName, setProjectName] = useState("My Team Project");
  const [userId, setUserId] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [joinToken, setJoinToken] = useState("planweave-local-team");
  const [serverUrl, setServerUrl] = useState("");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [connectingRole, setConnectingRole] = useState<TeamRole | null>(null);

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

  async function hostTeam() {
    if (!remoteBridge) return;
    setError(null);
    setConnectingRole("host");
    try {
      const host = await remoteBridge.startLocalTeamHost({ projectId, projectName, userId, deviceId, joinToken });
      setProfiles((current) => [...current.filter((profile) => profile.id !== host.profile.id), host.profile]);
      setInviteUrl(host.inviteUrl);
      onConnectionRoleChange?.("server");
      await open(host.profile);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setConnectingRole(null); }
  }

  async function joinTeam() {
    if (!remoteBridge) return;
    setError(null);
    setConnectingRole("member");
    try {
      const profile = await remoteBridge.createRemoteProfile({ name: `${projectName} (member)`, serverUrl, deviceId, apiKey: joinToken, projectId, userId });
      setProfiles((current) => [...current, profile]);
      onConnectionRoleChange?.("member");
      await open(profile);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setConnectingRole(null); }
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
    <div className={`flex min-h-0 min-w-0 flex-1 bg-app-canvas text-text ${embedded ? "h-full" : "h-screen"}`}>
      {!embedded ? <aside className="w-64 border-r border-border/80 bg-app-panel p-4">
        <div className="mb-6 flex items-center justify-between"><strong>Team Mode</strong><Button size="sm" variant="ghost" onClick={onExit}>Local</Button></div>
        <Button className="mb-3 w-full" onClick={() => setRoleChoice("choose")}>New team connection</Button>
        <div className="space-y-2">{profiles.map((profile) => <Button className="w-full justify-start" key={profile.id} variant={active?.id === profile.id ? "secondary" : "ghost"} onClick={() => void open(profile)}>{profile.name}</Button>)}</div>
      </aside> : null}
      <main className="min-w-0 flex-1 overflow-auto p-8">
        {embedded ? <header className="view-enter mb-8 border-b border-border/80 pb-4"><div className="text-xs font-medium uppercase tracking-[0.12em] text-violet-600 dark:text-violet-300">团队模式</div><h1 className="mt-1 text-xl font-semibold">团队配置</h1></header> : null}
        {embedded && profiles.length > 0 ? <div className="mb-6 flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => setRoleChoice("choose")}>新建团队连接</Button>{profiles.map((profile) => <Button size="sm" key={profile.id} variant={active?.id === profile.id ? "secondary" : "ghost"} onClick={() => void open(profile)}>{profile.name}</Button>)}</div> : null}
        {error ? <div className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
        {!snapshot ? <div className="view-enter mx-auto mt-16 w-full max-w-3xl">{roleChoice === "choose" ? (
          <div className="animate-in fade-in slide-in-from-bottom-3 duration-[var(--motion-duration-panel)]">
            <div className="max-w-2xl">
              <div className="text-xs font-medium uppercase tracking-[0.14em] text-violet-600 dark:text-violet-300">连接团队工作区</div>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-text-strong">选择这台设备的团队角色</h1>
              <p className="mt-3 text-sm leading-6 text-text-muted">主机负责创建共享服务并邀请成员；成员连接到已有服务共同协作。两种方式都可以随时返回重新选择。</p>
            </div>
            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              <RoleChoiceCard role="host" onSelect={(role) => setRoleChoice(role)} />
              <RoleChoiceCard role="member" onSelect={(role) => setRoleChoice(role)} />
            </div>
            <div className="mt-5 flex items-center gap-2 text-xs text-text-muted"><ShieldCheckIcon className="size-4 text-state-success" />连接信息仅用于当前团队服务的身份验证。</div>
          </div>
        ) : (
          <div className="animate-in fade-in slide-in-from-right-3 duration-[var(--motion-duration-panel)] rounded-2xl border border-border/80 bg-surface-raised p-6 shadow-sm sm:p-8">
            <button className="text-sm text-text-muted transition-colors hover:text-text-strong" type="button" onClick={() => setRoleChoice("choose")}>← 返回角色选择</button>
            <div className="mt-6 flex items-start gap-4">
              <div className={`flex size-12 shrink-0 items-center justify-center rounded-xl ${roleChoice === "host" ? "bg-violet-500/12 text-violet-600 dark:text-violet-300" : "bg-sky-500/12 text-sky-600 dark:text-sky-300"}`}>
                {roleChoice === "host" ? <ServerIcon className="size-6" /> : <UserRoundIcon className="size-6" />}
              </div>
              <div>
                <div className="text-xs font-medium uppercase tracking-[0.12em] text-text-muted">{roleChoice === "host" ? "创建共享空间" : "加入已有空间"}</div>
                <h1 className="mt-1 text-2xl font-semibold text-text-strong">{roleChoice === "host" ? "作为主机启动" : "作为成员加入"}</h1>
              </div>
            </div>
            <div className="mt-6 rounded-xl border border-border/70 bg-surface-muted/60 p-4 text-sm leading-6 text-text-muted">
              {roleChoice === "host" ? <><p>主机服务会在这台设备上启动，负责保存团队连接并同步项目状态。</p><div className="mt-3 grid gap-2 sm:grid-cols-3"><span>1. 填写项目资料</span><span>2. 启动本地服务</span><span>3. 分享地址和令牌</span></div></> : <><p>请先向团队主机获取服务地址和加入令牌，再填写下方信息完成连接。</p><div className="mt-3 flex items-center gap-2"><Link2Icon className="size-4 text-sky-500" />连接成功后即可查看任务、成员和讨论。</div></>}
            </div>
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5 text-sm font-medium text-text"><span>项目 ID</span><input className="h-10 rounded-lg border border-input bg-transparent px-3 font-normal outline-none transition-colors focus:border-ring focus:ring-2 focus:ring-ring/20" value={projectId} onChange={(event) => setProjectId(event.target.value)} placeholder="例如 team-project" /></label>
              <label className="grid gap-1.5 text-sm font-medium text-text"><span>项目名称</span><input className="h-10 rounded-lg border border-input bg-transparent px-3 font-normal outline-none transition-colors focus:border-ring focus:ring-2 focus:ring-ring/20" value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="例如 产品协作空间" /></label>
              <label className="grid gap-1.5 text-sm font-medium text-text"><span>你的名称</span><input className="h-10 rounded-lg border border-input bg-transparent px-3 font-normal outline-none transition-colors focus:border-ring focus:ring-2 focus:ring-ring/20" value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="团队中显示的名称" /></label>
              <label className="grid gap-1.5 text-sm font-medium text-text"><span>设备 ID</span><input className="h-10 rounded-lg border border-input bg-transparent px-3 font-normal outline-none transition-colors focus:border-ring focus:ring-2 focus:ring-ring/20" value={deviceId} onChange={(event) => setDeviceId(event.target.value)} placeholder="当前设备标识" /></label>
              {roleChoice === "member" ? <label className="grid gap-1.5 text-sm font-medium text-text sm:col-span-2"><span>主机服务地址</span><input className="h-10 rounded-lg border border-input bg-transparent px-3 font-normal outline-none transition-colors focus:border-ring focus:ring-2 focus:ring-ring/20" value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="例如 http://192.168.1.10:8788" /></label> : null}
              {roleChoice !== "member" ? <label className="grid gap-1.5 text-sm font-medium text-text sm:col-span-2"><span>团队加入令牌</span><input className="h-10 rounded-lg border border-input bg-transparent px-3 font-normal outline-none transition-colors focus:border-ring focus:ring-2 focus:ring-ring/20" type="text" value={joinToken} onChange={(event) => setJoinToken(event.target.value)} placeholder="由主机生成并分享给成员" /></label> : null}
            </div>
            <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-text-muted">{roleChoice === "host" ? "启动后会自动生成可分享的服务地址。" : "服务地址和令牌只会用于连接此团队。"}</p>
              <Button disabled={connectingRole !== null || !projectId || !userId || !deviceId || (roleChoice === "host" && !joinToken) || (roleChoice === "member" && !serverUrl)} onClick={() => void (roleChoice === "host" ? hostTeam() : joinTeam())}>
                {connectingRole === roleChoice ? <LoaderCircleIcon className="size-4 animate-spin" /> : null}
                {connectingRole === roleChoice ? (roleChoice === "host" ? "正在启动…" : "正在连接…") : roleChoice === "host" ? "启动团队服务" : "加入团队"}
              </Button>
            </div>
            {inviteUrl ? <div className="mt-5 rounded-xl border border-state-success/30 bg-state-success-surface p-4 text-sm text-text"><div className="font-medium">团队服务已启动</div><div className="mt-1 text-text-muted">将此地址分享给成员：</div><code className="mt-2 block break-all text-xs">{inviteUrl}</code></div> : null}
          </div>
        )}</div> : (
          <div className="mx-auto flex h-full max-w-5xl flex-col gap-6">
            <header><div className="text-xs uppercase tracking-widest text-muted-foreground">Team workspace · Connected</div><h1 className="mt-1 text-3xl font-semibold">{snapshot.project.name}</h1><p className="mt-2 text-sm text-muted-foreground">{snapshot.members.length} members · {snapshot.proposals.length} proposals · event {snapshot.lastEventId}</p>{inviteUrl ? <div className="mt-3 rounded-md bg-muted px-3 py-2 text-sm">Invite address: <code>{inviteUrl}</code></div> : null}</header>
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
