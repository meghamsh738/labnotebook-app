import type { BaseEditor } from 'slate'
import type { ReactEditor } from 'slate-react'

declare module 'slate' {
  interface CustomTypes {
    Editor: BaseEditor & ReactEditor
    Element: { type: string; children: CustomText[]; [key: string]: unknown }
    Text: { text: string }
  }
}
