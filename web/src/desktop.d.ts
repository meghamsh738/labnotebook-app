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
        account?: {
          provider: 'google'
          email: string
          name?: string
          picture?: string
          subject?: string
        }
      }>
      disconnectGoogleDrive?: (options?: { clientId?: string }) => Promise<{ ok: boolean; message?: string }>
      ensureDirectories?: (paths: {
        dataRoot: string
        attachmentsRoot: string
        exportRoot: string
        syncRoot: string
      }) => Promise<{ ok: boolean; message?: string }>
    }
    Capacitor?: {
      isNativePlatform?: () => boolean
      getPlatform?: () => string
      Plugins?: {
        GoogleDriveAuth?: {
          requestAccessToken: (options: { clientId: string; scope: string }) => Promise<{
            accessToken: string
            expiresIn?: number
            scope?: string
            tokenType?: string
            account?: {
              provider: 'google'
              email: string
              name?: string
              picture?: string
              subject?: string
            }
          }>
          disconnect?: (options?: { clientId?: string }) => Promise<{ ok: boolean; message?: string }>
        }
      }
    }
  }
}
