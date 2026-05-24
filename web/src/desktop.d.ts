export {}

declare global {
  interface Window {
    electronAPI?: {
      selectDirectory?: (options?: { title?: string; defaultPath?: string }) => Promise<string | null>
      getAppInfo?: () => Promise<{ name: string; version: string; platform: string }>
      getPairingLink?: () => Promise<{
        url: string
        candidates: string[]
        tailscaleConnected: boolean
        source: 'none' | 'tailscale' | 'lan'
      }>
      setZoomFactor?: (factor: number) => Promise<number | null>
      requestGoogleDriveAccessToken?: (options: { clientId: string; clientSecret?: string; scope: string }) => Promise<{
        accessToken: string
        expiresIn?: number
        scope?: string
        tokenType?: string
      }>
      ensureDirectories?: (paths: {
        dataRoot: string
        attachmentsRoot: string
        exportRoot: string
        syncRoot: string
      }) => Promise<{ ok: boolean; message?: string }>
    }
  }
}
