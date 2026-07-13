import { useState } from "react"
import type { RemoteProfile } from "../../shared/remoteTypes.js"
import { remoteBridge } from "../bridge.js"

type RemoteProfilesSectionProps = {
  profiles: RemoteProfile[]
  onProfilesChange: (profiles: RemoteProfile[]) => void
}

export function RemoteProfilesSection({ profiles, onProfilesChange }: RemoteProfilesSectionProps) {
  const [name, setName] = useState("")
  const [serverUrl, setServerUrl] = useState("")
  const [deviceId, setDeviceId] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [projectId, setProjectId] = useState("")
  const [userId, setUserId] = useState("")
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    if (!remoteBridge) {
      setError("Remote bridge unavailable")
      return
    }
    setError(null)
    try {
      if (editingId) {
        const updated = await remoteBridge.updateRemoteProfile(editingId, { name, serverUrl, deviceId, ...(apiKey ? { apiKey } : {}) })
        onProfilesChange(profiles.map((p) => (p.id === editingId ? updated : p)))
      } else {
        const created = await remoteBridge.createRemoteProfile({ name, serverUrl, deviceId, apiKey, projectId, userId })
        onProfilesChange([...profiles, created])
      }
      resetForm()
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  async function handleDelete(id: string) {
    if (!remoteBridge) return
    setError(null)
    try {
      await remoteBridge.deleteRemoteProfile(id)
      onProfilesChange(profiles.filter((p) => p.id !== id))
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  function handleEdit(profile: RemoteProfile) {
    setEditingId(profile.id)
    setName(profile.name)
    setServerUrl(profile.serverUrl)
    setDeviceId(profile.deviceId)
    setApiKey("")
    setProjectId(profile.projectId ?? "")
    setUserId(profile.userId ?? "")
  }

  function resetForm() {
    setEditingId(null)
    setName("")
    setServerUrl("")
    setDeviceId("")
    setApiKey("")
    setProjectId("")
    setUserId("")
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-foreground">Remote Connection Profiles</h3>

      {error && <div className="text-xs text-destructive rounded-md bg-destructive/10 px-2 py-1">{error}</div>}

      <div className="flex flex-col gap-2">
        <input
          type="text"
          className="rounded-md border border-input bg-transparent px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground"
          placeholder="Project ID"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        />
        <input
          type="text"
          className="rounded-md border border-input bg-transparent px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground"
          placeholder="Your user name"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
        />
        <input
          type="text"
          className="rounded-md border border-input bg-transparent px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground"
          placeholder="Profile name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          type="text"
          className="rounded-md border border-input bg-transparent px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground"
          placeholder="Server URL (e.g. https://planweave.example.com)"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
        />
        <input
          type="text"
          className="rounded-md border border-input bg-transparent px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground"
          placeholder="Device name"
          value={deviceId}
          onChange={(e) => setDeviceId(e.target.value)}
        />
        <input
          type="password"
          className="rounded-md border border-input bg-transparent px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground"
          placeholder="Team join token"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          onClick={() => { void handleSave() }}
          disabled={!name || !serverUrl || !deviceId || (!editingId && (!apiKey || !projectId || !userId))}
        >
          {editingId ? "Update" : "Add Profile"}
        </button>
        {editingId && (
          <button
            type="button"
            className="rounded-md border border-input bg-transparent px-3 py-1 text-xs font-medium text-foreground hover:bg-accent"
            onClick={resetForm}
          >
            Cancel
          </button>
        )}
      </div>

      {profiles.length > 0 && (
        <div className="flex flex-col gap-1">
          {profiles.map((profile) => (
            <div key={profile.id} className="flex items-center justify-between rounded-md border border-input bg-muted/30 px-2 py-1">
              <div className="flex flex-col">
                <span className="text-xs font-medium text-foreground">{profile.name}</span>
                <span className="text-xs text-muted-foreground">{profile.serverUrl}</span>
              </div>
              <div className="flex gap-1">
                <button
                  type="button"
                  className="rounded px-2 py-0.5 text-xs text-foreground hover:bg-accent"
                  onClick={() => handleEdit(profile)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="rounded px-2 py-0.5 text-xs text-destructive hover:bg-destructive/10"
                  onClick={() => { void handleDelete(profile.id) }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
