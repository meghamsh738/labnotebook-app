import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.easylab.labnotebook',
  appName: 'Easylab Lab Notebook',
  webDir: '.labnote-dist/web',
  bundledWebRuntime: false,
  server: {
    androidScheme: 'https',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 0,
    },
    SystemBars: {
      insetsHandling: 'disable',
    },
  },
}

export default config
