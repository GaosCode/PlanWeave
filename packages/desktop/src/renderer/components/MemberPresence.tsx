import type { RemoteMember } from "../../shared/remoteTypes.js"

type MemberPresenceProps = {
  members: RemoteMember[]
}

export function MemberPresence({ members }: MemberPresenceProps) {
  if (members.length === 0) {
    return null
  }

  return (
    <div className="flex items-center gap-1">
      {members.map((member) => (
        <div key={member.userId} className="flex items-center gap-1 rounded-full border border-input px-2 py-0.5 text-xs">
          <span
            className={`inline-block h-2 w-2 rounded-full ${member.online ? "bg-green-500" : "bg-muted-foreground"}`}
          />
          <span className="text-foreground">{member.displayName}</span>
          <span className="text-muted-foreground">({member.role})</span>
        </div>
      ))}
    </div>
  )
}
